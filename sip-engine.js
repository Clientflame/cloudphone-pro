/**
 * CloudPhone Pro — SIP Engine v3
 * Production-grade SIP UA using the 'sip' npm package
 * 
 * Critical fixes for FreePBX compatibility:
 * 1. DO NOT pass realm in creds — let digest module extract it from the 401 challenge
 *    (FreePBX uses realm="asterisk", not the server hostname)
 * 2. Include port in REGISTER URI when port != 5060
 * 3. Use ephemeral port (49152-65535) to avoid conflicts
 * 4. Don't set publicAddress — let the transport auto-detect
 * 5. Wrap digest.signRequest in try/catch for robustness
 */

const sip = require('sip');
const digest = require('sip/digest');
const os = require('os');
const EventEmitter = require('events');
const { RtpManager } = require('./rtp-engine');

class SipEngine extends EventEmitter {
  constructor(config) {
    super();
    this.config = {
      server: config.server,
      port: parseInt(config.port) || 5060,
      transport: (config.transport || 'UDP').toUpperCase(),
      username: config.username,
      password: config.password,
      displayName: config.displayName || config.username
    };

    this.registered = false;
    this.registerTimer = null;
    this.registerCallId = this._generateCallId();
    this.registerTag = this._generateTag();
    this.cseq = 1;
    this.calls = new Map();
    this.sipStarted = false;

    // Digest auth context — persisted across re-registrations
    this.digestContext = null;

    // Keep-alive timer — sends OPTIONS every 30s to prevent NAT timeouts
    this.keepAliveTimer = null;
    this.KEEPALIVE_INTERVAL_MS = 30000;

    // Local network info
    this.localIP = this._getLocalIP();
    this.localPort = 0;

    // RTP manager
    this.rtpManager = new RtpManager();
    // Audio batching: accumulate ~100ms of audio (5 x 20ms packets = 800 samples)
    // before sending to renderer, reducing IPC calls from 50/sec to ~10/sec
    this._audioBatch = {}; // callId -> { samples: [], timer: null }
    const BATCH_INTERVAL_MS = 100; // Send batched audio every 100ms

    this.rtpManager.on('audio', (data) => {
      const pcm = data.pcmData;
      if (!pcm || typeof pcm[Symbol.iterator] !== 'function') return;

      const callId = data.callId;
      if (!this._audioBatch[callId]) {
        this._audioBatch[callId] = { samples: [], timer: null };
      }
      const batch = this._audioBatch[callId];

      // Accumulate samples
      for (let i = 0; i < pcm.length; i++) {
        batch.samples.push(pcm[i]);
      }

      // Set up flush timer if not already running
      if (!batch.timer) {
        batch.timer = setTimeout(() => {
          if (batch.samples.length > 0) {
            this.emit('rtpAudio', { callId, pcmData: batch.samples });
            batch.samples = [];
          }
          batch.timer = null;
        }, BATCH_INTERVAL_MS);
      }
    });
  }

  _getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  _generateCallId() {
    const hex = () => Math.random().toString(16).substring(2, 10);
    return `${hex()}${hex()}@cloudphone`;
  }

  _generateTag() {
    return Math.random().toString(36).substring(2, 14);
  }

  _generateBranch() {
    return 'z9hG4bK' + Math.random().toString(36).substring(2, 14);
  }

  // Build the server URI with port only if non-standard
  _getServerUri() {
    if (this.config.port && this.config.port !== 5060) {
      return `sip:${this.config.server}:${this.config.port}`;
    }
    return `sip:${this.config.server}`;
  }

  // Build the AOR (Address of Record)
  _getAOR() {
    return `sip:${this.config.username}@${this.config.server}`;
  }

  // Build the Contact URI
  _getContactUri() {
    return `sip:${this.config.username}@${this.localIP}:${this.localPort};transport=${this.config.transport.toLowerCase()}`;
  }

  // Credentials for digest auth — NO realm, let the challenge provide it
  _getCreds() {
    return {
      user: this.config.username,
      password: this.config.password
      // DO NOT set realm here — the digest module extracts it from the 401/407 challenge
      // FreePBX typically uses realm="asterisk", not the server hostname
    };
  }

  // ========== Safe SIP Send Wrapper ==========
  // Wraps sip.send() to catch ERR_SOCKET_DGRAM_NOT_RUNNING and other socket errors
  // that would otherwise crash the main process with an uncaught exception
  _safeSend(message, callback) {
    if (!this.sipStarted) {
      console.warn('[SIP] Cannot send - SIP stack not started');
      if (callback) callback({ status: 503, reason: 'SIP stack not running' });
      return;
    }
    try {
      sip.send(message, (response) => {
        try {
          if (callback) callback(response);
        } catch (cbErr) {
          console.error('[SIP] Callback error:', cbErr.message);
        }
      });
    } catch (err) {
      console.error('[SIP] Send failed:', err.message);
      if (err.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' || err.message.includes('Not running')) {
        console.error('[SIP] UDP socket is dead - marking as unregistered');
        this.sipStarted = false;
        this.registered = false;
        this.emit('unregistered');
        this.emit('sipError', { error: 'UDP socket closed unexpectedly. Please re-register.' });
      }
      if (callback) {
        try { callback({ status: 503, reason: 'Transport error: ' + err.message }); } catch (e) {}
      }
    }
  }

  // Fire-and-forget version (for ACK, responses, etc.)
  _safeSendNoCallback(message) {
    if (!this.sipStarted) return;
    try {
      sip.send(message);
    } catch (err) {
      console.error('[SIP] Send (no-cb) failed:', err.message);
      if (err.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' || err.message.includes('Not running')) {
        this.sipStarted = false;
        this.registered = false;
        this.emit('unregistered');
        this.emit('sipError', { error: 'UDP socket closed unexpectedly. Please re-register.' });
      }
    }
  }

  // ========== SIP Stack Initialization ==========

  async register() {
    // Use ephemeral port range to avoid conflicts
    this.localPort = 49152 + Math.floor(Math.random() * 16000);

    console.log(`[SIP] Starting on ${this.localIP}:${this.localPort}`);
    console.log(`[SIP] Target: ${this.config.username}@${this.config.server}:${this.config.port} (${this.config.transport})`);

    return new Promise((resolve, reject) => {
      try {
        // Stop any previous SIP stack
        if (this.sipStarted) {
          try { sip.stop(); } catch (e) {}
          this.sipStarted = false;
        }

        sip.start({
          port: this.localPort,
          address: '0.0.0.0',
          // Do NOT set publicAddress — let the transport layer auto-detect
          // Setting it can cause issues when behind NAT
          udp: true,
          tcp: this.config.transport === 'TCP',
          logger: {
            send: (msg, target) => {
              let logLine;
              if (msg.method) {
                logLine = `TX ${msg.method} -> ${target?.address || '?'}:${target?.port || '?'} (${target?.protocol || '?'})`;
                if (msg.headers?.authorization) {
                  logLine += ' [Auth]';
                }
                if (msg.headers?.['content-type'] === 'application/sdp') {
                  logLine += ' [SDP]';
                }
              } else {
                logLine = `TX ${msg.status} ${msg.reason}`;
              }
              console.log(`[SIP-${logLine.substring(0,2)}] ${logLine.substring(3)}`);
              this.emit('sipDebug', { direction: 'TX', line: logLine, timestamp: Date.now() });
            },
            recv: (msg, remote) => {
              let logLine;
              if (msg.method) {
                logLine = `RX ${msg.method} <- ${remote?.address || '?'}:${remote?.port || '?'}`;
              } else {
                logLine = `RX ${msg.status} ${msg.reason}`;
                if (msg.status === 401 && msg.headers?.['www-authenticate']) {
                  logLine += ` [WWW-Auth: ${JSON.stringify(msg.headers['www-authenticate']).substring(0, 100)}]`;
                }
                if (msg.status === 407 && msg.headers?.['proxy-authenticate']) {
                  logLine += ` [Proxy-Auth]`;
                }
              }
              console.log(`[SIP-${logLine.substring(0,2)}] ${logLine.substring(3)}`);
              this.emit('sipDebug', { direction: 'RX', line: logLine, timestamp: Date.now() });
            }
          }
        }, (rq) => {
          this._handleIncomingRequest(rq);
        });

        this.sipStarted = true;
        console.log('[SIP] Stack started successfully');

        // Send REGISTER
        this._sendRegister((success, error) => {
          if (success) {
            resolve();
          } else {
            reject(new Error(error || 'Registration failed'));
          }
        });
      } catch (err) {
        console.error('[SIP] Failed to start:', err);
        reject(err);
      }
    });
  }

  // ========== REGISTER ==========

  _sendRegister(callback) {
    const serverUri = this._getServerUri();
    const aor = this._getAOR();
    const contactUri = this._getContactUri();

    const request = {
      method: 'REGISTER',
      uri: serverUri,
      headers: {
        to: { uri: aor },
        from: { uri: aor, params: { tag: this.registerTag } },
        'call-id': this.registerCallId,
        cseq: { method: 'REGISTER', seq: this.cseq++ },
        contact: [{ uri: contactUri, params: { expires: '120' } }],
        via: [],
        expires: 120,
        'max-forwards': 70,
        'user-agent': 'CloudPhonePro/2.2',
        allow: 'INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, MESSAGE, OPTIONS, INFO, SUBSCRIBE',
        supported: 'path, outbound'
      }
    };

    console.log(`[SIP] Sending REGISTER to ${serverUri}`);

    try {
      this._safeSend(request, (rs) => {
        this._handleRegisterResponse(rs, callback);
      });
    } catch (err) {
      console.error('[SIP] Error sending REGISTER:', err);
      if (callback) callback(false, err.message);
    }
  }

  _handleRegisterResponse(rs, callback) {
    console.log(`[SIP] REGISTER response: ${rs.status} ${rs.reason}`);

    if (rs.status === 200) {
      this._onRegistered(callback);
    } else if (rs.status === 401 || rs.status === 407) {
      console.log('[SIP] Auth challenge received, authenticating...');
      this._sendAuthenticatedRegister(rs, callback);
    } else if (rs.status >= 300) {
      this.registered = false;
      const reason = `${rs.status} ${rs.reason}`;
      console.error(`[SIP] Registration failed: ${reason}`);
      this.emit('registrationFailed', { status: rs.status, reason });
      if (callback) callback(false, reason);
    }
    // Ignore 1xx provisional responses
  }

  _sendAuthenticatedRegister(challengeResponse, callback) {
    const serverUri = this._getServerUri();
    const aor = this._getAOR();
    const contactUri = this._getContactUri();
    const creds = this._getCreds();

    const authRequest = {
      method: 'REGISTER',
      uri: serverUri,
      headers: {
        to: { uri: aor },
        from: { uri: aor, params: { tag: this.registerTag } },
        'call-id': this.registerCallId,
        cseq: { method: 'REGISTER', seq: this.cseq++ },
        contact: [{ uri: contactUri, params: { expires: '120' } }],
        via: [],
        expires: 120,
        'max-forwards': 70,
        'user-agent': 'CloudPhonePro/2.2',
        allow: 'INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, MESSAGE, OPTIONS, INFO, SUBSCRIBE',
        supported: 'path, outbound'
      }
    };

    try {
      // Sign the request using the sip package's digest module
      // This extracts realm, nonce, qop from the challenge and computes the response hash
      this.digestContext = digest.signRequest(
        this.digestContext || {},
        authRequest,
        challengeResponse,
        creds
      ) || {};

      console.log('[SIP] Sending authenticated REGISTER');

      this._safeSend(authRequest, (rs2) => {
        console.log(`[SIP] Auth REGISTER response: ${rs2.status} ${rs2.reason}`);

        if (rs2.status === 200) {
          this._onRegistered(callback);
        } else if (rs2.status === 401 || rs2.status === 407) {
          // Double challenge — credentials are wrong
          this.registered = false;
          const reason = 'Authentication failed - check username/password';
          console.error(`[SIP] ${reason}`);
          this.emit('registrationFailed', { status: rs2.status, reason });
          if (callback) callback(false, reason);
        } else {
          this.registered = false;
          const reason = `${rs2.status} ${rs2.reason}`;
          console.error(`[SIP] Registration failed after auth: ${reason}`);
          this.emit('registrationFailed', { status: rs2.status, reason });
          if (callback) callback(false, reason);
        }
      });
    } catch (err) {
      console.error('[SIP] Digest auth error:', err);
      this.registered = false;
      this.emit('registrationFailed', { status: 0, reason: 'Digest auth error: ' + err.message });
      if (callback) callback(false, 'Digest auth error: ' + err.message);
    }
  }

  _onRegistered(callback) {
    this.registered = true;
    this.emit('registered', { server: this.config.server });
    console.log('[SIP] Registration successful!');

    // Set up re-registration timer
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.registerTimer = setInterval(() => {
      this._reRegister();
    }, 90 * 1000);

    // Start keep-alive OPTIONS pings to prevent NAT timeouts
    this._startKeepAlive();

    if (callback) callback(true);
  }

  // ========== Keep-Alive (OPTIONS Ping) ==========
  // Sends SIP OPTIONS to the server every 30 seconds to keep the NAT binding alive.
  // Without this, firewalls/NATs may close the UDP mapping after 30-60s of inactivity,
  // causing ERR_SOCKET_DGRAM_NOT_RUNNING when the server tries to send packets back.

  _startKeepAlive() {
    this._stopKeepAlive();
    console.log(`[SIP] Starting keep-alive OPTIONS pings every ${this.KEEPALIVE_INTERVAL_MS / 1000}s`);
    this.keepAliveTimer = setInterval(() => {
      this._sendKeepAlive();
    }, this.KEEPALIVE_INTERVAL_MS);
  }

  _stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  _sendKeepAlive() {
    if (!this.sipStarted || !this.registered) {
      this._stopKeepAlive();
      return;
    }

    const serverUri = this._getServerUri();
    const aor = this._getAOR();

    const optionsRequest = {
      method: 'OPTIONS',
      uri: serverUri,
      headers: {
        to: { uri: serverUri },
        from: { uri: aor, params: { tag: this._generateTag() } },
        'call-id': this._generateCallId(),
        cseq: { method: 'OPTIONS', seq: 1 },
        via: [],
        'max-forwards': 70,
        'user-agent': 'CloudPhonePro/2.5',
        accept: 'application/sdp'
      }
    };

    this._safeSend(optionsRequest, (rs) => {
      if (rs.status === 200 || rs.status === 405) {
        // 200 OK or 405 Method Not Allowed are both valid — server is alive
        // (some servers don't support OPTIONS but still respond)
      } else if (rs.status === 503) {
        // Transport error from _safeSend — socket is dead
        console.warn('[SIP] Keep-alive failed: transport error, stopping pings');
        this._stopKeepAlive();
      } else {
        console.warn(`[SIP] Keep-alive OPTIONS got ${rs.status} ${rs.reason}`);
      }
    });
  }

  _reRegister() {
    console.log('[SIP] Re-registering...');
    this._sendRegister((success, error) => {
      if (!success) {
        console.error('[SIP] Re-registration failed:', error);
        this.registered = false;
        this.emit('unregistered');
      }
    });
  }

  async unregister() {
    this._stopKeepAlive();
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }

    if (!this.registered && !this.sipStarted) return;

    return new Promise((resolve) => {
      const serverUri = this._getServerUri();
      const aor = this._getAOR();
      const contactUri = this._getContactUri();

      const request = {
        method: 'REGISTER',
        uri: serverUri,
        headers: {
          to: { uri: aor },
          from: { uri: aor, params: { tag: this.registerTag } },
          'call-id': this.registerCallId,
          cseq: { method: 'REGISTER', seq: this.cseq++ },
          contact: [{ uri: contactUri }],
          via: [],
          expires: 0,
          'max-forwards': 70,
          'user-agent': 'CloudPhonePro/2.2'
        }
      };

      // Sign with existing digest context if available
      if (this.digestContext && this.digestContext.nonce) {
        try {
          digest.signRequest(this.digestContext, request, null, this._getCreds());
        } catch (e) {
          console.warn('[SIP] Could not sign unregister:', e.message);
        }
      }

      try {
        this._safeSend(request, (rs) => {
          console.log(`[SIP] UNREGISTER response: ${rs.status}`);
          this.registered = false;
          this.emit('unregistered');
          resolve();
        });
      } catch (e) {
        console.warn('[SIP] Error sending unregister:', e.message);
      }

      // Timeout fallback
      setTimeout(() => {
        this.registered = false;
        this.emit('unregistered');
        resolve();
      }, 5000);
    });
  }

  // ========== SDP Generation & Parsing ==========

  _generateSDP(rtpPort) {
    return [
      'v=0',
      `o=${this.config.username} ${Date.now()} ${Date.now()} IN IP4 ${this.localIP}`,
      's=CloudPhonePro',
      `c=IN IP4 ${this.localIP}`,
      't=0 0',
      `m=audio ${rtpPort} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=ptime:20',
      'a=sendrecv'
    ].join('\r\n') + '\r\n';
  }

  _parseSDP(sdpContent) {
    if (!sdpContent) return null;
    const lines = sdpContent.split(/\r?\n/);
    let host = null;
    let port = null;
    let codec = 'PCMU';

    for (const line of lines) {
      if (line.startsWith('c=IN IP4 ')) {
        host = line.substring(9).trim();
      }
      if (line.startsWith('m=audio ')) {
        const parts = line.split(' ');
        port = parseInt(parts[1]);
        const payloads = parts.slice(3);
        if (payloads.includes('8')) codec = 'PCMA';
        if (payloads.includes('0')) codec = 'PCMU';
      }
    }

    return host && port ? { host, port, codec } : null;
  }

  // ========== Outgoing Calls ==========

  async makeCall(target) {
    if (!this.registered) throw new Error('Not registered');

    const callId = this._generateCallId();
    const fromTag = this._generateTag();

    let targetUri = target;
    if (!target.startsWith('sip:')) {
      targetUri = `sip:${target}@${this.config.server}`;
      if (this.config.port && this.config.port !== 5060) {
        targetUri = `sip:${target}@${this.config.server}:${this.config.port}`;
      }
    }

    // Create RTP session before INVITE
    const rtpPort = await this.rtpManager.createSession(callId, { codec: 'PCMU' });
    console.log(`[SIP] RTP for outgoing call ${callId} on port ${rtpPort}`);

    const contactUri = this._getContactUri();

    const request = {
      method: 'INVITE',
      uri: targetUri,
      headers: {
        to: { uri: targetUri },
        from: {
          uri: this._getAOR(),
          name: this.config.displayName,
          params: { tag: fromTag }
        },
        'call-id': callId,
        cseq: { method: 'INVITE', seq: this.cseq++ },
        contact: [{ uri: contactUri }],
        via: [],
        'max-forwards': 70,
        'user-agent': 'CloudPhonePro/2.2',
        allow: 'INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, MESSAGE, OPTIONS, INFO, SUBSCRIBE',
        'content-type': 'application/sdp'
      },
      content: this._generateSDP(rtpPort)
    };

    this.calls.set(callId, {
      id: callId,
      direction: 'outgoing',
      target,
      state: 'trying',
      fromTag,
      toTag: null,
      request,
      targetUri,
      rtpPort,
      inviteDigestCtx: null
    });

    return new Promise((resolve, reject) => {
      this._safeSend(request, (rs) => {
        console.log(`[SIP] INVITE response: ${rs.status} ${rs.reason}`);
        const call = this.calls.get(callId);
        if (!call) return;

        if (rs.status === 401 || rs.status === 407) {
          // ACK the challenge
          try {
            const ack = {
              method: 'ACK',
              uri: targetUri,
              headers: {
                to: rs.headers.to,
                from: rs.headers.from,
                'call-id': callId,
                cseq: { method: 'ACK', seq: rs.headers.cseq.seq },
                via: [],
                'max-forwards': 70
              }
            };
            this._safeSendNoCallback(ack);
          } catch (e) {}

          // Resend with auth
          const authRequest = {
            method: 'INVITE',
            uri: targetUri,
            headers: {
              to: { uri: targetUri },
              from: {
                uri: this._getAOR(),
                name: this.config.displayName,
                params: { tag: fromTag }
              },
              'call-id': callId,
              cseq: { method: 'INVITE', seq: this.cseq++ },
              contact: [{ uri: contactUri }],
              via: [],
              'max-forwards': 70,
              'user-agent': 'CloudPhonePro/2.2',
              allow: 'INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, MESSAGE, OPTIONS, INFO, SUBSCRIBE',
              'content-type': 'application/sdp'
            },
            content: this._generateSDP(rtpPort)
          };

          try {
            call.inviteDigestCtx = digest.signRequest(
              call.inviteDigestCtx || {},
              authRequest,
              rs,
              this._getCreds()
            ) || {};

            this._safeSend(authRequest, (rs2) => {
              this._handleInviteResponse(callId, rs2, resolve, reject);
            });
          } catch (err) {
            console.error('[SIP] INVITE auth error:', err);
            this.rtpManager.removeSession(callId);
            this.calls.delete(callId);
            reject(new Error('INVITE auth failed: ' + err.message));
          }
        } else {
          this._handleInviteResponse(callId, rs, resolve, reject);
        }
      });
    });
  }

  _handleInviteResponse(callId, rs, resolve, reject) {
    const call = this.calls.get(callId);
    if (!call) return;

    if (rs.status >= 100 && rs.status < 200) {
      call.state = rs.status === 180 ? 'ringing' : 'trying';
      if (rs.headers.to?.params?.tag) {
        call.toTag = rs.headers.to.params.tag;
      }
      this.emit('callRinging', { callId, target: call.target });
    } else if (rs.status === 200) {
      call.state = 'established';
      if (rs.headers.to?.params?.tag) {
        call.toTag = rs.headers.to.params.tag;
      }

      const remoteSDP = this._parseSDP(rs.content);
      if (remoteSDP) {
        console.log(`[SIP] Remote RTP: ${remoteSDP.host}:${remoteSDP.port} (${remoteSDP.codec})`);
        this.rtpManager.setRemote(callId, remoteSDP.host, remoteSDP.port);
        this.rtpManager.startSending(callId);
      }

      // Send ACK
      try {
        const ack = {
          method: 'ACK',
          uri: call.targetUri,
          headers: {
            to: rs.headers.to,
            from: rs.headers.from,
            'call-id': callId,
            cseq: { method: 'ACK', seq: rs.headers.cseq.seq },
            via: [],
            'max-forwards': 70
          }
        };
        this._safeSendNoCallback(ack);
      } catch (e) {
        console.warn('[SIP] Error sending ACK:', e.message);
      }

      this.emit('callEstablished', {
        callId,
        target: call.target,
        rtpPort: call.rtpPort,
        remoteRtp: remoteSDP
      });
      resolve(callId);
    } else {
      call.state = 'failed';
      this.rtpManager.removeSession(callId);
      this.calls.delete(callId);
      this.emit('callFailed', { callId, status: rs.status, reason: rs.reason });
      reject(new Error(`Call failed: ${rs.status} ${rs.reason}`));
    }
  }

  // ========== Incoming Calls ==========

  _handleIncomingRequest(rq) {
    console.log(`[SIP] Incoming ${rq.method}`);

    switch (rq.method) {
      case 'INVITE':
        this._handleIncomingInvite(rq);
        break;
      case 'BYE':
        this._handleIncomingBye(rq);
        break;
      case 'CANCEL':
        this._handleIncomingCancel(rq);
        break;
      case 'OPTIONS':
        this._safeSendNoCallback(sip.makeResponse(rq, 200, 'OK'));
        break;
      case 'NOTIFY':
        this._safeSendNoCallback(sip.makeResponse(rq, 200, 'OK'));
        break;
      case 'MESSAGE':
        this._safeSendNoCallback(sip.makeResponse(rq, 200, 'OK'));
        break;
      default:
        this._safeSendNoCallback(sip.makeResponse(rq, 405, 'Method Not Allowed'));
    }
  }

  async _handleIncomingInvite(rq) {
    const callId = rq.headers['call-id'];
    const fromUri = rq.headers.from?.uri || '';
    const fromName = rq.headers.from?.name || '';
    const callerNumber = fromUri.replace('sip:', '').split('@')[0];

    // Re-INVITE check
    const existingCall = this.calls.get(callId);
    if (existingCall && existingCall.state === 'established') {
      try {
        const response = sip.makeResponse(rq, 200, 'OK');
        response.headers.contact = [{ uri: this._getContactUri() }];
        response.headers['content-type'] = 'application/sdp';
        response.content = this._generateSDP(existingCall.rtpPort);
        this._safeSendNoCallback(response);
      } catch (e) {}
      return;
    }

    const remoteSDP = this._parseSDP(rq.content);

    let rtpPort = 0;
    try {
      rtpPort = await this.rtpManager.createSession(callId, {
        codec: remoteSDP?.codec || 'PCMU'
      });
    } catch (err) {
      console.error('[SIP] Failed to create RTP session:', err);
      this._safeSendNoCallback(sip.makeResponse(rq, 500, 'Internal Server Error'));
      return;
    }

    if (remoteSDP) {
      this.rtpManager.setRemote(callId, remoteSDP.host, remoteSDP.port);
    }

    // Send 180 Ringing
    try {
      const ringing = sip.makeResponse(rq, 180, 'Ringing');
      ringing.headers.contact = [{ uri: this._getContactUri() }];
      this._safeSendNoCallback(ringing);
    } catch (e) {}

    this.calls.set(callId, {
      id: callId,
      direction: 'incoming',
      target: callerNumber,
      callerName: fromName,
      state: 'ringing',
      fromTag: rq.headers.from?.params?.tag,
      toTag: this._generateTag(),
      incomingRequest: rq,
      rtpPort,
      remoteSDP
    });

    this.emit('incomingCall', {
      callId,
      callerNumber,
      callerName: fromName || callerNumber
    });
  }

  async answer(callId) {
    const call = this.calls.get(callId);
    if (!call || !call.incomingRequest) throw new Error('No incoming call to answer');

    const response = sip.makeResponse(call.incomingRequest, 200, 'OK');
    response.headers.contact = [{ uri: this._getContactUri() }];
    response.headers['content-type'] = 'application/sdp';
    response.content = this._generateSDP(call.rtpPort);

    this._safeSendNoCallback(response);
    call.state = 'established';

    this.rtpManager.startSending(callId);

    this.emit('callEstablished', {
      callId,
      target: call.target,
      rtpPort: call.rtpPort,
      remoteRtp: call.remoteSDP
    });
  }

  _handleIncomingBye(rq) {
    const callId = rq.headers['call-id'];
    this._safeSendNoCallback(sip.makeResponse(rq, 200, 'OK'));

    const call = this.calls.get(callId);
    if (call) {
      call.state = 'ended';
      this.rtpManager.removeSession(callId);
      this.calls.delete(callId);
      this.emit('callEnded', { callId, reason: 'Remote hangup' });
    }
  }

  _handleIncomingCancel(rq) {
    const callId = rq.headers['call-id'];
    this._safeSendNoCallback(sip.makeResponse(rq, 200, 'OK'));

    const call = this.calls.get(callId);
    if (call) {
      if (call.incomingRequest) {
        this._safeSendNoCallback(sip.makeResponse(call.incomingRequest, 487, 'Request Terminated'));
      }
      call.state = 'ended';
      this.rtpManager.removeSession(callId);
      this.calls.delete(callId);
      this.emit('callEnded', { callId, reason: 'Cancelled', wasMissed: true });
    }
  }

  // ========== Call Control ==========

  _getRemoteUri(call) {
    if (call.direction === 'outgoing') {
      return call.targetUri || call.request?.uri || `sip:${call.target}@${this.config.server}`;
    }
    return call.incomingRequest?.headers?.contact?.[0]?.uri || `sip:${call.target}@${this.config.server}`;
  }

  _getToHeader(call) {
    if (call.direction === 'outgoing') {
      return { uri: `sip:${call.target}@${this.config.server}`, params: call.toTag ? { tag: call.toTag } : {} };
    }
    return { uri: call.incomingRequest?.headers?.from?.uri || `sip:${call.target}@${this.config.server}`, params: { tag: call.fromTag } };
  }

  _getFromHeader(call) {
    if (call.direction === 'outgoing') {
      return { uri: this._getAOR(), params: { tag: call.fromTag } };
    }
    return { uri: this._getAOR(), params: { tag: call.toTag } };
  }

  async hangup(callId) {
    const call = this.calls.get(callId);
    if (!call) return;

    this.rtpManager.removeSession(callId);

    try {
      if (call.state === 'ringing' && call.direction === 'incoming') {
        if (call.incomingRequest) {
          this._safeSendNoCallback(sip.makeResponse(call.incomingRequest, 486, 'Busy Here'));
        }
      } else {
        const bye = {
          method: 'BYE',
          uri: this._getRemoteUri(call),
          headers: {
            to: this._getToHeader(call),
            from: this._getFromHeader(call),
            'call-id': callId,
            cseq: { method: 'BYE', seq: this.cseq++ },
            via: [],
            'max-forwards': 70
          }
        };
        this._safeSendNoCallback(bye);
      }
    } catch (e) {
      console.warn('[SIP] Error sending hangup:', e.message);
    }

    call.state = 'ended';
    this.calls.delete(callId);
    this.emit('callEnded', { callId, reason: 'Local hangup' });
  }

  async hold(callId) {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'established') return;
    call.state = 'held';
    this.rtpManager.setHold(callId, true);
    this.emit('callEstablished', { callId, target: call.target, held: true });
  }

  async unhold(callId) {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'held') return;
    call.state = 'established';
    this.rtpManager.setHold(callId, false);
    this.emit('callEstablished', { callId, target: call.target, held: false });
  }

  async sendDTMF(callId, digit) {
    const call = this.calls.get(callId);
    if (!call) return;

    try {
      const info = {
        method: 'INFO',
        uri: this._getRemoteUri(call),
        headers: {
          to: this._getToHeader(call),
          from: this._getFromHeader(call),
          'call-id': callId,
          cseq: { method: 'INFO', seq: this.cseq++ },
          'content-type': 'application/dtmf-relay',
          via: [],
          'max-forwards': 70
        },
        content: `Signal=${digit}\r\nDuration=160\r\n`
      };
      this._safeSendNoCallback(info);
    } catch (e) {
      console.warn('[SIP] Error sending DTMF:', e.message);
    }

    this.emit('dtmfReceived', { callId, digit });
  }

  async transfer(callId, target) {
    const call = this.calls.get(callId);
    if (!call) return;

    let targetUri = target;
    if (!target.startsWith('sip:')) {
      targetUri = `sip:${target}@${this.config.server}`;
    }

    try {
      const refer = {
        method: 'REFER',
        uri: this._getRemoteUri(call),
        headers: {
          to: this._getToHeader(call),
          from: this._getFromHeader(call),
          'call-id': callId,
          cseq: { method: 'REFER', seq: this.cseq++ },
          'refer-to': targetUri,
          via: [],
          'max-forwards': 70
        }
      };
      this._safeSendNoCallback(refer);
    } catch (e) {
      console.warn('[SIP] Error sending REFER:', e.message);
    }
  }

  // ========== RTP Audio Bridge ==========

  feedMicData(callId, pcmSamples) {
    this.rtpManager.feedMicData(callId, pcmSamples);
  }

  setMute(callId, muted) {
    this.rtpManager.setMute(callId, muted);
  }

  getRtpStats(callId) {
    return this.rtpManager.getStats(callId);
  }

  hasCall(callId) {
    return this.calls.has(callId);
  }

  // ========== Status ==========

  getStatus() {
    return {
      registered: this.registered,
      server: this.config.server,
      username: this.config.username,
      transport: this.config.transport,
      localIP: this.localIP,
      localPort: this.localPort,
      activeCalls: this.calls.size
    };
  }

  destroy() {
    this._stopKeepAlive();
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }

    for (const [callId] of this.calls) {
      try { this.hangup(callId); } catch (e) {}
    }
    this.calls.clear();

    this.rtpManager.destroy();

    // Clean up audio batch timers
    if (this._audioBatch) {
      for (const callId of Object.keys(this._audioBatch)) {
        if (this._audioBatch[callId].timer) {
          clearTimeout(this._audioBatch[callId].timer);
        }
      }
      this._audioBatch = {};
    }

    if (this.sipStarted) {
      try { sip.stop(); } catch (e) {}
      this.sipStarted = false;
    }

    this.registered = false;
    this.removeAllListeners();
  }
}

module.exports = SipEngine;

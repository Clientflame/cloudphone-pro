/**
 * RTP Audio Engine for CloudPhone Pro
 * 
 * Handles RTP packet send/receive for voice calls using Node.js dgram.
 * Supports PCMU (G.711 u-law, payload type 0) and PCMA (G.711 a-law, payload type 8).
 * Bridges audio between the SIP call and the Electron renderer for mic/speaker access.
 */

const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('crypto');

// ========== G.711 Codec Tables ==========

// u-law (PCMU) encoding table - linear 16-bit PCM to 8-bit u-law
const ULAW_MAX = 0x1FFF;
const ULAW_BIAS = 33;

function linearToUlaw(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > ULAW_MAX) sample = ULAW_MAX;
  sample += ULAW_BIAS;

  let exponent = 7;
  let mask = 0x4000;
  for (; exponent > 0; exponent--, mask >>= 1) {
    if (sample & mask) break;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

function ulawToLinear(ulawByte) {
  ulawByte = ~ulawByte & 0xFF;
  const sign = ulawByte & 0x80;
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0F;
  let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
  sample -= ULAW_BIAS;
  return sign ? -sample : sample;
}

// a-law (PCMA) encoding
function linearToAlaw(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > 0x7FFF) sample = 0x7FFF;

  let exponent = 7;
  let mask = 0x4000;
  for (; exponent > 0; exponent--, mask >>= 1) {
    if (sample & mask) break;
  }

  let mantissa;
  if (exponent > 0) {
    mantissa = (sample >> (exponent + 3)) & 0x0F;
  } else {
    mantissa = (sample >> 4) & 0x0F;
  }

  const alawByte = (sign | (exponent << 4) | mantissa) ^ 0x55;
  return alawByte;
}

function alawToLinear(alawByte) {
  alawByte ^= 0x55;
  const sign = alawByte & 0x80;
  const exponent = (alawByte >> 4) & 0x07;
  const mantissa = alawByte & 0x0F;

  let sample;
  if (exponent > 0) {
    sample = ((mantissa << 3) + 0x84) << (exponent + 3 - 4);
  } else {
    sample = (mantissa << 4) + 8;
  }

  return sign ? -sample : sample;
}

// ========== RTP Packet Handling ==========

const RTP_HEADER_SIZE = 12;
const RTP_VERSION = 2;
const SAMPLES_PER_PACKET = 160; // 20ms at 8kHz
const PACKET_INTERVAL_MS = 20;

function createRtpHeader(payloadType, sequenceNumber, timestamp, ssrc, marker = false) {
  const header = Buffer.alloc(RTP_HEADER_SIZE);
  // V=2, P=0, X=0, CC=0
  header[0] = (RTP_VERSION << 6);
  // M bit + PT
  header[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7F);
  // Sequence number (big-endian)
  header.writeUInt16BE(sequenceNumber & 0xFFFF, 2);
  // Timestamp (big-endian)
  header.writeUInt32BE(timestamp >>> 0, 4);
  // SSRC (big-endian)
  header.writeUInt32BE(ssrc >>> 0, 8);
  return header;
}

function parseRtpPacket(packet) {
  if (packet.length < RTP_HEADER_SIZE) return null;

  const version = (packet[0] >> 6) & 0x03;
  if (version !== RTP_VERSION) return null;

  const padding = (packet[0] >> 5) & 0x01;
  const extension = (packet[0] >> 4) & 0x01;
  const csrcCount = packet[0] & 0x0F;
  const marker = (packet[1] >> 7) & 0x01;
  const payloadType = packet[1] & 0x7F;
  const sequenceNumber = packet.readUInt16BE(2);
  const timestamp = packet.readUInt32BE(4);
  const ssrc = packet.readUInt32BE(8);

  let headerSize = RTP_HEADER_SIZE + (csrcCount * 4);
  if (extension) {
    if (packet.length < headerSize + 4) return null;
    const extLength = packet.readUInt16BE(headerSize + 2);
    headerSize += 4 + (extLength * 4);
  }

  let payloadEnd = packet.length;
  if (padding && packet.length > headerSize) {
    const paddingLength = packet[packet.length - 1];
    payloadEnd -= paddingLength;
  }

  const payload = packet.slice(headerSize, payloadEnd);

  return {
    version,
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    payload
  };
}

// ========== RTP Session ==========

class RtpSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.localPort = options.localPort || 0;
    this.remoteHost = options.remoteHost || null;
    this.remotePort = options.remotePort || null;
    this.codec = options.codec || 'PCMU'; // PCMU or PCMA
    this.payloadType = this.codec === 'PCMA' ? 8 : 0;

    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.sequenceNumber = crypto.randomBytes(2).readUInt16BE(0);
    this.timestamp = 0;
    this.socket = null;
    this.sendTimer = null;
    this.active = false;
    this.muted = false;
    this.held = false;

    // Audio buffers
    this.micBuffer = []; // PCM samples from mic (16-bit signed, 8kHz)
    this.speakerBuffer = []; // PCM samples to send to speaker

    // Stats
    this.stats = {
      packetsSent: 0,
      packetsReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      packetsLost: 0,
      jitter: 0,
      lastSequence: -1
    };
  }

  /**
   * Start the RTP session — bind to local port and begin sending/receiving
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error('[RTP] Socket error:', err.message);
        this.emit('error', err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this._handleIncomingPacket(msg, rinfo);
      });

      this.socket.bind(this.localPort, '0.0.0.0', () => {
        const addr = this.socket.address();
        this.localPort = addr.port;
        this.active = true;
        console.log(`[RTP] Session started on port ${this.localPort} (${this.codec})`);
        resolve(this.localPort);
      });
    });
  }

  /**
   * Set the remote endpoint (from SDP answer)
   */
  setRemote(host, port) {
    this.remoteHost = host;
    this.remotePort = port;
    console.log(`[RTP] Remote set to ${host}:${port}`);
  }

  /**
   * Begin sending RTP packets at 20ms intervals
   */
  startSending() {
    if (this.sendTimer) return;

    this.sendTimer = setInterval(() => {
      if (!this.active || this.held) return;
      this._sendPacket();
    }, PACKET_INTERVAL_MS);

    console.log('[RTP] Sending started');
  }

  /**
   * Stop sending RTP packets
   */
  stopSending() {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    console.log('[RTP] Sending stopped');
  }

  /**
   * Feed microphone PCM data (16-bit signed, 8kHz mono)
   * Called from the renderer via IPC when mic data is available
   */
  feedMicData(pcmSamples) {
    // pcmSamples is an Int16Array or array of 16-bit signed values
    for (let i = 0; i < pcmSamples.length; i++) {
      this.micBuffer.push(pcmSamples[i]);
    }
  }

  /**
   * Get speaker PCM data to play (16-bit signed, 8kHz mono)
   * Called from the renderer via IPC to get audio for playback
   */
  getSpeakerData(sampleCount) {
    const samples = this.speakerBuffer.splice(0, sampleCount);
    // Pad with silence if not enough data
    while (samples.length < sampleCount) {
      samples.push(0);
    }
    return new Int16Array(samples);
  }

  /**
   * Set mute state
   */
  setMute(muted) {
    this.muted = muted;
    console.log(`[RTP] Mute: ${muted}`);
  }

  /**
   * Set hold state
   */
  setHold(held) {
    this.held = held;
    console.log(`[RTP] Hold: ${held}`);
  }

  /**
   * Send a single RTP packet
   */
  _sendPacket() {
    if (!this.remoteHost || !this.remotePort || !this.socket) return;

    // Get 160 samples (20ms at 8kHz) from mic buffer
    let pcmSamples;
    if (this.muted || this.micBuffer.length < SAMPLES_PER_PACKET) {
      // Send silence (comfort noise)
      pcmSamples = new Array(SAMPLES_PER_PACKET).fill(0);
    } else {
      pcmSamples = this.micBuffer.splice(0, SAMPLES_PER_PACKET);
    }

    // Encode PCM to G.711
    const payload = Buffer.alloc(SAMPLES_PER_PACKET);
    const encode = this.codec === 'PCMA' ? linearToAlaw : linearToUlaw;
    for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
      payload[i] = encode(pcmSamples[i] || 0);
    }

    // Create RTP header
    const marker = this.stats.packetsSent === 0;
    const header = createRtpHeader(
      this.payloadType,
      this.sequenceNumber,
      this.timestamp,
      this.ssrc,
      marker
    );

    // Combine header + payload
    const packet = Buffer.concat([header, payload]);

    // Send via UDP
    this.socket.send(packet, 0, packet.length, this.remotePort, this.remoteHost, (err) => {
      if (err) {
        console.error('[RTP] Send error:', err.message);
      }
    });

    // Update counters
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
    this.timestamp += SAMPLES_PER_PACKET;
    this.stats.packetsSent++;
    this.stats.bytesSent += packet.length;
  }

  /**
   * Handle an incoming RTP packet
   */
  _handleIncomingPacket(msg, rinfo) {
    const rtp = parseRtpPacket(msg);
    if (!rtp) return;

    // Auto-detect remote if not set
    if (!this.remoteHost) {
      this.setRemote(rinfo.address, rinfo.port);
    }

    // Track packet loss
    if (this.stats.lastSequence >= 0) {
      const expected = (this.stats.lastSequence + 1) & 0xFFFF;
      if (rtp.sequenceNumber !== expected) {
        const lost = (rtp.sequenceNumber - expected + 0x10000) & 0xFFFF;
        if (lost < 1000) { // Reasonable gap
          this.stats.packetsLost += lost;
        }
      }
    }
    this.stats.lastSequence = rtp.sequenceNumber;
    this.stats.packetsReceived++;
    this.stats.bytesReceived += msg.length;

    // Skip non-audio payload types (e.g., telephone-event = 101)
    if (rtp.payloadType !== 0 && rtp.payloadType !== 8) {
      // Handle telephone-event (DTMF)
      if (rtp.payloadType === 101 && rtp.payload.length >= 4) {
        const event = rtp.payload[0];
        const endBit = (rtp.payload[1] >> 7) & 1;
        if (endBit) {
          const dtmfChars = '0123456789*#ABCD';
          if (event < dtmfChars.length) {
            this.emit('dtmf', dtmfChars[event]);
          }
        }
      }
      return;
    }

    // Decode G.711 to PCM
    const decode = rtp.payloadType === 8 ? alawToLinear : ulawToLinear;
    for (let i = 0; i < rtp.payload.length; i++) {
      const sample = decode(rtp.payload[i]);
      this.speakerBuffer.push(sample);
    }

    // Emit audio data event for the renderer to consume
    // Send in chunks for efficiency
    if (this.speakerBuffer.length >= SAMPLES_PER_PACKET) {
      const chunk = this.speakerBuffer.splice(0, SAMPLES_PER_PACKET);
      this.emit('audio', new Int16Array(chunk));
    }
  }

  /**
   * Get session statistics
   */
  getStats() {
    return {
      ...this.stats,
      localPort: this.localPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      codec: this.codec,
      active: this.active,
      muted: this.muted,
      held: this.held
    };
  }

  /**
   * Stop the RTP session
   */
  stop() {
    this.active = false;
    this.stopSending();

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // Ignore close errors
      }
      this.socket = null;
    }

    this.micBuffer = [];
    this.speakerBuffer = [];
    this.removeAllListeners();
    console.log('[RTP] Session stopped');
  }
}

// ========== RTP Manager ==========
// Manages multiple RTP sessions (one per active call)

class RtpManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // callId -> RtpSession
  }

  /**
   * Create and start an RTP session for a call
   * Returns the local RTP port to use in SDP
   */
  async createSession(callId, options = {}) {
    // Clean up any existing session for this call
    if (this.sessions.has(callId)) {
      this.sessions.get(callId).stop();
    }

    const session = new RtpSession({
      localPort: 0, // Let OS pick
      codec: options.codec || 'PCMU',
      ...options
    });

    // Forward events
    session.on('audio', (pcmData) => {
      this.emit('audio', { callId, pcmData });
    });

    session.on('dtmf', (digit) => {
      this.emit('dtmf', { callId, digit });
    });

    session.on('error', (err) => {
      this.emit('error', { callId, error: err.message });
    });

    const localPort = await session.start();
    this.sessions.set(callId, session);

    console.log(`[RTP-Manager] Session created for call ${callId} on port ${localPort}`);
    return localPort;
  }

  /**
   * Set the remote RTP endpoint from SDP answer
   */
  setRemote(callId, host, port) {
    const session = this.sessions.get(callId);
    if (session) {
      session.setRemote(host, port);
    }
  }

  /**
   * Start sending RTP for a call (call established)
   */
  startSending(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      session.startSending();
    }
  }

  /**
   * Feed microphone data to a call's RTP session
   */
  feedMicData(callId, pcmSamples) {
    const session = this.sessions.get(callId);
    if (session) {
      session.feedMicData(pcmSamples);
    }
  }

  /**
   * Get speaker data from a call's RTP session
   */
  getSpeakerData(callId, sampleCount) {
    const session = this.sessions.get(callId);
    if (session) {
      return session.getSpeakerData(sampleCount);
    }
    return new Int16Array(sampleCount);
  }

  /**
   * Set mute state for a call
   */
  setMute(callId, muted) {
    const session = this.sessions.get(callId);
    if (session) {
      session.setMute(muted);
    }
  }

  /**
   * Set hold state for a call
   */
  setHold(callId, held) {
    const session = this.sessions.get(callId);
    if (session) {
      session.setHold(held);
    }
  }

  /**
   * Get stats for a call's RTP session
   */
  getStats(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      return session.getStats();
    }
    return null;
  }

  /**
   * Stop and remove an RTP session
   */
  removeSession(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      session.stop();
      this.sessions.delete(callId);
      console.log(`[RTP-Manager] Session removed for call ${callId}`);
    }
  }

  /**
   * Stop all sessions
   */
  destroy() {
    for (const [callId, session] of this.sessions) {
      session.stop();
    }
    this.sessions.clear();
    this.removeAllListeners();
    console.log('[RTP-Manager] All sessions destroyed');
  }
}

module.exports = { RtpSession, RtpManager, linearToUlaw, ulawToLinear, linearToAlaw, alawToLinear };

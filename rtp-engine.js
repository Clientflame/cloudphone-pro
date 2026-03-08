/**
 * RTP Audio Engine for CloudPhone Pro v2
 * 
 * Handles RTP packet send/receive for voice calls using Node.js dgram.
 * Supports PCMU (G.711 u-law, payload type 0) and PCMA (G.711 a-law, payload type 8).
 * 
 * v2 improvements:
 * - Jitter buffer (60ms / 3 packets) for smoother audio playback
 * - Better packet loss tracking
 * - Improved error handling for socket operations
 */

const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('crypto');

// ========== G.711 Codec Tables ==========

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
  header[0] = (RTP_VERSION << 6);
  header[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7F);
  header.writeUInt16BE(sequenceNumber & 0xFFFF, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
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

// ========== Jitter Buffer ==========
// Collects incoming RTP packets and releases them in order after a configurable delay.
// This smooths out network timing variance (jitter) for cleaner audio playback.

class JitterBuffer {
  constructor(options = {}) {
    // Buffer depth in packets (each packet = 20ms)
    // 3 packets = 60ms buffer — good balance between latency and smoothness
    this.depth = options.depth || 3;
    this.buffer = []; // Array of { seq, timestamp, pcmSamples }
    this.lastEmittedSeq = -1;
    this.primed = false; // Wait until buffer has enough packets before starting playback
    this.emitCallback = options.onEmit || (() => {});
    this.drainTimer = null;
    this.DRAIN_INTERVAL_MS = PACKET_INTERVAL_MS; // Drain at the same rate as RTP packets arrive
  }

  /**
   * Add a decoded PCM packet to the jitter buffer
   */
  push(sequenceNumber, timestamp, pcmSamples) {
    // Insert in sequence order
    const entry = { seq: sequenceNumber, timestamp, pcmSamples };
    
    // Find insertion point (maintain sorted order by sequence number)
    let inserted = false;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this._seqLessThan(this.buffer[i].seq, sequenceNumber)) {
        this.buffer.splice(i + 1, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.buffer.unshift(entry);
    }

    // Discard very old packets (more than 10 packets behind)
    while (this.buffer.length > this.depth * 3) {
      this.buffer.shift();
    }

    // Start draining once we have enough packets
    if (!this.primed && this.buffer.length >= this.depth) {
      this.primed = true;
      this._startDrain();
    }
  }

  /**
   * Compare sequence numbers with wraparound handling
   */
  _seqLessThan(a, b) {
    const diff = (b - a + 0x10000) & 0xFFFF;
    return diff > 0 && diff < 0x8000;
  }

  /**
   * Start the drain timer — emits one packet every 20ms
   */
  _startDrain() {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      this._drainOne();
    }, this.DRAIN_INTERVAL_MS);
  }

  /**
   * Emit the next packet from the buffer
   */
  _drainOne() {
    if (this.buffer.length === 0) {
      // Buffer underrun — emit silence
      const silence = new Int16Array(SAMPLES_PER_PACKET);
      this.emitCallback(silence);
      return;
    }

    const entry = this.buffer.shift();
    this.lastEmittedSeq = entry.seq;
    this.emitCallback(entry.pcmSamples);
  }

  /**
   * Stop the jitter buffer and clean up
   */
  stop() {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    this.buffer = [];
    this.primed = false;
    this.lastEmittedSeq = -1;
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      depth: this.depth,
      currentSize: this.buffer.length,
      primed: this.primed,
      lastEmittedSeq: this.lastEmittedSeq
    };
  }
}

// ========== RTP Session ==========

class RtpSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.localPort = options.localPort || 0;
    this.remoteHost = options.remoteHost || null;
    this.remotePort = options.remotePort || null;
    this.codec = options.codec || 'PCMU';
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

    // Jitter buffer for incoming audio
    this.jitterBuffer = new JitterBuffer({
      depth: 3, // 60ms buffer
      onEmit: (pcmSamples) => {
        this.emit('audio', pcmSamples);
      }
    });

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

  setRemote(host, port) {
    this.remoteHost = host;
    this.remotePort = port;
    console.log(`[RTP] Remote set to ${host}:${port}`);
  }

  startSending() {
    if (this.sendTimer) return;

    this.sendTimer = setInterval(() => {
      if (!this.active || this.held) return;
      this._sendPacket();
    }, PACKET_INTERVAL_MS);

    console.log('[RTP] Sending started');
  }

  stopSending() {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    console.log('[RTP] Sending stopped');
  }

  feedMicData(pcmSamples) {
    for (let i = 0; i < pcmSamples.length; i++) {
      this.micBuffer.push(pcmSamples[i]);
    }
    // Prevent unbounded growth — cap at 1 second of audio
    if (this.micBuffer.length > 8000) {
      this.micBuffer = this.micBuffer.slice(-4000);
    }
  }

  setMute(muted) {
    this.muted = muted;
    console.log(`[RTP] Mute: ${muted}`);
  }

  setHold(held) {
    this.held = held;
    console.log(`[RTP] Hold: ${held}`);
  }

  _sendPacket() {
    if (!this.remoteHost || !this.remotePort || !this.socket) return;

    let pcmSamples;
    if (this.muted || this.micBuffer.length < SAMPLES_PER_PACKET) {
      pcmSamples = new Array(SAMPLES_PER_PACKET).fill(0);
    } else {
      pcmSamples = this.micBuffer.splice(0, SAMPLES_PER_PACKET);
    }

    const payload = Buffer.alloc(SAMPLES_PER_PACKET);
    const encode = this.codec === 'PCMA' ? linearToAlaw : linearToUlaw;
    for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
      payload[i] = encode(pcmSamples[i] || 0);
    }

    const marker = this.stats.packetsSent === 0;
    const header = createRtpHeader(
      this.payloadType,
      this.sequenceNumber,
      this.timestamp,
      this.ssrc,
      marker
    );

    const packet = Buffer.concat([header, payload]);

    try {
      this.socket.send(packet, 0, packet.length, this.remotePort, this.remoteHost, (err) => {
        if (err) {
          console.error('[RTP] Send error:', err.message);
        }
      });
    } catch (err) {
      console.error('[RTP] Send exception:', err.message);
    }

    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
    this.timestamp += SAMPLES_PER_PACKET;
    this.stats.packetsSent++;
    this.stats.bytesSent += packet.length;
  }

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
        if (lost < 1000) {
          this.stats.packetsLost += lost;
        }
      }
    }
    this.stats.lastSequence = rtp.sequenceNumber;
    this.stats.packetsReceived++;
    this.stats.bytesReceived += msg.length;

    // Skip non-audio payload types
    if (rtp.payloadType !== 0 && rtp.payloadType !== 8) {
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
    const pcmSamples = new Int16Array(rtp.payload.length);
    for (let i = 0; i < rtp.payload.length; i++) {
      pcmSamples[i] = decode(rtp.payload[i]);
    }

    // Push into jitter buffer instead of emitting directly
    this.jitterBuffer.push(rtp.sequenceNumber, rtp.timestamp, pcmSamples);
  }

  getStats() {
    return {
      ...this.stats,
      localPort: this.localPort,
      remoteHost: this.remoteHost,
      remotePort: this.remotePort,
      codec: this.codec,
      active: this.active,
      muted: this.muted,
      held: this.held,
      jitterBuffer: this.jitterBuffer.getStats()
    };
  }

  stop() {
    this.active = false;
    this.stopSending();
    this.jitterBuffer.stop();

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
      this.socket = null;
    }

    this.micBuffer = [];
    this.removeAllListeners();
    console.log('[RTP] Session stopped');
  }
}

// ========== RTP Manager ==========

class RtpManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  async createSession(callId, options = {}) {
    if (this.sessions.has(callId)) {
      this.sessions.get(callId).stop();
    }

    const session = new RtpSession({
      localPort: 0,
      codec: options.codec || 'PCMU',
      ...options
    });

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

  setRemote(callId, host, port) {
    const session = this.sessions.get(callId);
    if (session) {
      session.setRemote(host, port);
    }
  }

  startSending(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      session.startSending();
    }
  }

  feedMicData(callId, pcmSamples) {
    const session = this.sessions.get(callId);
    if (session) {
      session.feedMicData(pcmSamples);
    }
  }

  setMute(callId, muted) {
    const session = this.sessions.get(callId);
    if (session) {
      session.setMute(muted);
    }
  }

  setHold(callId, held) {
    const session = this.sessions.get(callId);
    if (session) {
      session.setHold(held);
    }
  }

  getStats(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      return session.getStats();
    }
    return null;
  }

  removeSession(callId) {
    const session = this.sessions.get(callId);
    if (session) {
      session.stop();
      this.sessions.delete(callId);
      console.log(`[RTP-Manager] Session removed for call ${callId}`);
    }
  }

  destroy() {
    for (const [callId, session] of this.sessions) {
      session.stop();
    }
    this.sessions.clear();
    this.removeAllListeners();
    console.log('[RTP-Manager] All sessions destroyed');
  }
}

module.exports = { RtpManager, RtpSession };

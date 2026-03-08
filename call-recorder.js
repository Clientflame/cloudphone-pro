/**
 * Call Recorder for CloudPhone Pro
 * 
 * Records both directions of a call (mic + speaker) into a WAV file.
 * Audio is mixed in real-time and written to disk when the recording stops.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SAMPLE_RATE = 8000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1; // Mono (mixed)

class CallRecorder {
  constructor() {
    this.recordings = new Map(); // callId -> recording state
    this.recordingsDir = null;
  }

  /**
   * Initialize the recordings directory
   */
  init() {
    try {
      // Use app.getPath('userData') for persistent storage
      this.recordingsDir = path.join(app.getPath('userData'), 'recordings');
      if (!fs.existsSync(this.recordingsDir)) {
        fs.mkdirSync(this.recordingsDir, { recursive: true });
      }
      console.log('[Recorder] Recordings directory:', this.recordingsDir);
    } catch (err) {
      // Fallback for when app is not ready
      this.recordingsDir = path.join(process.cwd(), 'recordings');
      if (!fs.existsSync(this.recordingsDir)) {
        fs.mkdirSync(this.recordingsDir, { recursive: true });
      }
      console.log('[Recorder] Fallback recordings directory:', this.recordingsDir);
    }
  }

  /**
   * Start recording a call
   */
  startRecording(callId, metadata = {}) {
    if (this.recordings.has(callId)) {
      console.log('[Recorder] Already recording call', callId);
      return this.recordings.get(callId).filePath;
    }

    if (!this.recordingsDir) this.init();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const target = (metadata.target || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `call_${target}_${timestamp}.wav`;
    const filePath = path.join(this.recordingsDir, fileName);

    const recording = {
      callId,
      filePath,
      fileName,
      metadata: {
        ...metadata,
        startTime: Date.now(),
        target: metadata.target || 'Unknown'
      },
      micSamples: [],    // PCM int16 samples from microphone
      speakerSamples: [], // PCM int16 samples from remote party
      active: true,
      sampleCount: 0
    };

    this.recordings.set(callId, recording);
    console.log(`[Recorder] Started recording call ${callId} -> ${fileName}`);
    return filePath;
  }

  /**
   * Feed microphone audio data (outgoing)
   */
  feedMicData(callId, pcmSamples) {
    const recording = this.recordings.get(callId);
    if (!recording || !recording.active) return;

    for (let i = 0; i < pcmSamples.length; i++) {
      recording.micSamples.push(pcmSamples[i] || 0);
    }
  }

  /**
   * Feed speaker audio data (incoming from remote)
   */
  feedSpeakerData(callId, pcmSamples) {
    const recording = this.recordings.get(callId);
    if (!recording || !recording.active) return;

    for (let i = 0; i < pcmSamples.length; i++) {
      recording.speakerSamples.push(pcmSamples[i] || 0);
    }
  }

  /**
   * Stop recording and write WAV file
   * Returns recording metadata
   */
  stopRecording(callId) {
    const recording = this.recordings.get(callId);
    if (!recording) return null;

    recording.active = false;
    recording.metadata.endTime = Date.now();
    recording.metadata.duration = Math.round((recording.metadata.endTime - recording.metadata.startTime) / 1000);

    // Mix both channels together
    const mixedSamples = this._mixAudio(recording.micSamples, recording.speakerSamples);
    recording.sampleCount = mixedSamples.length;
    recording.metadata.sampleCount = mixedSamples.length;
    recording.metadata.durationFormatted = this._formatDuration(recording.metadata.duration);

    // Write WAV file
    try {
      this._writeWav(recording.filePath, mixedSamples);
      const fileStats = fs.statSync(recording.filePath);
      recording.metadata.fileSize = fileStats.size;
      recording.metadata.fileSizeFormatted = this._formatFileSize(fileStats.size);
      console.log(`[Recorder] Saved recording: ${recording.fileName} (${recording.metadata.durationFormatted}, ${recording.metadata.fileSizeFormatted})`);
    } catch (err) {
      console.error('[Recorder] Failed to write WAV:', err.message);
      recording.metadata.error = err.message;
    }

    // Clean up buffers
    recording.micSamples = [];
    recording.speakerSamples = [];

    const result = {
      callId,
      filePath: recording.filePath,
      fileName: recording.fileName,
      ...recording.metadata
    };

    this.recordings.delete(callId);
    return result;
  }

  /**
   * Check if a call is being recorded
   */
  isRecording(callId) {
    const recording = this.recordings.get(callId);
    return recording ? recording.active : false;
  }

  /**
   * Get recording status for a call
   */
  getRecordingStatus(callId) {
    const recording = this.recordings.get(callId);
    if (!recording) return null;

    return {
      active: recording.active,
      duration: Math.round((Date.now() - recording.metadata.startTime) / 1000),
      sampleCount: recording.micSamples.length + recording.speakerSamples.length,
      fileName: recording.fileName
    };
  }

  /**
   * Get list of all saved recordings
   */
  getRecordingsList() {
    if (!this.recordingsDir) this.init();

    try {
      const files = fs.readdirSync(this.recordingsDir)
        .filter(f => f.endsWith('.wav'))
        .map(f => {
          const filePath = path.join(this.recordingsDir, f);
          const stats = fs.statSync(filePath);
          
          // Parse filename: call_TARGET_YYYY-MM-DD_HH-MM-SS.wav
          const parts = f.replace('.wav', '').split('_');
          const target = parts[1] || 'Unknown';
          const dateStr = parts.slice(2).join('_');

          return {
            fileName: f,
            filePath,
            target,
            date: dateStr,
            fileSize: stats.size,
            fileSizeFormatted: this._formatFileSize(stats.size),
            createdAt: stats.birthtime.getTime(),
            createdAtFormatted: stats.birthtime.toLocaleString(),
            // Estimate duration from file size: (fileSize - 44 header) / (sampleRate * bytesPerSample)
            estimatedDuration: Math.max(0, Math.round((stats.size - 44) / (SAMPLE_RATE * 2))),
            estimatedDurationFormatted: this._formatDuration(Math.max(0, Math.round((stats.size - 44) / (SAMPLE_RATE * 2))))
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt); // Newest first

      return files;
    } catch (err) {
      console.error('[Recorder] Failed to list recordings:', err.message);
      return [];
    }
  }

  /**
   * Delete a recording file
   */
  deleteRecording(fileName) {
    if (!this.recordingsDir) this.init();
    const filePath = path.join(this.recordingsDir, fileName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('[Recorder] Deleted:', fileName);
        return true;
      }
    } catch (err) {
      console.error('[Recorder] Failed to delete:', err.message);
    }
    return false;
  }

  /**
   * Get the recordings directory path
   */
  getRecordingsDir() {
    if (!this.recordingsDir) this.init();
    return this.recordingsDir;
  }

  /**
   * Mix two audio streams together (simple average mix)
   */
  _mixAudio(micSamples, speakerSamples) {
    const maxLen = Math.max(micSamples.length, speakerSamples.length);
    const mixed = new Int16Array(maxLen);

    for (let i = 0; i < maxLen; i++) {
      const mic = i < micSamples.length ? micSamples[i] : 0;
      const spk = i < speakerSamples.length ? speakerSamples[i] : 0;
      
      // Mix with headroom to avoid clipping
      let sample = Math.round((mic + spk) * 0.7);
      // Clamp to int16 range
      sample = Math.max(-32768, Math.min(32767, sample));
      mixed[i] = sample;
    }

    return mixed;
  }

  /**
   * Write PCM data as a WAV file
   */
  _writeWav(filePath, pcmData) {
    const dataSize = pcmData.length * 2; // 16-bit = 2 bytes per sample
    const headerSize = 44;
    const fileSize = headerSize + dataSize;
    const buffer = Buffer.alloc(fileSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize - 8, 4);
    buffer.write('WAVE', 8);

    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);           // Chunk size
    buffer.writeUInt16LE(1, 20);            // PCM format
    buffer.writeUInt16LE(NUM_CHANNELS, 22); // Channels
    buffer.writeUInt32LE(SAMPLE_RATE, 24);  // Sample rate
    buffer.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28); // Byte rate
    buffer.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32); // Block align
    buffer.writeUInt16LE(BITS_PER_SAMPLE, 34); // Bits per sample

    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Write PCM data
    for (let i = 0; i < pcmData.length; i++) {
      buffer.writeInt16LE(pcmData[i], headerSize + (i * 2));
    }

    fs.writeFileSync(filePath, buffer);
  }

  /**
   * Format duration in seconds to MM:SS
   */
  _formatDuration(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  /**
   * Format file size to human readable
   */
  _formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Clean up all active recordings
   */
  destroy() {
    for (const [callId] of this.recordings) {
      this.stopRecording(callId);
    }
    this.recordings.clear();
  }
}

module.exports = CallRecorder;

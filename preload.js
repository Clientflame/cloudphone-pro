const { contextBridge, ipcRenderer } = require('electron');

// Expose a secure API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // SIP operations (legacy single-line compatible + multi-line)
  sip: {
    register: (config) => ipcRenderer.invoke('sip:register', config),
    unregister: () => ipcRenderer.invoke('sip:unregister'),
    call: (target, lineId) => ipcRenderer.invoke('sip:call', target, lineId),
    hangup: (callId) => ipcRenderer.invoke('sip:hangup', callId),
    answer: (callId) => ipcRenderer.invoke('sip:answer', callId),
    hold: (callId) => ipcRenderer.invoke('sip:hold', callId),
    unhold: (callId) => ipcRenderer.invoke('sip:unhold', callId),
    sendDTMF: (callId, digit) => ipcRenderer.invoke('sip:sendDTMF', callId, digit),
    transfer: (callId, target) => ipcRenderer.invoke('sip:transfer', callId, target),
    setMute: (callId, muted) => ipcRenderer.invoke('sip:setMute', callId, muted),
    getStatus: () => ipcRenderer.invoke('sip:getStatus'),
    onEvent: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('sip:event', handler);
      return () => ipcRenderer.removeListener('sip:event', handler);
    }
  },

  // Multi-Line management
  line: {
    register: (lineId, config) => ipcRenderer.invoke('line:register', lineId, config),
    unregister: (lineId) => ipcRenderer.invoke('line:unregister', lineId),
    setActive: (lineId) => ipcRenderer.invoke('line:setActive', lineId),
    getAll: () => ipcRenderer.invoke('line:getAll'),
    getActive: () => ipcRenderer.invoke('line:getActive'),
    onStatusChanged: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('line:statusChanged', handler);
      return () => ipcRenderer.removeListener('line:statusChanged', handler);
    },
    onActiveChanged: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('line:activeChanged', handler);
      return () => ipcRenderer.removeListener('line:activeChanged', handler);
    }
  },

  // SIP Debug console
  sipDebug: {
    onMessage: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('sip:debug', handler);
      return () => ipcRenderer.removeListener('sip:debug', handler);
    }
  },

  // RTP Audio operations
  rtp: {
    feedMic: (callId, pcmSamples) => ipcRenderer.invoke('rtp:feedMic', callId, Array.from(pcmSamples)),
    setMute: (callId, muted) => ipcRenderer.invoke('rtp:setMute', callId, muted),
    getStats: (callId) => ipcRenderer.invoke('rtp:getStats', callId),
    onAudio: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('rtp:audio', handler);
      return () => ipcRenderer.removeListener('rtp:audio', handler);
    }
  },

  // Call Recording operations
  recording: {
    start: (callId, metadata) => ipcRenderer.invoke('recording:start', callId, metadata),
    stop: (callId) => ipcRenderer.invoke('recording:stop', callId),
    isRecording: (callId) => ipcRenderer.invoke('recording:isRecording', callId),
    getStatus: (callId) => ipcRenderer.invoke('recording:getStatus', callId),
    list: () => ipcRenderer.invoke('recording:list'),
    delete: (fileName) => ipcRenderer.invoke('recording:delete', fileName),
    openFolder: () => ipcRenderer.invoke('recording:openFolder'),
    getDir: () => ipcRenderer.invoke('recording:getDir')
  },

  // Audio device settings
  audio: {
    getSettings: () => ipcRenderer.invoke('audio:getSettings'),
    saveSettings: (settings) => ipcRenderer.invoke('audio:setSettings', settings),
    setSettings: (settings) => ipcRenderer.invoke('audio:setSettings', settings),
    getRecordCallsSetting: () => ipcRenderer.invoke('audio:getRecordCallsSetting'),
    setRecordCallsSetting: (enabled) => ipcRenderer.invoke('audio:setRecordCallsSetting', enabled)
  },

  // Call Queue Agent operations
  queue: {
    getState: () => ipcRenderer.invoke('queue:getState'),
    login: (queues) => ipcRenderer.invoke('queue:login', queues),
    logout: () => ipcRenderer.invoke('queue:logout'),
    pause: (reason) => ipcRenderer.invoke('queue:pause', reason),
    unpause: () => ipcRenderer.invoke('queue:unpause'),
    getSettings: () => ipcRenderer.invoke('queue:getSettings'),
    saveSettings: (settings) => ipcRenderer.invoke('queue:saveSettings', settings),
    onStateChanged: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('queue:stateChanged', handler);
      return () => ipcRenderer.removeListener('queue:stateChanged', handler);
    }
  },

  // Native Notifications
  notification: {
    show: (title, body, options) => ipcRenderer.invoke('notification:show', title, body, options),
    showMissedCall: (data) => ipcRenderer.invoke('notification:showMissedCall', data),
    showVoicemail: () => ipcRenderer.invoke('notification:showVoicemail'),
    getEnabled: () => ipcRenderer.invoke('notification:getEnabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('notification:setEnabled', enabled)
  },

  // CRM Protocol Handler
  protocol: {
    register: () => ipcRenderer.invoke('protocol:register'),
    isRegistered: () => ipcRenderer.invoke('protocol:isRegistered'),
    onDial: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('protocol:dial', handler);
      return () => ipcRenderer.removeListener('protocol:dial', handler);
    }
  },

  // Navigation events (from main process)
  onNavigate: (callback) => {
    const handler = (event, page) => callback(page);
    ipcRenderer.on('navigate', handler);
    return () => ipcRenderer.removeListener('navigate', handler);
  },

  // Auto-update operations
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    getVersion: () => ipcRenderer.invoke('update:getVersion'),
    getConfig: () => ipcRenderer.invoke('update:getConfig'),
    setConfig: (config) => ipcRenderer.invoke('update:setConfig', config),
    clearToken: () => ipcRenderer.invoke('update:clearToken'),
    onEvent: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('update:event', handler);
      return () => ipcRenderer.removeListener('update:event', handler);
    }
  },

  // Settings store operations
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key),
    getAll: () => ipcRenderer.invoke('store:getAll'),

    // SIP Profiles
    getSipProfiles: () => ipcRenderer.invoke('store:getSipProfiles'),
    saveSipProfile: (profile) => ipcRenderer.invoke('store:saveSipProfile', profile),
    deleteSipProfile: (profileId) => ipcRenderer.invoke('store:deleteSipProfile', profileId),
    setActiveProfile: (profileId) => ipcRenderer.invoke('store:setActiveProfile', profileId),
    getActiveProfile: () => ipcRenderer.invoke('store:getActiveProfile'),
    saveProfile: (profile) => ipcRenderer.invoke('store:saveSipProfile', profile),

    // Call History
    addCallHistory: (entry) => ipcRenderer.invoke('store:addCallHistory', entry),
    getCallHistory: () => ipcRenderer.invoke('store:getCallHistory'),
    saveCallHistory: (history) => ipcRenderer.invoke('store:set', 'callHistory', history),
    clearCallHistory: () => ipcRenderer.invoke('store:clearCallHistory'),

    // Contacts
    getContacts: () => ipcRenderer.invoke('store:getContacts'),
    saveContact: (contact) => ipcRenderer.invoke('store:saveContact', contact),
    saveContacts: (contacts) => ipcRenderer.invoke('store:set', 'contacts', contacts),
    deleteContact: (contactId) => ipcRenderer.invoke('store:deleteContact', contactId),

    // Feature Codes
    getFeatureCodes: () => ipcRenderer.invoke('store:getFeatureCodes'),
    setFeatureCodes: (codes) => ipcRenderer.invoke('store:setFeatureCodes', codes)
  },

  // App settings (startup, always-on-top)
  app: {
    getStartupEnabled: () => ipcRenderer.invoke('app:getStartupEnabled'),
    setStartupEnabled: (enabled) => ipcRenderer.invoke('app:setStartupEnabled', enabled),
    getAlwaysOnTop: () => ipcRenderer.invoke('app:getAlwaysOnTop'),
    setAlwaysOnTop: (enabled) => ipcRenderer.invoke('app:setAlwaysOnTop', enabled)
  },

  // Platform info
  platform: process.platform,
  isElectron: true
});

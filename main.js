const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, Notification } = require('electron');
const path = require('path');

// ========== GLOBAL ERROR HANDLERS ==========
// Prevent the "A JavaScript error occurred in the main process" crash dialog
// The most common error is ERR_SOCKET_DGRAM_NOT_RUNNING when the SIP UDP socket
// closes unexpectedly (e.g., network change, port conflict, OS reclaim)
process.on('uncaughtException', (error) => {
  console.error('[MAIN-PROCESS] Uncaught Exception:', error.message);
  console.error('[MAIN-PROCESS] Stack:', error.stack);
  // Don't crash the app — just log it
  // The SIP engine will detect the dead socket and can re-register
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[MAIN-PROCESS] Unhandled Rejection:', reason);
  // Don't crash the app
});
const { autoUpdater } = require('electron-updater');
const SipEngine = require('./sip-engine');
const Store = require('electron-store');
const CallRecorder = require('./call-recorder');
const AutoLaunch = require('auto-launch');
const { shell } = require('electron');

// ========== Auto-Launch (Windows Startup) ==========
const autoLauncher = new AutoLaunch({
  name: 'CloudPhone Pro',
  isHidden: true // Start minimized to tray
});

let mainWindow = null;
let audioWindow = null; // Hidden window for mic capture (isolates getUserMedia crashes)
let tray = null;
const callRecorder = new CallRecorder();

// ========== Hidden Audio Capture Window ==========
// getUserMedia + ScriptProcessor crashes the renderer with 0xC0000005 on some Windows systems.
// By running mic capture in a separate hidden BrowserWindow, we isolate the crash:
// - If the audio window crashes, the main UI stays alive
// - The call continues (SIP engine runs in main process)
// - We can retry the audio window without losing the call
function createAudioWindow() {
  if (audioWindow && !audioWindow.isDestroyed()) {
    return; // Already exists
  }
  audioWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  });
  audioWindow.loadFile(path.join(__dirname, 'audio-capture.html'));
  
  // Log all console messages from the hidden window to main process stdout
  audioWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelStr = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    console.log(`[AudioWindow:${levelStr}] ${message}`);
    // Also write to crash log for debugging
    try {
      const fs = require('fs');
      const logPath = path.join(app.getPath('userData'), 'audio-debug.log');
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logPath, `[${timestamp}] [${levelStr}] ${message}\n`);
    } catch(e) {}
  });
  
  audioWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[AudioWindow] Crashed:', details.reason, details.exitCode);
    try {
      const fs = require('fs');
      const crashLogPath = path.join(app.getPath('userData'), 'crash.log');
      const timestamp = new Date().toISOString();
      fs.appendFileSync(crashLogPath, `[${timestamp}] AudioWindow crash: reason=${details.reason} exitCode=${details.exitCode} (0x${(details.exitCode >>> 0).toString(16).toUpperCase()})\n`);
    } catch(e) {}
    audioWindow = null;
    // Notify main UI that mic is unavailable
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:micUnavailable', { reason: 'Audio capture process crashed' });
    }
  });
  
  audioWindow.on('closed', () => {
    audioWindow = null;
  });
  
  console.log('[AudioWindow] Created hidden audio capture window');
}

function destroyAudioWindow() {
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.close();
    audioWindow = null;
  }
}

// ========== Multi-Line SIP Engine Management ==========
// Map of lineId -> { engine: SipEngine, config: {}, registered: bool }
const sipLines = new Map();
let activeLineId = null; // The currently selected line for outbound calls

function getActiveSipEngine() {
  if (!activeLineId) return null;
  const line = sipLines.get(activeLineId);
  return line?.engine || null;
}

function getSipEngineForCall(callId) {
  // Search all lines for the call
  for (const [lineId, line] of sipLines) {
    if (line.engine && line.engine.hasCall && line.engine.hasCall(callId)) {
      return { lineId, engine: line.engine };
    }
  }
  // Fallback to active line
  const engine = getActiveSipEngine();
  return engine ? { lineId: activeLineId, engine } : null;
}

// ========== Call Queue Agent State ==========
const queueState = {
  queues: [],        // Array of { id, name, members, callsWaiting, avgWaitTime }
  agentStatus: 'logged_out', // logged_out | available | paused
  agentPauseReason: '',
  loginTime: null,
  callsHandled: 0,
  totalTalkTime: 0
};

// ========== Settings Store ==========

const store = new Store({
  name: 'cloudphone-settings',
  encryptionKey: 'cloudphone-pro-v1-secure-key',
  defaults: {
    sipProfiles: [],
    activeProfileId: null,
    lines: [],          // Array of { id, profileId, enabled, label }
    activeLineId: null,
    audioSettings: {
      inputDevice: 'default',
      outputDevice: 'default',
      ringtoneDevice: 'default',
      inputVolume: 80,
      outputVolume: 80,
      ringtoneVolume: 70,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    appSettings: {
      startMinimized: false,
      minimizeToTray: true,
      autoAnswer: false,
      autoAnswerDelay: 3,
      dndMode: false,
      theme: 'dark',
      compactMode: false,
      showNotifications: true,
      nativeNotifications: true,
      recordCalls: false,
      language: 'en',
      launchOnStartup: false,
      alwaysOnTop: false
    },
    queueSettings: {
      queues: [],
      autoLogin: false
    },
    windowBounds: {
      width: 1200,
      height: 800,
      x: undefined,
      y: undefined
    },
    callHistory: [],
    contacts: [],
    featureCodes: {
      voicemail: '*97',
      transfer: '*2',
      blindTransfer: '##',
      attendedTransfer: '*2',
      pickup: '*8',
      park: '*70',
      intercom: '*80',
      doNotDisturb: '*78',
      doNotDisturbOff: '*79',
      callForwardAll: '*72',
      callForwardAllOff: '*73',
      callForwardBusy: '*90',
      callForwardBusyOff: '*91',
      callForwardNoAnswer: '*92',
      callForwardNoAnswerOff: '*93',
      queueLogin: '*45',
      queueLogout: '*45',
      queuePause: '*46',
      queueUnpause: '*46'
    }
  }
});

// ========== Native Notifications ==========

function showNativeNotification(title, body, options = {}) {
  if (!store.get('appSettings.nativeNotifications')) return null;
  if (!Notification.isSupported()) return null;

  const notif = new Notification({
    title,
    body,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    silent: options.silent || false,
    urgency: options.urgency || 'normal',
    timeoutType: options.timeout || 'default',
    actions: options.actions || []
  });

  if (options.onClick) {
    notif.on('click', options.onClick);
  }

  if (options.onAction) {
    notif.on('action', (event, index) => {
      options.onAction(index);
    });
  }

  notif.show();
  return notif;
}

function showIncomingCallNotification(data) {
  const callerName = data.callerName || data.callerNumber || 'Unknown';
  const lineLabel = data.lineId ? ` (${data.lineId})` : '';

  showNativeNotification(
    'Incoming Call' + lineLabel,
    `${callerName} is calling...`,
    {
      urgency: 'critical',
      silent: false,
      onClick: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    }
  );
}

function showMissedCallNotification(data) {
  const callerName = data.callerName || data.callerNumber || 'Unknown';

  showNativeNotification(
    'Missed Call',
    `You missed a call from ${callerName}`,
    {
      urgency: 'normal',
      onClick: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        // Navigate to call history
        mainWindow?.webContents.send('navigate', 'history');
      }
    }
  );
}

function showVoicemailNotification() {
  showNativeNotification(
    'New Voicemail',
    'You have a new voicemail message',
    {
      urgency: 'normal',
      onClick: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        mainWindow?.webContents.send('navigate', 'voicemail');
      }
    }
  );
}

// ========== CRM Click-to-Call Protocol Handler ==========

function registerProtocolHandlers() {
  // Register as default handler for tel:, sip:, and callto: protocols
  if (process.defaultApp) {
    // In dev mode, register with the path to electron
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('tel', process.execPath, [path.resolve(process.argv[1])]);
      app.setAsDefaultProtocolClient('sip', process.execPath, [path.resolve(process.argv[1])]);
      app.setAsDefaultProtocolClient('callto', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    // In production
    app.setAsDefaultProtocolClient('tel');
    app.setAsDefaultProtocolClient('sip');
    app.setAsDefaultProtocolClient('callto');
  }
}

function handleProtocolUrl(url) {
  if (!url) return;
  console.log('[Protocol] Received URL:', url);

  let number = '';

  if (url.startsWith('tel:')) {
    // tel:+1234567890 or tel:1234567890
    number = url.replace('tel:', '').replace(/[^0-9+*#]/g, '');
  } else if (url.startsWith('sip:')) {
    // sip:user@domain or sip:1234
    const sipUri = url.replace('sip:', '');
    number = sipUri.split('@')[0].replace(/[^0-9+*#a-zA-Z]/g, '');
  } else if (url.startsWith('callto:')) {
    // callto:1234567890
    number = url.replace('callto:', '').replace(/[^0-9+*#]/g, '');
  }

  if (number) {
    console.log('[Protocol] Dialing:', number);
    // Show window and send dial command to renderer
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    // Wait a moment for window to be ready, then send
    setTimeout(() => {
      mainWindow?.webContents.send('protocol:dial', { number, source: url });
    }, 500);
  }
}

// Handle protocol URL on Windows (single instance)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Someone tried to run a second instance or clicked a protocol link
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    // Protocol URL is the last argument on Windows
    const protocolUrl = commandLine.find(arg =>
      arg.startsWith('tel:') || arg.startsWith('sip:') || arg.startsWith('callto:')
    );
    if (protocolUrl) {
      handleProtocolUrl(protocolUrl);
    }
  });
}

// Handle protocol URL on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

// ========== Auto-Updater — GitHub Releases ==========
// Reads GitHub owner/repo from electron-store settings, falling back to package.json defaults.
// Users configure their GitHub repo in Settings > Updates, then the app checks for new releases.

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.autoRunAppAfterInstall = true;
autoUpdater.allowPrerelease = false;
autoUpdater.allowDowngrade = false;

// CRITICAL: Skip code signature verification for unsigned builds
// Without this, electron-updater rejects the downloaded .exe because it's not code-signed
autoUpdater.verifyUpdateCodeSignature = false;
// Also disable the forceDevUpdateConfig check (not in dev mode, but just in case)
autoUpdater.forceDevUpdateConfig = false;


autoUpdater.logger = {
  info: (msg) => console.log('[AutoUpdate]', msg),
  warn: (msg) => console.warn('[AutoUpdate]', msg),
  error: (msg) => console.error('[AutoUpdate]', msg),
  debug: (msg) => console.log('[AutoUpdate:debug]', msg)
};

// ========== HARDCODED UPDATE SOURCE ==========
// These are the official GitHub release coordinates for CloudPhone Pro.
// Users do NOT need to configure these manually.
const GITHUB_UPDATE_OWNER = 'Clientflame';
const GITHUB_UPDATE_REPO = 'cloudphone-pro';

function configureUpdateFeed() {
  // Public repo — no token required
  const feedConfig = {
    provider: 'github',
    owner: GITHUB_UPDATE_OWNER,
    repo: GITHUB_UPDATE_REPO,
    releaseType: 'release'
  };

  try {
    autoUpdater.setFeedURL(feedConfig);
    console.log(`[AutoUpdate] Feed configured: github.com/${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO} (public)`);
    return true;
  } catch (err) {
    console.error('[AutoUpdate] Failed to set feed URL:', err.message);
    return false;
  }
}

function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdate] Checking for updates...');
    sendUpdateEvent('checking');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdate] Update available:', info.version);
    sendUpdateEvent('available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdate] Already up to date:', info.version);
    sendUpdateEvent('not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent('downloading', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdate] Update downloaded:', info.version);
    sendUpdateEvent('ready', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdate] Error:', err.message);
    // Suppress expected failures: no repo configured, offline, 404, DNS failures
    const suppressPatterns = ['404', 'Not Found', 'ENOTFOUND', 'net::ERR', 'getaddrinfo', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_CONNECTION'];
    const isSuppressed = suppressPatterns.some(p => err.message.includes(p));
    if (!isSuppressed) {
      sendUpdateEvent('error', { message: err.message });
    } else {
      console.log('[AutoUpdate] Suppressed error (expected):', err.message);
    }
  });

  // Check for updates on startup (after 5s delay)
  if (configureUpdateFeed()) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.log('[AutoUpdate] Initial check failed:', err.message);
      });
    }, 5000);

    // Check every 30 minutes
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 30 * 60 * 1000);
  }
}

function sendUpdateEvent(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:event', { status, ...data });
  }
}

// ========== Window Management ==========

function createWindow() {
  const savedBounds = store.get('windowBounds');

  const alwaysOnTop = store.get('appSettings.alwaysOnTop') || false;

  mainWindow = new BrowserWindow({
    width: savedBounds.width || 1200,
    height: savedBounds.height || 800,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 900,
    minHeight: 600,
    title: 'CloudPhone Pro',
    backgroundColor: '#0a0a1a',
    alwaysOnTop: alwaysOnTop,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a1a',
      symbolColor: '#8b5cf6',
      height: 36
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false // Prevent audio/IPC throttling when window is in background
    }
  });

  // ===== Media Permission Handlers =====
  // Auto-grant microphone and camera permissions for VoIP calls
  // Without this, getUserMedia() silently fails or crashes the renderer
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'mediaKeySystem'];
    if (allowedPermissions.includes(permission)) {
      console.log(`[PERMISSION] Granted: ${permission}`);
      callback(true);
    } else {
      console.log(`[PERMISSION] Denied: ${permission}`);
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'mediaKeySystem'];
    return allowedPermissions.includes(permission);
  });

  const rendererPath = path.join(__dirname, 'renderer-dist', 'index.html');
  mainWindow.loadFile(rendererPath);

  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', bounds);
    }
  });

  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', bounds);
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ===== Renderer Crash Recovery =====
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[CRASH] Renderer process gone:', details.reason, details.exitCode);
    // Write crash log to user-accessible location
    try {
      const fs = require('fs');
      const crashLogPath = path.join(app.getPath('userData'), 'crash.log');
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] Renderer crash: reason=${details.reason} exitCode=${details.exitCode} (0x${(details.exitCode >>> 0).toString(16).toUpperCase()})\n`;
      fs.appendFileSync(crashLogPath, logEntry);
      console.log('[CRASH] Crash logged to:', crashLogPath);
    } catch(logErr) {
      console.error('[CRASH] Failed to write crash log:', logErr.message);
    }
    // Track crash count to prevent infinite crash loops
    if (!global._crashCount) global._crashCount = 0;
    global._crashCount++;
    console.log('[CRASH] Crash count:', global._crashCount);
    // DO NOT hang up active calls — the SIP engine runs in the main process
    // and the call is still alive even though the renderer crashed.
    // Reload the renderer and let it reconnect to the active call.
    if (global._crashCount > 3) {
      console.error('[CRASH] Too many crashes (' + global._crashCount + '), not reloading to prevent loop');
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[CRASH] Reloading renderer (active SIP calls preserved)...');
      // Check if there are active calls we need to restore
      const activeCalls = [];
      for (const [lineId, line] of sipLines.entries()) {
        if (line.engine) {
          for (const [callId, call] of line.engine.calls.entries()) {
            if (call.state === 'established' || call.state === 'trying' || call.state === 'ringing') {
              activeCalls.push({ callId, target: call.target, state: call.state, lineId });
            }
          }
        }
      }
      console.log('[CRASH] Active calls to restore:', activeCalls.length);
      setTimeout(() => {
        try {
          mainWindow.loadFile(rendererPath);
          // After the renderer reloads, send it the active call info
          if (activeCalls.length > 0) {
            mainWindow.webContents.once('did-finish-load', () => {
              setTimeout(() => {
                for (const call of activeCalls) {
                  console.log('[CRASH] Restoring call to renderer:', call.callId);
                  mainWindow.webContents.send('sip:event', {
                    type: 'callRestored',
                    data: { ...call, skipMic: true },
                    lineId: call.lineId
                  });
                }
              }, 2000); // Give renderer 2s to initialize before sending call state
            });
          }
        } catch (e) {
          console.error('[CRASH] Failed to reload:', e);
        }
      }, 1000);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[CRASH] Renderer became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[CRASH] Renderer became responsive again');
  });

  if (store.get('appSettings.startMinimized')) {
    mainWindow.hide();
  }

  // Check for protocol URL in launch args
  const protocolUrl = process.argv.find(arg =>
    arg.startsWith('tel:') || arg.startsWith('sip:') || arg.startsWith('callto:')
  );
  if (protocolUrl) {
    mainWindow.webContents.once('did-finish-load', () => {
      handleProtocolUrl(protocolUrl);
    });
  }
}

function createTray() {
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty();
    }
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  try {
    tray = new Tray(trayIcon);
  } catch (e) {
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show CloudPhone Pro',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => {
        autoUpdater.checkForUpdates().catch(() => {});
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('CloudPhone Pro');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ========== IPC Handlers: Window Controls ==========

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.handle('window:close', () => mainWindow?.hide());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

// ========== IPC Handlers: Auto-Update ==========

ipcMain.handle('update:check', async () => {
  try {
    // Re-configure feed in case settings changed
    if (!configureUpdateFeed()) {
      return { success: false, error: 'GitHub repo not configured. Go to Settings > Updates.' };
    }
    const result = await autoUpdater.checkForUpdates();
    return { success: true, version: result?.updateInfo?.version };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update:install', () => {
  destroyAllLines();
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('update:getVersion', () => {
  return app.getVersion();
});

// GitHub update configuration — public repo, hardcoded source
ipcMain.handle('update:getConfig', () => {
  return {
    owner: GITHUB_UPDATE_OWNER,
    repo: GITHUB_UPDATE_REPO,
    autoCheck: store.get('github.autoCheck') !== false,
    channel: store.get('github.channel') || 'stable'
  };
});

ipcMain.handle('update:setConfig', (event, config) => {
  if (config.autoCheck !== undefined) store.set('github.autoCheck', config.autoCheck);
  if (config.channel !== undefined) {
    store.set('github.channel', config.channel);
    autoUpdater.allowPrerelease = config.channel === 'beta';
  }
  const configured = configureUpdateFeed();
  return { success: configured };
});

// ========== IPC Handlers: Settings Store ==========

ipcMain.handle('store:get', (event, key) => {
  return store.get(key);
});

ipcMain.handle('store:set', (event, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle('store:delete', (event, key) => {
  store.delete(key);
  return true;
});

ipcMain.handle('store:getAll', () => {
  return store.store;
});

// SIP Profile management
ipcMain.handle('store:getSipProfiles', () => {
  return store.get('sipProfiles') || [];
});

ipcMain.handle('store:saveSipProfile', (event, profile) => {
  const profiles = store.get('sipProfiles') || [];
  const existingIndex = profiles.findIndex(p => p.id === profile.id);
  if (existingIndex >= 0) {
    profiles[existingIndex] = profile;
  } else {
    profile.id = profile.id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    profiles.push(profile);
  }
  store.set('sipProfiles', profiles);
  // Auto-set as active profile if it's the only one, or if no active profile is set
  const currentActive = store.get('activeProfileId');
  if (!currentActive || profiles.length === 1) {
    store.set('activeProfileId', profile.id);
    console.log('[Store] Auto-set active profile:', profile.id);
  }
  return profile;
});

ipcMain.handle('store:deleteSipProfile', (event, profileId) => {
  const profiles = store.get('sipProfiles') || [];
  store.set('sipProfiles', profiles.filter(p => p.id !== profileId));
  return true;
});

ipcMain.handle('store:setActiveProfile', (event, profileId) => {
  store.set('activeProfileId', profileId);
  return true;
});

ipcMain.handle('store:getActiveProfile', () => {
  const profileId = store.get('activeProfileId');
  if (!profileId) return null;
  const profiles = store.get('sipProfiles') || [];
  return profiles.find(p => p.id === profileId) || null;
});

// Call history
ipcMain.handle('store:addCallHistory', (event, entry) => {
  const history = store.get('callHistory') || [];
  history.unshift({
    ...entry,
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: Date.now()
  });
  if (history.length > 500) history.length = 500;
  store.set('callHistory', history);
  return history;
});

ipcMain.handle('store:getCallHistory', () => {
  return store.get('callHistory') || [];
});

ipcMain.handle('store:clearCallHistory', () => {
  store.set('callHistory', []);
  return true;
});

// Contacts
ipcMain.handle('store:getContacts', () => {
  return store.get('contacts') || [];
});

ipcMain.handle('store:saveContact', (event, contact) => {
  const contacts = store.get('contacts') || [];
  const existingIndex = contacts.findIndex(c => c.id === contact.id);
  if (existingIndex >= 0) {
    contacts[existingIndex] = contact;
  } else {
    contact.id = contact.id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    contacts.push(contact);
  }
  store.set('contacts', contacts);
  return contact;
});

ipcMain.handle('store:deleteContact', (event, contactId) => {
  const contacts = store.get('contacts') || [];
  store.set('contacts', contacts.filter(c => c.id !== contactId));
  return true;
});

// Feature codes
ipcMain.handle('store:getFeatureCodes', () => {
  return store.get('featureCodes') || {};
});

ipcMain.handle('store:setFeatureCodes', (event, codes) => {
  store.set('featureCodes', codes);
  return true;
});

// ========== IPC Handlers: Multi-Line SIP Engine ==========

function setupLineEvents(lineId, engine) {
  engine.on('registered', (data) => {
    const line = sipLines.get(lineId);
    if (line) line.registered = true;
    mainWindow?.webContents.send('sip:event', { type: 'registered', data, lineId });
    mainWindow?.webContents.send('line:statusChanged', { lineId, registered: true });
  });

  engine.on('registrationFailed', (data) => {
    const line = sipLines.get(lineId);
    if (line) line.registered = false;
    mainWindow?.webContents.send('sip:event', { type: 'registrationFailed', data, lineId });
    mainWindow?.webContents.send('line:statusChanged', { lineId, registered: false });
  });

  engine.on('unregistered', () => {
    const line = sipLines.get(lineId);
    if (line) line.registered = false;
    mainWindow?.webContents.send('sip:event', { type: 'unregistered', lineId });
    mainWindow?.webContents.send('line:statusChanged', { lineId, registered: false });
  });

  engine.on('incomingCall', (data) => {
    const enrichedData = { ...data, lineId };
    mainWindow?.webContents.send('sip:event', { type: 'incomingCall', data: enrichedData, lineId });

    // Native OS notification
    showIncomingCallNotification(enrichedData);

    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  engine.on('callEstablished', (data) => {
    mainWindow?.webContents.send('sip:event', { type: 'callEstablished', data: { ...data, lineId }, lineId });
  });

  engine.on('callEnded', (data) => {
    mainWindow?.webContents.send('sip:event', { type: 'callEnded', data: { ...data, lineId }, lineId });
    // Check if this was a missed call (short duration, incoming)
    if (data.wasMissed) {
      showMissedCallNotification(data);
    }
  });

  engine.on('callFailed', (data) => {
    mainWindow?.webContents.send('sip:event', { type: 'callFailed', data: { ...data, lineId }, lineId });
  });

  engine.on('dtmfReceived', (data) => {
    mainWindow?.webContents.send('sip:event', { type: 'dtmfReceived', data, lineId });
  });

  engine.on('error', (data) => {
    mainWindow?.webContents.send('sip:event', { type: 'error', data, lineId });
  });

  let rtpAudioCount = 0;
  engine.on('rtpAudio', (data) => {
    rtpAudioCount++;
    if (rtpAudioCount <= 3) {
      console.log(`[MAIN] rtpAudio #${rtpAudioCount}: callId=${data.callId}, samples=${data.pcmData?.length}, first5=[${data.pcmData?.slice(0,5).join(',')}]`);
    } else if (rtpAudioCount === 10) {
      console.log(`[MAIN] rtpAudio streaming... (${rtpAudioCount} batches received)`);
    }
    // Safety: check if renderer is alive before sending IPC
    try {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('rtp:audio', { ...data, lineId });
      }
    } catch (ipcErr) {
      // Renderer crashed or is reloading — silently skip
      if (rtpAudioCount % 100 === 0) {
        console.warn('[MAIN] Cannot send rtp:audio to renderer:', ipcErr.message);
      }
    }
    if (data.callId && callRecorder.isRecording(data.callId)) {
      callRecorder.feedSpeakerData(data.callId, data.pcmData);
    }
  });

  engine.on('sipDebug', (data) => {
    mainWindow?.webContents.send('sip:debug', { ...data, lineId });
  });

  engine.on('sipError', (data) => {
    console.error(`[Line ${lineId}] SIP Error:`, data.error);
    mainWindow?.webContents.send('sip:event', { type: 'sipError', data: { ...data, lineId }, lineId });
  });
}

function destroyAllLines() {
  for (const [lineId, line] of sipLines) {
    if (line.engine) {
      try { line.engine.destroy(); } catch (e) {}
    }
  }
  sipLines.clear();
  activeLineId = null;
}

// Register a line (new multi-line API)
ipcMain.handle('line:register', async (event, lineId, config) => {
  try {
    // Destroy existing engine for this line if any
    const existing = sipLines.get(lineId);
    if (existing?.engine) {
      existing.engine.destroy();
    }

    const engine = new SipEngine(config);
    setupLineEvents(lineId, engine);

    sipLines.set(lineId, {
      engine,
      config,
      registered: false,
      label: config.displayName || config.username || lineId
    });

    // Set as active if it's the first line
    if (!activeLineId) {
      activeLineId = lineId;
    }

    await engine.register();
    return { success: true, lineId };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Unregister a specific line
ipcMain.handle('line:unregister', async (event, lineId) => {
  try {
    const line = sipLines.get(lineId);
    if (line?.engine) {
      await line.engine.unregister();
      line.engine.destroy();
    }
    sipLines.delete(lineId);
    if (activeLineId === lineId) {
      activeLineId = sipLines.size > 0 ? sipLines.keys().next().value : null;
    }
    mainWindow?.webContents.send('line:statusChanged', { lineId, registered: false, removed: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Set the active line for outbound calls
ipcMain.handle('line:setActive', (event, lineId) => {
  if (sipLines.has(lineId)) {
    activeLineId = lineId;
    mainWindow?.webContents.send('line:activeChanged', { lineId });
    return { success: true };
  }
  return { success: false, error: 'Line not found' };
});

// Get all lines status
ipcMain.handle('line:getAll', () => {
  const lines = [];
  for (const [lineId, line] of sipLines) {
    lines.push({
      lineId,
      label: line.label,
      registered: line.registered,
      username: line.config?.username,
      server: line.config?.server,
      isActive: lineId === activeLineId
    });
  }
  return { lines, activeLineId };
});

// Get active line ID
ipcMain.handle('line:getActive', () => {
  return activeLineId;
});

// Legacy single-line SIP register (backwards compatible)
ipcMain.handle('sip:register', async (event, config) => {
  try {
    const lineId = config.lineId || 'line1';
    const existing = sipLines.get(lineId);
    if (existing?.engine) {
      existing.engine.destroy();
    }

    const engine = new SipEngine(config);
    setupLineEvents(lineId, engine);

    sipLines.set(lineId, {
      engine,
      config,
      registered: false,
      label: config.displayName || config.username || lineId
    });

    activeLineId = lineId;
    await engine.register();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:unregister', async () => {
  try {
    destroyAllLines();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Crash log retrieval
ipcMain.handle('app:getCrashLog', async () => {
  try {
    const fs = require('fs');
    const crashLogPath = path.join(app.getPath('userData'), 'crash.log');
    if (fs.existsSync(crashLogPath)) {
      return fs.readFileSync(crashLogPath, 'utf8');
    }
    return 'No crash log found';
  } catch (err) {
    return 'Error reading crash log: ' + err.message;
  }
});

ipcMain.handle('app:getUserDataPath', async () => {
  return app.getPath('userData');
});

ipcMain.handle('sip:call', async (event, target, lineId) => {
  try {
    const targetLineId = lineId || activeLineId;
    const line = sipLines.get(targetLineId);
    if (!line?.engine) return { success: false, error: 'Line not registered' };
    const callId = await line.engine.makeCall(target);
    return { success: true, callId, lineId: targetLineId };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:hangup', async (event, callId) => {
  try {
    const found = getSipEngineForCall(callId);
    if (!found) return { success: false, error: 'No engine for call' };
    await found.engine.hangup(callId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:answer', async (event, callId) => {
  try {
    const found = getSipEngineForCall(callId);
    if (!found) return { success: false, error: 'No engine for call' };
    await found.engine.answer(callId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:hold', async (event, callId) => {
  try {
    const found = getSipEngineForCall(callId);
    if (!found) return { success: false, error: 'No engine for call' };
    await found.engine.hold(callId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:unhold', async (event, callId) => {
  try {
    const found = getSipEngineForCall(callId);
    if (!found) return { success: false, error: 'No engine for call' };
    await found.engine.unhold(callId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:sendDTMF', async (event, callId, digit) => {
  try {
    const found = getSipEngineForCall(callId);
    if (!found) return { success: false, error: 'No engine for call' };
    await found.engine.sendDTMF(callId, digit);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:transfer', async (event, callId, target) => {
  try {
    const found = getSipEngineForCall(callId);
    if (!found) return { success: false, error: 'No engine for call' };
    await found.engine.transfer(callId, target);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sip:getStatus', () => {
  const engine = getActiveSipEngine();
  if (!engine) return { registered: false };
  return engine.getStatus();
});

ipcMain.handle('sip:setMute', (event, callId, muted) => {
  const found = getSipEngineForCall(callId);
  if (found) found.engine.setMute(callId, muted);
  return true;
});

// ========== IPC Handlers: RTP Audio Bridge ==========

// Mic data from the hidden audio capture window
let audioMicDataCount = 0;
ipcMain.handle('audio:micData', (event, callId, pcmSamples) => {
  audioMicDataCount++;
  if (audioMicDataCount <= 5) {
    console.log(`[MAIN] audio:micData #${audioMicDataCount}: callId=${callId}, samples=${pcmSamples?.length}, type=${typeof pcmSamples}, isArray=${Array.isArray(pcmSamples)}`);
  } else if (audioMicDataCount === 20) {
    console.log(`[MAIN] audio:micData streaming... (${audioMicDataCount} batches received)`);
  }
  const found = getSipEngineForCall(callId);
  if (found) {
    found.engine.feedMicData(callId, pcmSamples);
  } else if (audioMicDataCount <= 5) {
    console.warn(`[MAIN] audio:micData: No SIP engine found for callId=${callId}`);
    // Debug: list all active calls
    for (const [lineId, line] of sipLines) {
      if (line.engine) {
        console.log(`[MAIN]   Line ${lineId}: hasCall=${line.engine.hasCall ? line.engine.hasCall(callId) : 'no hasCall method'}`);
      }
    }
  }
  if (callRecorder.isRecording(callId)) {
    callRecorder.feedMicData(callId, pcmSamples);
  }
  return true;
});

// Audio capture window signals
ipcMain.on('audio:ready', () => {
  console.log('[AudioWindow] Audio capture window is ready');
});

ipcMain.on('audio:captureStarted', (event, data) => {
  console.log('[AudioWindow] Capture started:', data);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('audio:micStatus', { active: data.success, error: data.error });
  }
});

ipcMain.on('audio:captureStopped', (event, data) => {
  console.log('[AudioWindow] Capture stopped:', data);
});

// IPC from renderer to start/stop mic capture in hidden window
ipcMain.handle('audio:startMicCapture', (event, callId, deviceId, settings) => {
  console.log('[MAIN] audio:startMicCapture called: callId=' + callId + ', deviceId=' + deviceId);
  if (!audioWindow || audioWindow.isDestroyed()) {
    console.log('[MAIN] Creating new audio window...');
    createAudioWindow();
    audioWindow.webContents.once('did-finish-load', () => {
      console.log('[MAIN] Audio window loaded, sending startCapture command');
      audioWindow.webContents.send('audio:startCapture', { callId, deviceId, settings });
    });
    // Also open devtools for debugging (remove in production)
    // audioWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    console.log('[MAIN] Audio window exists, sending startCapture command');
    audioWindow.webContents.send('audio:startCapture', { callId, deviceId, settings });
  }
  return true;
});

ipcMain.handle('audio:stopMicCapture', () => {
  console.log('[MAIN] Stopping mic capture in hidden window');
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('audio:stopCapture');
  }
  return true;
});

ipcMain.handle('audio:setMicMuted', (event, muted) => {
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('audio:setMuted', muted);
  }
  return true;
});

// Legacy mic data from renderer (kept for backward compat)
ipcMain.handle('rtp:feedMic', (event, callId, pcmSamples) => {
  const found = getSipEngineForCall(callId);
  if (found) {
    found.engine.feedMicData(callId, pcmSamples);
  }
  if (callRecorder.isRecording(callId)) {
    callRecorder.feedMicData(callId, pcmSamples);
  }
  return true;
});

ipcMain.handle('rtp:setMute', (event, callId, muted) => {
  const found = getSipEngineForCall(callId);
  if (found) found.engine.setMute(callId, muted);
  return true;
});

ipcMain.handle('rtp:getStats', (event, callId) => {
  const found = getSipEngineForCall(callId);
  if (found) return found.engine.getRtpStats(callId);
  return null;
});

// ========== IPC Handlers: Call Recording ==========

ipcMain.handle('recording:start', (event, callId, metadata) => {
  try {
    const filePath = callRecorder.startRecording(callId, metadata);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('recording:stop', (event, callId) => {
  try {
    const result = callRecorder.stopRecording(callId);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('recording:isRecording', (event, callId) => {
  return callRecorder.isRecording(callId);
});

ipcMain.handle('recording:getStatus', (event, callId) => {
  return callRecorder.getRecordingStatus(callId);
});

ipcMain.handle('recording:list', () => {
  return callRecorder.getRecordingsList();
});

ipcMain.handle('recording:delete', (event, fileName) => {
  return callRecorder.deleteRecording(fileName);
});

ipcMain.handle('recording:openFolder', () => {
  const dir = callRecorder.getRecordingsDir();
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('recording:getDir', () => {
  return callRecorder.getRecordingsDir();
});

// ========== IPC Handlers: Audio Device Settings ==========

ipcMain.handle('audio:getSettings', () => {
  return store.get('audioSettings');
});

ipcMain.handle('audio:setSettings', (event, settings) => {
  store.set('audioSettings', settings);
  return true;
});

ipcMain.handle('audio:getRecordCallsSetting', () => {
  return store.get('appSettings.recordCalls') || false;
});

ipcMain.handle('audio:setRecordCallsSetting', (event, enabled) => {
  store.set('appSettings.recordCalls', enabled);
  return true;
});

// ========== IPC Handlers: Call Queue Agent ==========

ipcMain.handle('queue:getState', () => {
  return { ...queueState };
});

ipcMain.handle('queue:login', async (event, queues) => {
  try {
    queueState.agentStatus = 'available';
    queueState.loginTime = Date.now();
    queueState.queues = (queues || []).map(q => ({
      id: q.id || q.name,
      name: q.name,
      callsWaiting: 0,
      avgWaitTime: 0,
      members: 0
    }));

    // Dial queue login feature code if configured
    const featureCodes = store.get('featureCodes') || {};
    if (featureCodes.queueLogin) {
      const engine = getActiveSipEngine();
      if (engine) {
        try { await engine.makeCall(featureCodes.queueLogin); } catch (e) {}
      }
    }

    mainWindow?.webContents.send('queue:stateChanged', { ...queueState });
    return { success: true, state: queueState };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('queue:logout', async () => {
  try {
    queueState.agentStatus = 'logged_out';
    queueState.loginTime = null;
    queueState.queues = [];

    const featureCodes = store.get('featureCodes') || {};
    if (featureCodes.queueLogout) {
      const engine = getActiveSipEngine();
      if (engine) {
        try { await engine.makeCall(featureCodes.queueLogout); } catch (e) {}
      }
    }

    mainWindow?.webContents.send('queue:stateChanged', { ...queueState });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('queue:pause', async (event, reason) => {
  try {
    queueState.agentStatus = 'paused';
    queueState.agentPauseReason = reason || '';

    const featureCodes = store.get('featureCodes') || {};
    if (featureCodes.queuePause) {
      const engine = getActiveSipEngine();
      if (engine) {
        try { await engine.makeCall(featureCodes.queuePause); } catch (e) {}
      }
    }

    mainWindow?.webContents.send('queue:stateChanged', { ...queueState });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('queue:unpause', async () => {
  try {
    queueState.agentStatus = 'available';
    queueState.agentPauseReason = '';

    const featureCodes = store.get('featureCodes') || {};
    if (featureCodes.queueUnpause) {
      const engine = getActiveSipEngine();
      if (engine) {
        try { await engine.makeCall(featureCodes.queueUnpause); } catch (e) {}
      }
    }

    mainWindow?.webContents.send('queue:stateChanged', { ...queueState });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('queue:getSettings', () => {
  return store.get('queueSettings') || { queues: [], autoLogin: false };
});

ipcMain.handle('queue:saveSettings', (event, settings) => {
  store.set('queueSettings', settings);
  return true;
});

// ========== IPC Handlers: Native Notifications ==========

ipcMain.handle('notification:show', (event, title, body, options) => {
  showNativeNotification(title, body, options || {});
  return true;
});

ipcMain.handle('notification:showMissedCall', (event, data) => {
  showMissedCallNotification(data);
  return true;
});

ipcMain.handle('notification:showVoicemail', () => {
  showVoicemailNotification();
  return true;
});

ipcMain.handle('notification:getEnabled', () => {
  return store.get('appSettings.nativeNotifications') !== false;
});

ipcMain.handle('notification:setEnabled', (event, enabled) => {
  store.set('appSettings.nativeNotifications', enabled);
  return true;
});

// ========== IPC Handlers: Protocol Handler ==========

ipcMain.handle('protocol:register', () => {
  registerProtocolHandlers();
  return true;
});

ipcMain.handle('protocol:isRegistered', () => {
  return {
    tel: app.isDefaultProtocolClient('tel'),
    sip: app.isDefaultProtocolClient('sip'),
    callto: app.isDefaultProtocolClient('callto')
  };
});

// ========== Launch on Startup & Always on Top ==========

ipcMain.handle('app:getStartupEnabled', async () => {
  try {
    return await autoLauncher.isEnabled();
  } catch {
    return store.get('appSettings.launchOnStartup') || false;
  }
});

ipcMain.handle('app:setStartupEnabled', async (event, enabled) => {
  try {
    if (enabled) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
    store.set('appSettings.launchOnStartup', enabled);
    return true;
  } catch (err) {
    console.error('[AutoLaunch] Error:', err.message);
    return false;
  }
});

ipcMain.handle('app:getAlwaysOnTop', () => {
  return mainWindow?.isAlwaysOnTop() || false;
});

ipcMain.handle('app:setAlwaysOnTop', (event, enabled) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(enabled, 'floating');
    store.set('appSettings.alwaysOnTop', enabled);
  }
  return true;
});

// ========== App Lifecycle ==========

// ===== CRITICAL: Prevent renderer crash (0xC0000005 Access Violation) =====
// The getUserMedia + createMediaStreamSource + ScriptProcessor combination
// triggers a native segfault in Chromium's audio pipeline on some Windows systems.
// Disabling hardware acceleration forces software rendering, which avoids the
// GPU process interaction that causes the crash.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
// Force ANGLE to use software rendering for WebGL
app.commandLine.appendSwitch('use-angle', 'swiftshader');
// Disable features that can cause audio-related crashes
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// Reduce renderer memory pressure
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');

app.whenReady().then(async () => {
  registerProtocolHandlers();
  createWindow();
  createTray();
  setupAutoUpdater();

  // Sync auto-launch state with stored setting
  try {
    const shouldLaunch = store.get('appSettings.launchOnStartup');
    const isEnabled = await autoLauncher.isEnabled();
    if (shouldLaunch && !isEnabled) {
      await autoLauncher.enable();
    } else if (!shouldLaunch && isEnabled) {
      await autoLauncher.disable();
    }
  } catch (err) {
    console.log('[AutoLaunch] Sync skipped:', err.message);
  }
});

app.on('window-all-closed', () => {
  // Don't quit on window close — keep in tray
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  callRecorder.destroy();
  destroyAllLines();
});

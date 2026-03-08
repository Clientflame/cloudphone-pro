# CloudPhone Pro — VoIP Softphone for Desktop

**Version 2.0** | Electron Desktop Application | SIP/RTP Voice Communication

CloudPhone Pro is a production-ready VoIP softphone built on Electron, designed for business telephony environments. It connects to any standards-compliant SIP PBX (Asterisk, FreePBX, 3CX, Yealink Cloud, etc.) and provides a full-featured desktop calling experience with real-time bidirectional audio, call recording, contact management, and enterprise-grade call controls.

**Key advantage:** The SIP engine runs locally on the user's Windows PC, so SIP traffic originates from the user's own IP address — no cloud proxy needed, no WebRTC required on the PBX.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [System Requirements](#system-requirements)
3. [Architecture Overview](#architecture-overview)
4. [Features](#features)
5. [SIP Configuration](#sip-configuration)
6. [Audio System](#audio-system)
7. [Call Controls](#call-controls)
8. [Call Recording](#call-recording)
9. [Contact Management](#contact-management)
10. [Feature Codes](#feature-codes)
11. [QoS Monitoring](#qos-monitoring)
12. [Keyboard Shortcuts](#keyboard-shortcuts)
13. [Auto-Update](#auto-update)
14. [Building from Source](#building-from-source)
15. [File Structure](#file-structure)
16. [Configuration Reference](#configuration-reference)
17. [Troubleshooting](#troubleshooting)
18. [License](#license)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm start

# 3. Build distributable (Windows)
npm run build
```

On first launch, navigate to **Settings** and enter your SIP server credentials, then click **Register**. Once registered, use the dialpad to make calls.

---

## System Requirements

| Component       | Minimum                        | Recommended                    |
|-----------------|--------------------------------|--------------------------------|
| OS              | Windows 10 (64-bit)            | Windows 11                     |
| RAM             | 4 GB                           | 8 GB                           |
| CPU             | Dual-core 1.5 GHz              | Quad-core 2.0 GHz              |
| Network         | 100 kbps per call              | 1 Mbps+ broadband              |
| Audio           | Any sound card with mic/speaker| USB headset with echo cancellation |
| Node.js (dev)   | 18.x                           | 20.x LTS                       |
| Electron        | 28.x                           | 28.x                           |

---

## Architecture Overview

CloudPhone Pro follows Electron's process isolation model with three distinct layers:

**Main Process** (`main.js`) manages the application lifecycle, system tray, window management, auto-update, and all IPC handlers. It instantiates the SIP engine, RTP engine, call recorder, and electron-store for persistent settings.

**Preload Bridge** (`preload.js`) exposes a secure `electronAPI` object to the renderer via `contextBridge`, providing typed access to SIP operations, RTP audio, recording controls, settings storage, and window management without granting direct Node.js access.

**Renderer Process** (`renderer-dist/index.html`) is a self-contained single-page application with a sidebar navigation, dialpad, contacts, call history, voicemail, recordings, QoS dashboard, keyboard shortcuts reference, and settings — all rendered client-side with vanilla JavaScript and Lucide icons.

```
┌─────────────────────────────────────────────────────┐
│                   Renderer (Chromium)                │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌────────┐ │
│  │ Dialpad │ │ Contacts │ │ Recordings│ │Settings│ │
│  └────┬────┘ └────┬─────┘ └─────┬─────┘ └───┬────┘ │
│       │           │             │            │      │
│       └───────────┴──────┬──────┴────────────┘      │
│                          │ IPC (contextBridge)       │
├──────────────────────────┼──────────────────────────┤
│                   Main Process                       │
│  ┌────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ SIP Engine │ │ RTP Engine │ │ Call Recorder     │ │
│  │ (UDP/TCP)  │ │ (dgram)    │ │ (WAV writer)     │ │
│  └─────┬──────┘ └─────┬──────┘ └────────┬─────────┘ │
│        │              │                 │            │
│  ┌─────┴──────────────┴─────────────────┴──────────┐ │
│  │            electron-store (encrypted)            │ │
│  └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │                    │
    SIP Signaling        RTP Media
    (UDP/TCP/TLS)        (UDP port)
         │                    │
    ┌────┴────────────────────┴────┐
    │         SIP PBX Server       │
    └──────────────────────────────┘
```

---

## Features

### Core Telephony

| Feature                  | Description                                                                 |
|--------------------------|-----------------------------------------------------------------------------|
| SIP Registration         | Register with any SIP server via UDP, TCP, or TLS transport                |
| Outbound Calls           | Dial extensions, phone numbers, or SIP URIs from the dialpad               |
| Inbound Calls            | Receive calls with caller ID, contact lookup, and ringtone notification    |
| Call Hold/Resume         | Place calls on hold and resume with a single click                         |
| Mute/Unmute              | Toggle microphone mute during active calls                                 |
| Blind Transfer           | Transfer a call directly to another extension                              |
| Attended Transfer        | Consult with transfer target before completing the transfer                |
| DTMF Tones               | Send in-call DTMF digits with audible dual-tone feedback                   |
| Call Timer               | Live elapsed-time display during active calls                              |
| Do Not Disturb           | Auto-reject incoming calls when DND mode is enabled                        |
| Auto-Answer              | Automatically answer incoming calls after a configurable delay             |

### Audio and Media

| Feature                  | Description                                                                 |
|--------------------------|-----------------------------------------------------------------------------|
| RTP Audio Engine         | Real-time bidirectional voice using Node.js dgram with PCMU/PCMA codecs    |
| Audio Device Selection   | Choose input (mic), output (speaker), and ringtone devices independently   |
| Volume Controls          | Separate input/output volume sliders with real-time adjustment             |
| Echo Cancellation        | WebRTC echo cancellation, noise suppression, and auto gain control         |
| Microphone Test          | 3-second mic level test with visual feedback                               |
| Speaker Test             | 440 Hz sine wave test tone for output verification                         |
| DTMF Tone Generation     | Web Audio oscillator-based dual-tone generation for all 12 DTMF keys      |
| Call Recording           | Record both directions of audio as WAV files with metadata                 |
| Auto-Record              | Global setting to automatically record all calls                           |
| Recordings Browser       | List, play, and delete recordings from a dedicated page                    |

### Productivity

| Feature                  | Description                                                                 |
|--------------------------|-----------------------------------------------------------------------------|
| Contact Management       | Add, edit, delete contacts with name, extension, company, email, notes     |
| Speed Dial               | Mark contacts as speed-dial for quick access                               |
| Call History             | Filterable log of all incoming, outgoing, and missed calls                 |
| Feature Codes            | Configurable PBX feature codes (voicemail, transfer, park, forward, etc.)  |
| Visual Voicemail         | Voicemail access via configured feature code with one-click dial           |
| QoS Dashboard            | Real-time packet statistics, jitter, codec info, and quality history       |
| Keyboard Shortcuts       | Full keyboard navigation and in-call controls                              |

### Application

| Feature                  | Description                                                                 |
|--------------------------|-----------------------------------------------------------------------------|
| System Tray              | Minimize to tray with double-click restore and context menu                |
| Auto-Update              | electron-updater integration with download progress and restart prompt     |
| Encrypted Settings       | electron-store with AES encryption for SIP credentials                     |
| Window State Persistence | Remember window size and position across sessions                          |
| Custom Title Bar         | Frameless window with branded title bar and window controls                |
| Toast Notifications      | Color-coded success/error/warning/info notifications                       |
| Branded Icon             | Multi-resolution ICO icon for taskbar, tray, and installer                 |

---

## SIP Configuration

Navigate to **Settings > SIP Configuration** and fill in the following fields:

| Field          | Description                                    | Example              |
|----------------|------------------------------------------------|----------------------|
| SIP Server     | Hostname or IP of your PBX                     | `pbx.company.com`   |
| Port           | SIP signaling port                             | `5060`               |
| Transport      | Protocol: UDP, TCP, or TLS                     | `UDP`                |
| Username       | SIP extension or account username              | `1001`               |
| Password       | SIP authentication password                    | (hidden)             |
| Display Name   | Caller ID display name                         | `Jay - Marketing`    |

Click **Register** to connect. The status bar at the bottom of the window will show "Registered" with a green indicator when connected successfully.

Multiple SIP profiles can be stored and switched between. All credentials are encrypted at rest using electron-store's AES encryption.

### FreePBX/Asterisk Extension Setup

On your PBX server, ensure the extension is configured for standard SIP:

1. **Applications > Extensions** — Create or edit the extension
2. Set **Technology**: chan_SIP (or PJSIP)
3. Set **Secret**: A strong password
4. **Advanced tab**: NAT: Yes, Qualify: Yes, Host: dynamic, Transport: UDP

### Firewall

Your PBX firewall needs to allow SIP from the user's IP:

- **Responsive Firewall** (recommended): Enable it in FreePBX — it automatically allows IPs that successfully authenticate
- **Manual**: Add the user's public IP to Connectivity > Firewall > Networks as "Trusted"
- Ensure UDP traffic is allowed on the RTP port range (10000–20000)

---

## Audio System

### Device Selection

CloudPhone Pro enumerates all system audio devices and allows independent selection of:

- **Input Device (Microphone)** — Used for voice capture during calls
- **Output Device (Speaker)** — Used for call audio playback
- **Ringtone Device** — Used for incoming call ringtone playback

### Audio Processing Pipeline

Captured microphone audio flows through the Web Audio API with configurable processing:

1. `getUserMedia()` captures raw PCM from the selected input device
2. An `AudioWorkletNode` downsamples to 8 kHz mono (matching G.711 codec requirements)
3. Echo cancellation, noise suppression, and auto gain control are applied via WebRTC constraints
4. PCM samples are sent to the main process via IPC, which feeds them to the RTP engine
5. Received RTP audio is decoded and played through the selected output device

### Codec Support

The RTP engine supports two G.711 codec variants:

| Codec | Payload Type | Sample Rate | Bitrate  | Description                    |
|-------|-------------|-------------|----------|--------------------------------|
| PCMU  | 0           | 8000 Hz     | 64 kbps  | G.711 mu-law (North America)   |
| PCMA  | 8           | 8000 Hz     | 64 kbps  | G.711 A-law (Europe/Intl)      |

---

## Call Controls

During an active call, the following controls are available on the call overlay:

| Control      | Shortcut     | Description                                           |
|-------------|-------------|-------------------------------------------------------|
| Mute        | `Ctrl+M`    | Toggle microphone mute                                |
| Hold        | `Ctrl+H`    | Place call on hold or resume                          |
| DTMF Pad    | —           | Open in-call DTMF keypad for IVR navigation           |
| Transfer    | —           | Open transfer modal with contact picker               |
| Conference  | —           | Open conference modal to add participants              |
| Park        | —           | Park the call (requires PBX support)                  |
| Record      | —           | Start/stop call recording                             |
| End Call    | `Ctrl+E`    | Hang up the active call                               |

### Transfer Modal

The transfer modal provides two modes:

- **Blind Transfer** — Immediately transfers the call to the target extension
- **Attended Transfer** — Allows consultation before completing the transfer

The modal includes a contact picker showing recent calls and saved contacts for quick target selection.

---

## Call Recording

### Manual Recording

Click the **Record** button (circle icon) during an active call to start recording. A red pulsing "REC" indicator with elapsed time appears at the top of the call overlay. Click again to stop and save.

### Auto-Recording

Enable **Auto-record all calls** in Settings to automatically start recording when any call is established.

### Recording Format

| Property      | Value                                       |
|---------------|---------------------------------------------|
| Format        | WAV (RIFF)                                  |
| Channels      | 1 (mono, mixed mic + speaker)               |
| Sample Rate   | 8000 Hz                                     |
| Bit Depth     | 16-bit signed integer                       |
| Location      | `%APPDATA%/cloudphone-pro/recordings/`      |

### Recordings Browser

The **Recordings** page lists all saved recordings with:

- File name, date, and duration
- Play/pause controls with built-in audio player
- Delete individual recordings
- Open recordings folder in file explorer

---

## Contact Management

### Adding Contacts

Navigate to **Contacts** and click the **+** button to add a new contact with:

- **Name** (required) — Display name
- **Extension** (required) — SIP extension or phone number
- **Company** — Organization name
- **Email** — Email address
- **Notes** — Free-text notes
- **Speed Dial** — Toggle to mark as speed dial

### Speed Dial

Contacts marked as speed dial appear at the top of the contacts list with a star indicator. They can be dialed with a single click.

### Search

Use the search bar at the top of the contacts page to filter by name, extension, or company.

---

## Feature Codes

CloudPhone Pro ships with configurable PBX feature codes. Navigate to **Feature Codes** to view and customize:

| Feature              | Default Code | Description                        |
|----------------------|-------------|------------------------------------|
| Voicemail            | `*97`       | Access voicemail box               |
| Blind Transfer       | `##`        | Blind transfer prefix              |
| Attended Transfer    | `*2`        | Attended transfer prefix           |
| Call Pickup          | `*8`        | Pick up ringing call               |
| Call Park            | `*70`       | Park active call                   |
| Intercom             | `*80`       | Intercom/paging prefix             |
| DND On               | `*78`       | Enable Do Not Disturb              |
| DND Off              | `*79`       | Disable Do Not Disturb             |
| Forward All On       | `*72`       | Enable unconditional forwarding    |
| Forward All Off      | `*73`       | Disable unconditional forwarding   |
| Forward Busy On      | `*90`       | Enable forward on busy             |
| Forward Busy Off     | `*91`       | Disable forward on busy            |
| Forward No Answer On | `*92`       | Enable forward on no answer        |
| Forward No Answer Off| `*93`       | Disable forward on no answer       |

These codes are sent as standard SIP INVITE requests to the PBX when dialed.

---

## QoS Monitoring

The **QoS** page provides real-time call quality metrics:

| Metric          | Description                                              |
|-----------------|----------------------------------------------------------|
| Packets Sent    | Total RTP packets transmitted                            |
| Packets Received| Total RTP packets received                               |
| Packets Lost    | Number of lost packets detected                          |
| Jitter          | Inter-packet arrival time variation (milliseconds)       |
| Codec           | Active audio codec (PCMU or PCMA)                        |
| MOS Score       | Estimated Mean Opinion Score (1.0–5.0) based on R-factor |

Quality history is collected every 2 seconds during active calls and displayed as a time-series view on the QoS page.

---

## Keyboard Shortcuts

### Global Shortcuts (work during calls and in input fields)

| Shortcut       | Action                    |
|----------------|---------------------------|
| `Ctrl+M`       | Toggle mute               |
| `Ctrl+H`       | Toggle hold               |
| `Ctrl+E`       | End call                  |
| `Ctrl+Enter`   | Answer incoming call      |

### Navigation Shortcuts (when no input field is focused)

| Key | Page         |
|-----|-------------|
| `D` | Dialpad      |
| `C` | Contacts     |
| `H` | Call History  |
| `V` | Voicemail    |
| `R` | Recordings   |
| `Q` | QoS Monitor  |
| `S` | Settings     |
| `?` | Shortcuts    |

### Dialpad Shortcuts

| Key              | Action                    |
|------------------|---------------------------|
| `0-9`, `*`, `#`  | Press dialpad key         |
| `Backspace`      | Delete last digit         |
| `Enter`          | Place call                |
| `Escape`         | Clear dial input          |

---

## Auto-Update

CloudPhone Pro includes automatic update support via `electron-updater`. The update lifecycle:

1. **Check** — Automatically checks for updates 3 seconds after launch, then every 30 minutes
2. **Download** — Updates download in the background with progress shown in a banner
3. **Install** — User is prompted to restart and install, or the update applies on next quit

Manual update checks can be triggered from **Settings > About > Check for Updates** or from the system tray context menu.

### Update UI

| State              | Banner Color | User Action                |
|--------------------|-------------|----------------------------|
| Update available   | Amber       | Shows "Downloading..."     |
| Downloading        | Blue        | Shows progress bar         |
| Ready to install   | Green       | "Restart Now" button       |
| Error              | Red         | Auto-dismisses after 10s   |

### Setting Up Auto-Update (One-Time)

**Step 1: Create a GitHub Repository**

```bash
cd cloudphone-desktop
git init
git add .
git commit -m "Initial release v2.0.0"
git remote add origin https://github.com/YOUR_USERNAME/cloudphone-pro.git
git push -u origin main
```

**Step 2: Update `package.json`**

Edit the `publish` section to match your GitHub repo:

```json
"publish": [
  {
    "provider": "github",
    "owner": "YOUR_GITHUB_USERNAME",
    "repo": "cloudphone-pro",
    "releaseType": "release"
  }
]
```

**Step 3: Create a GitHub Personal Access Token**

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scope: `repo` (full control of private repositories)
4. Copy the token

**Step 4: Set the token and publish**

```bash
# Windows (PowerShell)
$env:GH_TOKEN = "ghp_your_token_here"
npm run release
```

### Alternative: Self-Hosted Update Server

```json
"publish": [
  {
    "provider": "generic",
    "url": "https://your-server.com/updates/"
  }
]
```

After building, upload the installer and `latest.yml` to your server.

---

## Building from Source

### Development

```bash
npm install
npm start
```

### Production Build (Windows)

```bash
npm run build
```

This produces an NSIS installer and portable executable in the `dist/` directory via `electron-builder`.

### Build Configuration

The `electron-builder` configuration in `package.json` specifies:

- **Target**: NSIS installer for Windows
- **App ID**: `com.cloudphone.pro`
- **Icon**: `assets/icon.ico` (multi-resolution: 16, 32, 48, 64, 128, 256px)
- **Files**: `main.js`, `preload.js`, `sip-engine.js`, `rtp-engine.js`, `call-recorder.js`, `renderer-dist/**/*`, `assets/**/*`
- **Auto-Update**: GitHub Releases as update provider

### Version Numbering

Use semantic versioning: `MAJOR.MINOR.PATCH`

| Change Type | Example         | When to Use                        |
|------------|-----------------|-------------------------------------|
| PATCH      | 2.0.0 to 2.0.1 | Bug fixes, minor UI tweaks          |
| MINOR      | 2.0.0 to 2.1.0 | New features, improvements          |
| MAJOR      | 2.0.0 to 3.0.0 | Breaking changes, major redesign    |

---

## File Structure

```
cloudphone-desktop/
├── main.js                    # Electron main process (window, tray, IPC, auto-update)
├── preload.js                 # Context bridge (secure IPC API)
├── sip-engine.js              # SIP signaling engine (UDP/TCP/TLS)
├── rtp-engine.js              # RTP media engine (dgram, PCMU/PCMA)
├── call-recorder.js           # WAV call recording engine (mixed stereo)
├── package.json               # Dependencies, build config, publish settings
├── assets/
│   ├── icon.ico               # Windows multi-resolution icon
│   └── icon.png               # PNG source icon (512x512)
└── renderer-dist/
    └── index.html             # Self-contained SPA (HTML + CSS + JS, ~2500 lines)
```

---

## Configuration Reference

All settings are persisted in an encrypted electron-store file at:

```
%APPDATA%/cloudphone-settings/config.json
```

### Store Schema

| Key                | Type     | Default        | Description                           |
|--------------------|----------|----------------|---------------------------------------|
| `sipProfiles`      | Array    | `[]`           | Saved SIP server profiles             |
| `activeProfileId`  | String   | `null`         | Currently active profile ID           |
| `audioSettings`    | Object   | See below      | Audio device and processing settings  |
| `appSettings`      | Object   | See below      | Application behavior settings         |
| `windowBounds`     | Object   | 1200x800       | Window size and position              |
| `callHistory`      | Array    | `[]`           | Call log (max 500 entries)            |
| `contacts`         | Array    | `[]`           | Saved contacts                        |
| `featureCodes`     | Object   | See above      | PBX feature code mappings             |

### Audio Settings Defaults

| Key                 | Default   |
|---------------------|-----------|
| `inputDevice`       | `default` |
| `outputDevice`      | `default` |
| `ringtoneDevice`    | `default` |
| `inputVolume`       | `80`      |
| `outputVolume`      | `80`      |
| `echoCancellation`  | `true`    |
| `noiseSuppression`  | `true`    |
| `autoGainControl`   | `true`    |

### App Settings Defaults

| Key                 | Default   |
|---------------------|-----------|
| `startMinimized`    | `false`   |
| `minimizeToTray`    | `true`    |
| `autoAnswer`        | `false`   |
| `autoAnswerDelay`   | `3`       |
| `dndMode`           | `false`   |
| `theme`             | `dark`    |
| `showNotifications` | `true`    |
| `recordCalls`       | `false`   |
| `language`          | `en`      |

---

## Troubleshooting

### Registration Fails

- Verify the SIP server hostname/IP is reachable from your network
- Confirm the port matches your PBX configuration (typically 5060 for UDP, 5061 for TLS)
- Check that your SIP credentials (username/password) are correct
- If behind NAT, ensure your PBX supports NAT traversal or configure a STUN server
- For 403/401 errors, verify the extension exists and is enabled on the PBX

### No Audio During Calls

- Check that the correct audio devices are selected in Settings
- Run the microphone and speaker tests to verify hardware
- Ensure no other application is exclusively holding the audio device
- Verify that your firewall allows UDP traffic on the RTP port range (10000–20000)

### Call Drops or Poor Quality

- Check the QoS dashboard for packet loss and jitter metrics
- A jitter value above 30ms or packet loss above 2% indicates network issues
- Switch from WiFi to wired Ethernet for more stable connectivity
- Consider enabling QoS/traffic shaping on your router for VoIP traffic

### Recording Issues

- Ensure sufficient disk space in the recordings directory
- Check that the recordings folder is writable by the application
- If recordings are silent, verify that both mic and speaker audio are active during the call

### Auto-Update Not Working

- Ensure `latest.yml` exists in your GitHub Release alongside the installer
- Check that the GitHub repo is public (or the token has `repo` scope for private repos)
- Look at the Electron console for `[AutoUpdate]` log messages
- Verify the `publish.owner` and `publish.repo` in `package.json` match your GitHub repo

---

## Technology Stack

- **Electron 28** — Cross-platform desktop framework
- **electron-updater** — Auto-update via GitHub Releases or generic server
- **electron-store** — Encrypted local settings persistence
- **Node.js dgram** — Native UDP sockets for SIP signaling and RTP media
- **Web Audio API** — Microphone capture, speaker playback, DTMF tone generation
- **Lucide Icons** — Modern icon set (loaded via CDN)
- **DM Sans / JetBrains Mono** — Typography (loaded via Google Fonts)

---

## License

CloudPhone Pro is proprietary software. All rights reserved.

For licensing inquiries, contact your administrator.

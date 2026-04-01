# homebridge-tvt-nocloud

A [Homebridge](https://homebridge.io) plugin that exposes **TVT DVR/NVR cameras** to Apple HomeKit — live video streaming, snapshots, and motion detection. No cloud account required.

Developed and tested against a **TVT TD-2708TS-C** (firmware 1.1.0.0R3).

---

## Features

- **Live streaming** — RTSP → FFmpeg → HomeKit SRTP, sub-stream or main stream
- **Snapshots** — served via TVT HTTP API (`/GetSnapshot/N`)
- **Motion detection** — HTTP push from DVR (zero latency) + optional polling fallback
- **Auto-discovery** — reads channel list from DVR automatically

---

## Requirements

- [Homebridge](https://homebridge.io) ≥ 1.6.0
- Node.js ≥ 18
- `ffmpeg` on your Homebridge host — install via:
  ```bash
  sudo apt install ffmpeg          # Debian/Ubuntu/Raspberry Pi OS
  brew install ffmpeg              # macOS
  npm install -g ffmpeg-for-homebridge  # portable alternative
  ```

---

## Installation

```bash
npm install -g homebridge-tvt-nocloud
```

Or via Homebridge Config UI X: search for `homebridge-tvt-nocloud`.

---

## DVR Setup

### Sub-stream (recommended)

Configure in DVR → **Encode → Sub Stream**:

| Setting | Recommended value |
|---|---|
| Codec | H.264 |
| Resolution | 704×576 (or lowest available) |
| FPS | 15 |
| Rate type | CBR |
| Max bitrate | 512 kbps |

### Motion push (optional, zero-latency)

Configure in DVR → **Alarm → Motion Detection → Linkage → HTTP Notification**:
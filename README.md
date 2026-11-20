# Voice Page Controller

**English** | [简体中文](README.zh-CN.md)

Control your browser with your voice. Speak a command, and the extension parses it with an LLM and executes it on the current page — scrolling, searching, controlling video playback, filling forms, and navigating.

No account, no backend, no telemetry. You bring your own LLM API key, and the microphone is only active while voice control is switched on.

## Features

- **Natural language commands** — "scroll down", "search for artificial intelligence", "play the third video".
- **Page-aware** — the current page's title, URL, video list and links are sent as context, so "open the second link" actually works.
- **Media control** — play/pause, seek forward/back, playback rate, volume, like.
- **Form filling** — fill username, name, phone, email and verification-code fields, then submit by voice.
- **Bring your own model** — Volcano Ark, Alibaba DashScope, or DeepSeek (all OpenAI-compatible chat APIs).
- **Two entry points** — a floating ball on every page and a popup panel with settings.
- **Privacy first** — no background service at boot, no data collection; the mic is released when you switch voice control off.

## Supported commands

| Category | Examples | Actions |
| --- | --- | --- |
| Scrolling | "scroll down", "back to top" | `scroll` |
| Search | "search for xxx", "look up xxx" | `search` |
| Open | "open bilibili", "open the second link" | `open_page`, `watch` |
| Tidy up | "clean ads" | `clean_ads` |
| Media | "pause", "forward 10s", "1.5x speed", "volume 60", "like" | `play_pause`, `seek`, `speed`, `volume`, `like` |
| Forms | "fill username alice", "name John, phone 138..., submit" | `fill_user`, `fill_field`, `focus_password`, `submit_form` |
| Navigation | "refresh", "go back", "go forward" | `reload`, `back`, `forward` |

Password fields are intentionally **not** filled by voice — the extension only focuses the password input so your browser's password manager or your own typing handles it.

## How it works

```
 mic ──► host page (http://127.0.0.1:8765/speech.html)
              │  Web Speech API (real web origin, so mic permission works)
              ▼
        host_bridge.js  ──chrome.runtime──►  background.js
              ▲                                  │
              │                                  ├─► LLM API (intent → JSON actions)
              └──────────── result ──────────────┘
                                                 │
                                          content.js on the active tab
                                          (scroll / fill / submit / reload …)
```

Why a local page instead of doing recognition inside the extension? Edge rejects `SpeechRecognition` on `chrome-extension://` origins, so no permission prompt is ever shown. Running recognition on a real `http://127.0.0.1` origin solves this with a single, permanent permission grant.

## Install

1. Download or clone this repository.
2. Open `edge://extensions` (or `chrome://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the `voice-control-extension` folder.

## Setup

1. **Start the host server** (Python 3 required):
   ```bash
   cd voice-control-extension/server
   python -m http.server 8765 --bind 127.0.0.1
   ```
   On Windows you can just double-click `server/start_server.bat`. Keep the window open while using the extension; close it to stop the server. Nothing is installed at boot.
2. **Grant the microphone** — click the extension icon, press **Authorize microphone**, then press the button on the opened page and allow mic access for `127.0.0.1`.
3. **Configure a model** — in the popup, pick a provider and paste your API key:
   - Volcano Ark: `https://ark.cn-beijing.volces.com/api/v3`
   - Alibaba DashScope: `https://dashscope.aliyuncs.com/compatible-mode/v1`
   - DeepSeek: `https://api.deepseek.com`
4. Toggle voice control on and speak. The host page stays in a pinned background tab, so recognition continues when you switch tabs.

## Project structure

```
voice-control-extension/
├─ manifest.json          # MV3 manifest
├─ background.js          # service worker: LLM calls, action dispatch, host-page lifecycle
├─ content/
│  ├─ content.js          # in-page actions: scroll, search, media, forms, submit
│  ├─ floating.js         # floating ball UI
│  └─ host_bridge.js      # postMessage <-> chrome.runtime bridge for the host page
├─ popup/                 # settings + on/off toggle
├─ server/
│  ├─ speech.html         # host page: mic permission + Web Speech recognition
│  └─ start_server.bat    # one-click local static server (Windows)
└─ tests/                 # LLM connectivity / speech API test scripts
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `404` from `127.0.0.1:8765` | The server was started from the wrong folder. Run it inside `server/`, or use `start_server.bat`. |
| `not-allowed` when starting recognition | Microphone denied for `127.0.0.1`; re-grant it in `edge://settings/content/microphone`. |
| `401` from the LLM API | Invalid or expired API key. Verify it directly against the provider before changing code. |
| Nothing happens on a page | Some pages block extension scripts (browser stores, PDF viewer, cross-origin iframe forms). |

## Limitations

- Recognition uses the browser's built-in Web Speech service, so an internet connection is required and accuracy is best in Chrome/Edge.
- Forms inside cross-origin iframes (some bank, government and SSO pages) cannot be filled.
- Image CAPTCHAs cannot be solved — the model can only type digits you dictate.
- Voice commands are executed without a second confirmation; review filled forms before saying "submit".

## License

MIT

# 🍁 MapleEXP Tracker

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20Web%20App-brightgreen?style=for-the-badge&logo=github)](https://open-maple.github.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> # 🛑 "Open source like they could be. Completely offline."
>
> Tired of "open-source" trackers that demand a Discord login, phone home with telemetry, hide features behind paid tiers, or secretly rely on proprietary cloud backends just to read numbers off your screen?
>
> **MapleEXP Tracker runs 100% client-side in your browser. Completely offline. Zero BS.**
>
> - ❌ **No Cloud Backends** — Nothing to shut down, lag out, or get paywalled. There is no server.
> - ❌ **No Logins or Accounts** — We don't want your email, your Discord tag, or your credentials.
> - ❌ **Zero Telemetry or Analytics** — Your gameplay, screen captures, and grind sessions stay in your browser RAM and never leave your machine.
> - ❌ **No 500MB Bloatware** — No suspicious `.exe` installers, no background daemons, no driver hooks.
> - 🔌 **Unplug your internet cable mid-grind — it won't drop a single frame.**
>
> ---
> 🌐 **Live Web App**: **[open-maple.github.io](https://open-maple.github.io/)**  
> Run directly in Chrome, Edge, Brave, or Opera with zero installation required!

---

A high-performance, real-time battle analysis and experience tracker for MapleStory that continuously monitors your EXP, rolling rates (**1m, 5m, 10m, 30m, 1h**), and 3x4 quickslot item quantities with configurable **Low-Item Full-App Red Alert Warnings**.

Built 100% client-side with modern Web APIs: Screen Capture API, HTML5 Canvas, Web Audio API, Document Picture-in-Picture, and MediaRecorder.

---

## 🌟 Web Application Features

- **🎥 Chrome Window Screen Capture**:
  - Click **"📹 Select MapleStory Window"** to capture your game window directly using Chromium's native Screen Capture API (`navigator.mediaDevices.getDisplayMedia`).
  - No Python, no drivers, and no installation required.
- **📌 Picture-in-Picture (PiP) Floating Always-on-Top Overlay**:
  - Click **"📌 Float (PiP)"** to pop out a compact, floating statistics overlay that stays **Always-on-Top** over MapleStory while you grind.
  - Displays current EXP, progress bar, hourly rates, and monitored item counts.
- **🎒 Hotbar Item Monitor & Low Quantity Red Alert**:
  - Monitors all 12 MapleStory quickslots (`1..4`, `Shift..Pup`, `Ctrl..Pdn`) in real time.
  - Interactive cell selector: click any slot to set custom thresholds.
  - Audible two-tone chime and bold red warning theme when potions or items drop below threshold.
- **🔴 Built-in Window Recording & Export**:
  - Record grinding sessions with **`MediaRecorder`**.
  - One-click **"Start Recording"** with live timer badge and instant `.webm` video download.
- **📈 Rolling Time Windows & Battle Analysis**:
  - Rolling windows: **1m, 5m, 10m, 30m, 1h**.
  - Interactive 128-slice sparkline graph with hover tooltips.
  - Level-up ETA projections and anomaly sanitization against black screens/transitions.
- **⚡ 1-Click Instant Demo**:
  - Test the web app instantly without launching the game using the **"⚡ 1-Click Demo Screen"** button or by dragging and dropping any screenshot or recording.
- **💾 Session Log Export**:
  - Download full CSV logs of your battle analysis session with timestamps and EXP deltas.

---

## 🚀 Running Locally

You can serve the static site using any local HTTP server:

```bash
# Using Python
python -m http.server 8000

# Or using Node
npx serve .
```

Open `http://localhost:8000` in Google Chrome or Microsoft Edge.

---

## 🧪 Unit Tests

Run the pure JavaScript unit test suite:

```bash
node test_js/test_tracker.js
```

/**
 * MapleEXP Tracker - Main Web Application Controller
 * Handles Chrome window capture (getDisplayMedia), MediaRecorder recording,
 * 1 Hz computer vision loop, hotbar alerting, sparkline rendering,
 * and Picture-in-Picture always-on-top overlay.
 */

(function () {
  'use strict';

  // Core engines
  const cvEngine = new CVEngine();
  const tracker = new ExpTracker();

  // Helper to convert RAW_TEMPLATES to ImageData
  function createTmplImageData(raw) {
    const { width, height, data } = raw;
    const rgba = new Uint8ClampedArray(width * height * 4);
    let p = 0;
    for (let i = 0; i < data.length; i += 3) {
      rgba[p++] = data[i];
      rgba[p++] = data[i + 1];
      rgba[p++] = data[i + 2];
      rgba[p++] = 255;
    }
    return { width, height, data: rgba };
  }

  const expLogoTmpl = createTmplImageData(RAW_TEMPLATES.exp_logo);
  const frameBottomTmpl = createTmplImageData(RAW_TEMPLATES.frame_bottom);
  const ctrlBtnTmpl = createTmplImageData(RAW_TEMPLATES.ctrl_btn);

  const expDetector = new ExpDetector(cvEngine, expLogoTmpl);
  const hotbarDetector = new HotbarDetector(cvEngine, frameBottomTmpl, ctrlBtnTmpl);

  // App State
  let captureStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let recordingStartTime = 0;
  let recordingTimerInterval = null;

  let isPaused = false;
  let isMuted = false;
  let activeTab = 'exp'; // 'exp' | 'hotbar'
  let selectedWindow = '5m'; // '1m' | '5m' | '10m' | '30m' | '1h'
  let selectedCell = [2, 3]; // [row, col] default: Pdn (orange potions)
  let cellAlerts = {};

  // LocalStorage Keys
  const STORAGE_KEYS = {
    CELL_ALERTS: 'maple_exp_cell_alerts',
    SELECTED_CELL: 'maple_exp_selected_cell',
    SELECTED_WINDOW: 'maple_exp_selected_window',
    IS_MUTED: 'maple_exp_is_muted'
  };

  function saveInputsToStorage() {
    try {
      localStorage.setItem(STORAGE_KEYS.CELL_ALERTS, JSON.stringify(cellAlerts));
      localStorage.setItem(STORAGE_KEYS.SELECTED_CELL, JSON.stringify(selectedCell));
      localStorage.setItem(STORAGE_KEYS.SELECTED_WINDOW, selectedWindow);
      localStorage.setItem(STORAGE_KEYS.IS_MUTED, JSON.stringify(isMuted));
    } catch (e) {
      console.warn('Could not save to localStorage:', e);
    }
  }

  function loadInputsFromStorage() {
    try {
      // 1. Cell Alerts
      const savedAlerts = localStorage.getItem(STORAGE_KEYS.CELL_ALERTS);
      if (savedAlerts) {
        const parsed = JSON.parse(savedAlerts);
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 4; c++) {
            const k = `${r},${c}`;
            if (parsed && parsed[k]) {
              cellAlerts[k] = {
                threshold: typeof parsed[k].threshold === 'number' ? parsed[k].threshold : 20,
                enabled: Boolean(parsed[k].enabled)
              };
            }
          }
        }
      }

      // 2. Selected Cell
      const savedCell = localStorage.getItem(STORAGE_KEYS.SELECTED_CELL);
      if (savedCell) {
        const parsed = JSON.parse(savedCell);
        if (Array.isArray(parsed) && parsed.length === 2) {
          selectedCell = parsed;
        }
      }

      // 3. Selected Window
      const savedWindow = localStorage.getItem(STORAGE_KEYS.SELECTED_WINDOW);
      if (savedWindow && ['1m', '5m', '10m', '30m', '1h'].includes(savedWindow)) {
        selectedWindow = savedWindow;
      }

      // 4. Mute state
      const savedMute = localStorage.getItem(STORAGE_KEYS.IS_MUTED);
      if (savedMute !== null) {
        isMuted = JSON.parse(savedMute);
      }
    } catch (e) {
      console.warn('Could not load from localStorage:', e);
    }
  }

  // Initialize cell alert configs: 3x4 grid (all default to disabled)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      cellAlerts[`${r},${c}`] = { threshold: 20, enabled: false };
    }
  }

  // Load saved inputs from localStorage
  loadInputsFromStorage();

  let latestDetection = {
    status: 'WAITING',
    details: 'Click "Select Window" to begin',
    scale: 1.0,
    expVal: 0,
    expPct: 0.0,
    barPct: null,
    windows: {},
    hotbarFound: false,
    quantities: {},
    alertActive: false,
    alertCells: []
  };

  // DOM Elements
  const body = document.body;
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusDetails = document.getElementById('statusDetails');
  const alertBanner = document.getElementById('alertBanner');
  const alertBannerText = document.getElementById('alertBannerText');

  const btnSelectWindow = document.getElementById('btnSelectWindow');
  const btnRecord = document.getElementById('btnRecord');
  const recordingBadge = document.getElementById('recordingBadge');
  const recordingTimer = document.getElementById('recordingTimer');
  const btnToggleVideo = document.getElementById('btnToggleVideo');
  const btnPip = document.getElementById('btnPip');

  const videoContainer = document.getElementById('videoContainer');
  const captureVideo = document.getElementById('captureVideo');
  const offscreenCanvas = document.getElementById('offscreenCanvas');
  const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

  const pipCanvas = document.getElementById('pipCanvas');
  const pipCtx = pipCanvas.getContext('2d');
  const pipVideo = document.getElementById('pipVideo');

  const expHeroNum = document.getElementById('expHeroNum');
  const expHeroPct = document.getElementById('expHeroPct');
  const expBarFill = document.getElementById('expBarFill');

  const detailedGraphTitle = document.getElementById('detailedGraphTitle');
  const statGraphPeak = document.getElementById('statGraphPeak');
  const statGraphAvg = document.getElementById('statGraphAvg');
  const statGraphRate = document.getElementById('statGraphRate');
  const sparklineCanvas = document.getElementById('sparklineCanvas');
  const sparklineCtx = sparklineCanvas.getContext('2d');
  const sparklineTooltip = document.getElementById('sparklineTooltip');

  const statSessionDuration = document.getElementById('statSessionDuration');
  const statSessionGainedExp = document.getElementById('statSessionGainedExp');
  const statSessionGainedPct = document.getElementById('statSessionGainedPct');
  const statSessionRateExp = document.getElementById('statSessionRateExp');
  const statSessionRatePct = document.getElementById('statSessionRatePct');
  const statSessionEta = document.getElementById('statSessionEta');
  const statSessionLevelUps = document.getElementById('statSessionLevelUps');
  const statSessionAnomalies = document.getElementById('statSessionAnomalies');

  const previewToggle = document.getElementById('previewToggle');
  const previewContent = document.getElementById('previewContent');
  const expCropCanvas = document.getElementById('expCropCanvas');
  const expCropCtx = expCropCanvas.getContext('2d');
  const expOcrDebug = document.getElementById('expOcrDebug');

  const hotbarGrid = document.getElementById('hotbarGrid');
  const configCellName = document.getElementById('configCellName');
  const configThresholdInput = document.getElementById('configThresholdInput');
  const configCellEnable = document.getElementById('configCellEnable');
  const stepperMinus = document.getElementById('stepperMinus');
  const stepperPlus = document.getElementById('stepperPlus');

  const btnPause = document.getElementById('btnPause');
  const btnReset = document.getElementById('btnReset');
  const btnMute = document.getElementById('btnMute');
  const btnExport = document.getElementById('btnExport');

  // Web Audio Alert Chime
  let audioCtx = null;
  function playAlertChime() {
    if (isMuted) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now); // A5
      osc.frequency.setValueAtTime(1174.66, now + 0.15); // D6

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.5);
    } catch (e) {
      console.warn('Audio chime failed:', e);
    }
  }

  // Build Hotbar 3x4 Grid Buttons
  const cellButtons = {};
  const cellCanvases = {};
  const cellQtyLabels = {};
  const cellBadges = {};

  function initHotbarDOM() {
    hotbarGrid.innerHTML = '';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const key = `${r},${c}`;
        const keyName = KEY_NAMES[r][c];

        const cellEl = document.createElement('div');
        cellEl.className = 'hotbar-cell';
        if (r === selectedCell[0] && c === selectedCell[1]) {
          cellEl.classList.add('selected');
        }

        const cvs = document.createElement('canvas');
        cvs.className = 'cell-canvas';
        cvs.width = 31;
        cvs.height = 31;

        const keyLabel = document.createElement('span');
        keyLabel.className = 'cell-key';
        keyLabel.textContent = keyName;

        const qtyLabel = document.createElement('span');
        qtyLabel.className = 'cell-qty';
        qtyLabel.textContent = '-';

        const badge = document.createElement('div');
        badge.className = 'cell-badge-monitored';
        badge.style.display = cellAlerts[key].enabled ? 'block' : 'none';

        cellEl.appendChild(cvs);
        cellEl.appendChild(keyLabel);
        cellEl.appendChild(qtyLabel);
        cellEl.appendChild(badge);

        cellEl.addEventListener('click', () => {
          setSelectedCell(r, c);
        });

        cellButtons[key] = cellEl;
        cellCanvases[key] = cvs;
        cellQtyLabels[key] = qtyLabel;
        cellBadges[key] = badge;

        hotbarGrid.appendChild(cellEl);
      }
    }
    updateConfigCardUI();
  }

  function setSelectedCell(r, c) {
    selectedCell = [r, c];
    for (const [k, el] of Object.entries(cellButtons)) {
      el.classList.toggle('selected', k === `${r},${c}`);
    }
    updateConfigCardUI();
    saveInputsToStorage();
  }

  function updateConfigCardUI() {
    const key = `${selectedCell[0]},${selectedCell[1]}`;
    const keyName = KEY_NAMES[selectedCell[0]][selectedCell[1]];
    const cfg = cellAlerts[key] || { threshold: 20, enabled: false };

    configCellName.textContent = `Slot [${keyName}] Config`;
    configThresholdInput.value = cfg.threshold;
    configCellEnable.checked = cfg.enabled;
    if (cellBadges[key]) {
      cellBadges[key].style.display = cfg.enabled ? 'block' : 'none';
    }
  }

  // Stepper & Presets
  stepperMinus.addEventListener('click', () => {
    const key = `${selectedCell[0]},${selectedCell[1]}`;
    const cur = parseInt(configThresholdInput.value, 10) || 0;
    const newVal = Math.max(0, cur - 5);
    configThresholdInput.value = newVal;
    cellAlerts[key].threshold = newVal;
    saveInputsToStorage();
    checkAlerts();
  });

  stepperPlus.addEventListener('click', () => {
    const key = `${selectedCell[0]},${selectedCell[1]}`;
    const cur = parseInt(configThresholdInput.value, 10) || 0;
    const newVal = cur + 5;
    configThresholdInput.value = newVal;
    cellAlerts[key].threshold = newVal;
    saveInputsToStorage();
    checkAlerts();
  });

  function onThresholdChange() {
    const key = `${selectedCell[0]},${selectedCell[1]}`;
    const val = Math.max(0, parseInt(configThresholdInput.value, 10) || 0);
    configThresholdInput.value = val;
    cellAlerts[key].threshold = val;
    saveInputsToStorage();
    checkAlerts();
  }

  configThresholdInput.addEventListener('change', onThresholdChange);
  configThresholdInput.addEventListener('input', () => {
    const key = `${selectedCell[0]},${selectedCell[1]}`;
    const parsed = parseInt(configThresholdInput.value, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      cellAlerts[key].threshold = parsed;
      saveInputsToStorage();
      checkAlerts();
    }
  });

  configCellEnable.addEventListener('change', () => {
    const key = `${selectedCell[0]},${selectedCell[1]}`;
    cellAlerts[key].enabled = configCellEnable.checked;
    if (cellBadges[key]) {
      cellBadges[key].style.display = configCellEnable.checked ? 'block' : 'none';
    }
    saveInputsToStorage();
    checkAlerts();
  });

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.dataset.val, 10);
      const key = `${selectedCell[0]},${selectedCell[1]}`;
      configThresholdInput.value = val;
      cellAlerts[key].threshold = val;
      saveInputsToStorage();
      checkAlerts();
    });
  });

  // Tab Navigation
  function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.remove('active');
    });
    const target = document.getElementById(`tabContent-${tabId}`);
    if (target) {
      target.classList.add('active');
      activeTab = tabId;
      if (activeTab === 'exp') {
        startSlidingChartLoop();
      }
    }
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Offline Header Banner & Info Page Controls
  const offlineHeaderBanner = document.getElementById('offlineHeaderBanner');
  const btnDismissBanner = document.getElementById('btnDismissBanner');
  const btnBannerLearnMore = document.getElementById('btnBannerLearnMore');
  const btnHeaderInfo = document.getElementById('btnHeaderInfo');
  const btnBackToTracker = document.getElementById('btnBackToTracker');
  const btnRestoreBanner = document.getElementById('btnRestoreBanner');

  const STORAGE_KEY_BANNER_DISMISSED = 'maple_exp_offline_banner_dismissed';

  if (localStorage.getItem(STORAGE_KEY_BANNER_DISMISSED) === 'true') {
    offlineHeaderBanner?.classList.add('dismissed');
  }

  btnDismissBanner?.addEventListener('click', (e) => {
    e.stopPropagation();
    offlineHeaderBanner?.classList.add('dismissed');
    try {
      localStorage.setItem(STORAGE_KEY_BANNER_DISMISSED, 'true');
    } catch (_) {}
  });

  btnBannerLearnMore?.addEventListener('click', () => {
    switchTab('info');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  btnHeaderInfo?.addEventListener('click', () => {
    switchTab('info');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  btnBackToTracker?.addEventListener('click', () => {
    switchTab('exp');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  btnRestoreBanner?.addEventListener('click', () => {
    offlineHeaderBanner?.classList.remove('dismissed');
    try {
      localStorage.removeItem(STORAGE_KEY_BANNER_DISMISSED);
    } catch (_) {}
    btnRestoreBanner.textContent = '✅ Banner Restored!';
    setTimeout(() => {
      btnRestoreBanner.textContent = '🔁 Show Header Banner Again';
    }, 2000);
  });

  // Online / Offline Status Checker
  function updateOfflineStatusUI() {
    const offlineStatusDot = document.getElementById('offlineStatusDot');
    const offlineStatusText = document.getElementById('offlineStatusText');
    if (!offlineStatusDot || !offlineStatusText) return;
    if (navigator.onLine) {
      offlineStatusDot.className = 'status-dot locked';
      offlineStatusText.textContent = 'ONLINE (Ready for offline)';
    } else {
      offlineStatusDot.className = 'status-dot searching';
      offlineStatusText.textContent = 'OFFLINE (Running client-side)';
    }
  }
  window.addEventListener('online', updateOfflineStatusUI);
  window.addEventListener('offline', updateOfflineStatusUI);
  updateOfflineStatusUI();

  const WINDOW_SEC = {
    '1m': 60,
    '5m': 300,
    '10m': 600,
    '30m': 1800,
    '1h': 3600
  };

  function selectWindow(winKey) {
    if (!WINDOW_SEC[winKey]) return;
    selectedWindow = winKey;
    saveInputsToStorage();

    document.querySelectorAll('.pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.window === selectedWindow);
    });

    document.querySelectorAll('.window-row').forEach(row => {
      row.classList.toggle('active', row.dataset.window === selectedWindow);
    });

    updateWindowStatsUI();
  }

  // Window Table Rows
  document.querySelectorAll('.window-row').forEach(row => {
    row.addEventListener('click', () => {
      selectWindow(row.dataset.window);
    });
  });

  // Window Pills (1m, 5m, 10m, 30m, 1h)
  document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectWindow(btn.dataset.window);
    });
  });

  // Screen Capture (getDisplayMedia)
  async function startScreenCapture() {
    try {
      statusText.textContent = 'Opening window picker...';
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'window',
          frameRate: { ideal: 5, max: 30 }
        },
        audio: false
      });

      captureStream = stream;
      captureVideo.srcObject = stream;
      await captureVideo.play();

      btnSelectWindow.innerHTML = '🔄 Switch Window';
      btnToggleVideo.style.display = 'inline-flex';
      btnRecord.style.display = 'inline-flex';

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings ? track.getSettings() : {};
      const resStr = `${settings.width || captureVideo.videoWidth}x${settings.height || captureVideo.videoHeight}`;

      updateStatus('SEARCHING', `Window: ${resStr} - scanning...`, 'searching');

      track.addEventListener('ended', () => {
        stopScreenCapture();
      });
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        alert('Could not start screen capture: ' + err.message);
      }
      updateStatus('WAITING', 'Window capture cancelled', 'paused');
    }
  }

  function stopScreenCapture() {
    if (isRecording) {
      stopRecording();
    }
    if (captureStream) {
      captureStream.getTracks().forEach(t => t.stop());
      captureStream = null;
    }
    captureVideo.srcObject = null;
    btnSelectWindow.innerHTML = '📹 Select MapleStory Window';
    btnToggleVideo.style.display = 'none';
    btnRecord.style.display = 'none';
    videoContainer.style.display = 'none';
    updateStatus('WAITING', 'Capture ended. Select a window to resume.', 'paused');
  }

  btnSelectWindow.addEventListener('click', startScreenCapture);

  btnToggleVideo.addEventListener('click', () => {
    if (videoContainer.style.display === 'none' || !videoContainer.style.display) {
      videoContainer.style.display = 'block';
      btnToggleVideo.textContent = '🙈 Hide Stream';
    } else {
      videoContainer.style.display = 'none';
      btnToggleVideo.textContent = '👁 Show Stream';
    }
  });

  // Screen Recording (MediaRecorder)
  function getSupportedMimeType() {
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function startRecording() {
    if (!captureStream) return;
    recordedChunks = [];
    const mimeType = getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};

    try {
      mediaRecorder = new MediaRecorder(captureStream, options);
    } catch (e) {
      mediaRecorder = new MediaRecorder(captureStream);
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      saveRecording();
    };

    mediaRecorder.start(1000); // 1-second chunks
    isRecording = true;
    recordingStartTime = Date.now();

    btnRecord.classList.add('btn-recording');
    btnRecord.innerHTML = '⏹ Stop & Save';
    recordingBadge.style.display = 'inline-flex';

    recordingTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
      const m = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
      const s = (elapsedSec % 60).toString().padStart(2, '0');
      recordingTimer.textContent = `${m}:${s}`;
    }, 500);
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    mediaRecorder.stop();
    isRecording = false;
    clearInterval(recordingTimerInterval);
    recordingBadge.style.display = 'none';
    btnRecord.classList.remove('btn-recording');
    btnRecord.innerHTML = '🔴 Record Window';
  }

  function saveRecording() {
    if (recordedChunks.length === 0) return;
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const nowStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `MapleStory_Recording_${nowStr}.webm`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  btnRecord.addEventListener('click', () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  // 1 Hz Processing Loop
  function processFrame() {
    if (isPaused) {
      setTimeout(processFrame, 500);
      return;
    }

    let frameSource = null;
    let videoW = 0;
    let videoH = 0;

    if (captureVideo && captureVideo.readyState >= 2) {
      frameSource = captureVideo;
      videoW = captureVideo.videoWidth;
      videoH = captureVideo.videoHeight;
    }

    if (!frameSource) {
      setTimeout(processFrame, 500);
      return;
    }

    offscreenCanvas.width = videoW;
    offscreenCanvas.height = videoH;
    offscreenCtx.drawImage(frameSource, 0, 0, videoW, videoH);

    // Extract bottom ROI (adaptive bottom portion for full window, or full image if pre-cropped ROI)
    const isPreCropped = (videoH < 450);
    const minRoiH = Math.min(videoH, Math.max(320, Math.floor(videoH * 0.35)));
    const roiH = isPreCropped ? videoH : minRoiH;
    const roiY = isPreCropped ? 0 : (videoH - roiH);
    const roiData = offscreenCtx.getImageData(0, roiY, videoW, roiH);

    // 1. Detect EXP Bar
    const expRes = expDetector.detect(roiData, videoW, videoH);

    // 2. Detect Hotbar
    const uiScale = expRes.success ? (expRes.scale || 1.0) : 1.0;
    const hotbarRes = hotbarDetector.detect(roiData, uiScale);

    if (expRes.success) {
      const expVal = expRes.exp_value;
      const expPct = expRes.exp_pct;
      const barPct = expRes.bar_pct;

      tracker.addSample(expVal, expPct, barPct);

      latestDetection.status = 'LOCKED';
      latestDetection.details = `${videoW}x${videoH} @ ${expRes.scale.toFixed(2)}x UI`;
      latestDetection.scale = expRes.scale;
      latestDetection.expVal = expVal;
      latestDetection.expPct = expPct;
      latestDetection.barPct = barPct;

      updateStatus('LOCKED', latestDetection.details, 'locked');
      updateExpHeroUI(expVal, expPct);

      if (expRes.crop_data) {
        updateExpCropPreview(expRes.crop_data, expRes.raw_text);
      }
    } else {
      if (latestDetection.status !== 'LOCKED') {
        updateStatus('SEARCHING', expRes.reason || 'Scanning for EXP bar...', 'searching');
      }
    }

    // Hotbar Results
    if (hotbarRes.success) {
      latestDetection.hotbarFound = true;
      latestDetection.quantities = hotbarRes.quantities;
      updateHotbarGridUI(hotbarRes.cells);
      checkAlerts();
    } else {
      latestDetection.hotbarFound = false;
      checkAlerts();
    }

    // Update Session & Window Statistics
    updateAllStatsUI();
    renderPipOverlay();

    // 1 Hz interval
    setTimeout(processFrame, 1000);
  }

  // Check Item Low-Quantity Alerts
  function checkAlerts() {
    if (!latestDetection.hotbarFound) {
      setRedAlert(false);
      return;
    }

    const alertCells = [];
    for (const [key, cfg] of Object.entries(cellAlerts)) {
      if (!cfg.enabled) continue;
      const qty = latestDetection.quantities[key];
      const effQty = (qty === null || qty === undefined) ? 0 : qty;
      if (effQty < cfg.threshold) {
        const [r, c] = key.split(',').map(Number);
        alertCells.push({ key, row: r, col: c, name: KEY_NAMES[r][c], qty: effQty, threshold: cfg.threshold });
      }
    }

    // Highlight cells
    for (const [key, el] of Object.entries(cellButtons)) {
      const isAlerting = alertCells.some(a => a.key === key);
      el.classList.toggle('alerting', isAlerting);
    }

    if (alertCells.length > 0) {
      latestDetection.alertActive = true;
      latestDetection.alertCells = alertCells;
      const names = alertCells.map(a => `${a.name} (${a.qty} < ${a.threshold})`).join(', ');
      alertBannerText.textContent = `🚨 LOW ITEM WARNING: ${names}`;
      setRedAlert(true);
      playAlertChime();
    } else {
      latestDetection.alertActive = false;
      latestDetection.alertCells = [];
      setRedAlert(false);
    }
  }

  function setRedAlert(active) {
    body.classList.toggle('red-alert-active', active);
    if (active) {
      statusDot.className = 'status-dot alert';
    } else if (latestDetection.status === 'LOCKED') {
      statusDot.className = 'status-dot locked';
    } else {
      statusDot.className = 'status-dot searching';
    }
  }

  // Update Status Bar
  function updateStatus(state, details, dotClass) {
    latestDetection.status = state;
    latestDetection.details = details;
    statusText.textContent = state;
    statusDetails.textContent = details;
    statusDot.className = `status-dot ${dotClass}`;
  }

  // Update Current EXP UI
  function updateExpHeroUI(expVal, expPct) {
    expHeroNum.textContent = expVal.toLocaleString();
    expHeroPct.textContent = `[${expPct.toFixed(2)}%]`;
    expBarFill.style.width = `${Math.min(100, Math.max(0, expPct))}%`;
  }

  // Update EXP Crop Drawer Preview
  function updateExpCropPreview(cropData, rawText) {
    expCropCanvas.width = cropData.width;
    expCropCanvas.height = cropData.height;
    expCropCtx.putImageData(new ImageData(cropData.data, cropData.width, cropData.height), 0, 0);
    expOcrDebug.textContent = `Raw OCR: ${rawText}`;
  }

  previewToggle.addEventListener('click', () => {
    const isShown = previewContent.style.display === 'flex';
    previewContent.style.display = isShown ? 'none' : 'flex';
    previewToggle.textContent = isShown ? '▶ Show Live EXP Bar Crop' : '▼ Hide Live EXP Bar Crop';
  });

  // Update Hotbar Cells
  function updateHotbarGridUI(cells) {
    if (!cells) return;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < cells[r].length; c++) {
        const item = cells[r][c];
        const key = `${r},${c}`;
        const cvs = cellCanvases[key];
        const lbl = cellQtyLabels[key];

        if (cvs && item.norm_crop_data) {
          const ctx = cvs.getContext('2d');
          ctx.putImageData(
            new ImageData(item.norm_crop_data.data, item.norm_crop_data.width, item.norm_crop_data.height),
            0, 0
          );
        }

        if (lbl) {
          lbl.textContent = item.quantity !== null ? item.quantity : '';
        }
      }
    }
  }

  // Update Window & Session Stats
  function updateAllStatsUI() {
    latestDetection.windows = {
      '1m': tracker.getWindowGain(60),
      '5m': tracker.getWindowGain(300),
      '10m': tracker.getWindowGain(600),
      '30m': tracker.getWindowGain(1800),
      '1h': tracker.getWindowGain(3600)
    };

    // Update Multi-Window Table Overview
    for (const winKey of ['1m', '5m', '10m', '30m', '1h']) {
      const win = latestDetection.windows[winKey];
      if (!win) continue;
      const expEl = document.getElementById(`statRowGainExp-${winKey}`);
      const pctEl = document.getElementById(`statRowGainPct-${winKey}`);
      const rateEl = document.getElementById(`statRowRateExp-${winKey}`);

      if (expEl) expEl.textContent = `+${win.gained_exp.toLocaleString()}`;
      if (pctEl) pctEl.textContent = `+${win.gained_pct.toFixed(2)}%`;
      if (rateEl) rateEl.textContent = `${win.exp_rate_hr.toLocaleString()} / hr`;

      drawMiniSparkline(winKey, win.slices, win.max_slice);
    }

    updateWindowStatsUI();

    const session = tracker.getSessionStats();
    const durSec = session.session_duration;
    const h = Math.floor(durSec / 3600).toString().padStart(2, '0');
    const m = Math.floor((durSec % 3600) / 60).toString().padStart(2, '0');
    const s = (durSec % 60).toString().padStart(2, '0');

    statSessionDuration.textContent = `${h}:${m}:${s}`;
    statSessionGainedExp.textContent = `+${session.total_gained_exp.toLocaleString()}`;
    statSessionGainedPct.textContent = `+${session.total_gained_pct.toFixed(2)}%`;
    statSessionRateExp.textContent = `${session.session_rate_hr.toLocaleString()} / hr`;
    statSessionRatePct.textContent = `${session.session_pct_rate_hr.toFixed(2)}% / hr`;

    if (session.eta_seconds !== null && session.eta_seconds > 0) {
      const etaH = Math.floor(session.eta_seconds / 3600);
      const etaM = Math.floor((session.eta_seconds % 3600) / 60);
      statSessionEta.textContent = `ETA: ${etaH}h ${etaM}m to next level`;
    } else {
      statSessionEta.textContent = 'ETA: Calculating...';
    }

    statSessionLevelUps.textContent = `+${session.level_ups}`;
    statSessionAnomalies.textContent = session.anomalies_corrected;
  }

  function updateWindowStatsUI() {
    const win = latestDetection.windows[selectedWindow];
    if (!win) return;

    if (detailedGraphTitle) {
      detailedGraphTitle.textContent = `📈 Sliding EXP Rate (${selectedWindow} Window)`;
    }
    if (statGraphPeak) {
      statGraphPeak.textContent = `Peak: +${win.max_slice.toLocaleString()} EXP`;
    }
    if (statGraphAvg) {
      statGraphAvg.textContent = `Avg: ${(win.avg_slice || 0).toFixed(1)} EXP/s`;
    }
    if (statGraphRate) {
      statGraphRate.textContent = `Rate: ${win.exp_rate_hr.toLocaleString()} / hr`;
    }
  }

  // Draw 80x20 Mini Sparkline for Multi-Window Table Rows
  function drawMiniSparkline(key, slices, maxVal) {
    const cvs = document.getElementById(`miniSparkline-${key}`);
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    const w = cvs.width = 80;
    const h = cvs.height = 20;

    ctx.clearRect(0, 0, w, h);
    if (!slices || slices.length === 0 || maxVal <= 0) {
      ctx.fillStyle = '#22252a';
      ctx.fillRect(0, h - 2, w, 1);
      return;
    }

    const n = slices.length;
    const stepX = w / (n - 1);
    const effH = h - 4;

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const y = h - 2 - (slices[i] / maxVal) * effH;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = key === selectedWindow ? 'rgba(56, 189, 248, 0.28)' : 'rgba(56, 189, 248, 0.12)';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const y = h - 2 - (slices[i] / maxVal) * effH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = key === selectedWindow ? '#38bdf8' : '#60a5fa';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Sliding Chart Engine
  let slidingMaxY = 50;
  let animLoopRunning = false;
  let hoverChartPos = null;

  function getNiceMax(val) {
    if (val <= 10) return 10;
    if (val <= 50) return 50;
    if (val <= 100) return 100;
    const exp = Math.pow(10, Math.floor(Math.log10(val)));
    const frac = val / exp;
    if (frac <= 1) return exp;
    if (frac <= 2) return 2 * exp;
    if (frac <= 5) return 5 * exp;
    return 10 * exp;
  }

  function formatTimeShort(sec) {
    sec = Math.round(sec);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }

  function drawSlidingChart() {
    const w = sparklineCanvas.width = sparklineCanvas.clientWidth || 360;
    const h = sparklineCanvas.height = 90;

    const padTop = 14;
    const padBottom = 16;
    const padLeft = 8;
    const padRight = 8;
    const effW = Math.max(10, w - padLeft - padRight);
    const effH = Math.max(10, h - padTop - padBottom);

    sparklineCtx.clearRect(0, 0, w, h);

    const now = Date.now() / 1000;
    const winSec = WINDOW_SEC[selectedWindow] || 300;
    const tStart = now - winSec;

    // Filter valid samples
    const cleanSamples = tracker.history.filter(s => !s.is_outlier && s.timestamp >= tStart - 60 && s.timestamp <= now + 2);

    // Build discrete fixed-second gains map
    const secGains = {};
    for (const s of cleanSamples) {
      if (s.delta_exp > 0) {
        const sec = Math.floor(s.timestamp);
        secGains[sec] = (secGains[sec] || 0) + s.delta_exp;
      }
    }

    // Adaptive smoothing window
    let smoothSec = 3;
    if (winSec >= 3600) smoothSec = 30;
    else if (winSec >= 1800) smoothSec = 15;
    else if (winSec >= 600) smoothSec = 8;
    else if (winSec >= 300) smoothSec = 5;

    // Cache smoothed rate for visible integer seconds
    let peakVal = 0;
    const startSec = Math.floor(tStart);
    const endSec = Math.ceil(now);
    const smoothedSec = {};

    for (let s = startSec - smoothSec; s <= endSec + 1; s++) {
      let sum = 0;
      for (let k = 0; k < smoothSec; k++) {
        sum += (secGains[s - k] || 0);
      }
      const val = sum / smoothSec;
      smoothedSec[s] = val;
      if (s >= startSec && val > peakVal) {
        peakVal = val;
      }
    }

    // Smooth lerp Y-axis scale
    const targetMaxY = peakVal > 0 ? getNiceMax(peakVal * 1.25) : 50;
    slidingMaxY += (targetMaxY - slidingMaxY) * 0.08;
    if (slidingMaxY < 10) slidingMaxY = 10;

    // Draw horizontal dashed grid lines (0, 50%, 100%)
    sparklineCtx.lineWidth = 1;
    sparklineCtx.setLineDash([3, 4]);

    const gridLines = [
      { ratio: 1.0, label: `+${Math.round(slidingMaxY).toLocaleString()}` },
      { ratio: 0.5, label: `+${Math.round(slidingMaxY * 0.5).toLocaleString()}` },
      { ratio: 0.0, label: '0' }
    ];

    for (const gl of gridLines) {
      const y = padTop + effH * (1.0 - gl.ratio);
      sparklineCtx.strokeStyle = '#22252a';
      sparklineCtx.beginPath();
      sparklineCtx.moveTo(padLeft, y);
      sparklineCtx.lineTo(padLeft + effW, y);
      sparklineCtx.stroke();

      if (gl.ratio > 0 && peakVal > 0) {
        sparklineCtx.fillStyle = '#6b7280';
        sparklineCtx.font = '9px monospace';
        sparklineCtx.textAlign = 'right';
        sparklineCtx.fillText(gl.label, padLeft + effW - 4, y - 2);
      }
    }

    // Draw vertical time marker guides (-winKey, -half, Now)
    const timeMarks = [
      { ratio: 0.0, label: `-${selectedWindow}` },
      { ratio: 0.5, label: `-${formatTimeShort(winSec / 2)}` },
      { ratio: 1.0, label: 'Now' }
    ];

    for (const tm of timeMarks) {
      const x = padLeft + tm.ratio * effW;
      sparklineCtx.strokeStyle = '#22252a';
      sparklineCtx.beginPath();
      sparklineCtx.moveTo(x, padTop);
      sparklineCtx.lineTo(x, padTop + effH);
      sparklineCtx.stroke();

      sparklineCtx.fillStyle = '#6b7280';
      sparklineCtx.font = '9px monospace';
      sparklineCtx.textAlign = tm.ratio === 0 ? 'left' : (tm.ratio === 1 ? 'right' : 'center');
      sparklineCtx.fillText(tm.label, x, h - 3);
    }
    sparklineCtx.setLineDash([]);

    // If no EXP has been gained yet
    if (cleanSamples.length < 2 || peakVal <= 0) {
      sparklineCtx.fillStyle = '#4b5563';
      sparklineCtx.font = 'italic 11px sans-serif';
      sparklineCtx.textAlign = 'center';
      sparklineCtx.fillText('Live sliding battle analysis (awaiting EXP gains...)', w / 2, padTop + effH / 2 + 4);

      sparklineCtx.strokeStyle = '#2d3748';
      sparklineCtx.beginPath();
      sparklineCtx.moveTo(padLeft, padTop + effH);
      sparklineCtx.lineTo(padLeft + effW, padTop + effH);
      sparklineCtx.stroke();
      return;
    }

    // Build the curve points across screen width
    const numSteps = Math.min(240, Math.max(80, Math.floor(effW / 2)));
    const points = [];

    for (let i = 0; i <= numSteps; i++) {
      const ratio = i / numSteps;
      const x = padLeft + ratio * effW;
      const t = tStart + ratio * winSec;

      const s0 = Math.floor(t);
      const frac = t - s0;
      const v0 = smoothedSec[s0] || 0;
      const v1 = smoothedSec[s0 + 1] || 0;
      const val = v0 + (v1 - v0) * frac;

      const y = padTop + effH * (1.0 - Math.min(1.0, Math.max(0.0, val / slidingMaxY)));
      points.push({ x, y, val, t });
    }

    // Shaded gradient area under the sliding line
    const gradient = sparklineCtx.createLinearGradient(0, padTop, 0, padTop + effH);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    gradient.addColorStop(0.8, 'rgba(56, 189, 248, 0.05)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    sparklineCtx.beginPath();
    sparklineCtx.moveTo(points[0].x, padTop + effH);
    for (let i = 0; i < points.length; i++) {
      sparklineCtx.lineTo(points[i].x, points[i].y);
    }
    sparklineCtx.lineTo(points[points.length - 1].x, padTop + effH);
    sparklineCtx.closePath();
    sparklineCtx.fillStyle = gradient;
    sparklineCtx.fill();

    // Line curve with glow
    sparklineCtx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) sparklineCtx.moveTo(points[i].x, points[i].y);
      else sparklineCtx.lineTo(points[i].x, points[i].y);
    }
    sparklineCtx.strokeStyle = '#38bdf8';
    sparklineCtx.lineWidth = 2;
    sparklineCtx.shadowColor = '#38bdf8';
    sparklineCtx.shadowBlur = 5;
    sparklineCtx.stroke();
    sparklineCtx.shadowBlur = 0;

    // Leading edge pulse dot at current time "Now" (x = padLeft + effW)
    const lastPt = points[points.length - 1];
    sparklineCtx.beginPath();
    sparklineCtx.arc(lastPt.x, lastPt.y, 3.5, 0, Math.PI * 2);
    sparklineCtx.fillStyle = '#38bdf8';
    sparklineCtx.fill();
    sparklineCtx.strokeStyle = '#ffffff';
    sparklineCtx.lineWidth = 1.5;
    sparklineCtx.stroke();

    // Hover crosshair & interactive tooltip
    if (hoverChartPos && hoverChartPos.x >= padLeft && hoverChartPos.x <= padLeft + effW) {
      const hx = hoverChartPos.x;
      const ratio = (hx - padLeft) / effW;
      const tHover = tStart + ratio * winSec;
      const s0 = Math.floor(tHover);
      const frac = tHover - s0;
      const v0 = smoothedSec[s0] || 0;
      const v1 = smoothedSec[s0 + 1] || 0;
      const hVal = v0 + (v1 - v0) * frac;
      const hy = padTop + effH * (1.0 - Math.min(1.0, Math.max(0.0, hVal / slidingMaxY)));

      // Vertical line
      sparklineCtx.strokeStyle = '#f1c40f';
      sparklineCtx.lineWidth = 1;
      sparklineCtx.setLineDash([2, 3]);
      sparklineCtx.beginPath();
      sparklineCtx.moveTo(hx, padTop);
      sparklineCtx.lineTo(hx, padTop + effH);
      sparklineCtx.stroke();
      sparklineCtx.setLineDash([]);

      // Circle marker
      sparklineCtx.beginPath();
      sparklineCtx.arc(hx, hy, 4, 0, Math.PI * 2);
      sparklineCtx.fillStyle = '#f1c40f';
      sparklineCtx.fill();
      sparklineCtx.strokeStyle = '#ffffff';
      sparklineCtx.lineWidth = 1.5;
      sparklineCtx.stroke();

      const secAgo = Math.max(0, Math.round(now - tHover));
      const hrRate = Math.round(hVal * 3600);
      sparklineTooltip.style.display = 'block';
      sparklineTooltip.innerHTML = `-${formatTimeShort(secAgo)}: <strong>+${Math.round(hVal).toLocaleString()} EXP/s</strong> (${hrRate.toLocaleString()}/hr)`;
    }
  }

  function startSlidingChartLoop() {
    if (animLoopRunning) return;
    animLoopRunning = true;
    function anim() {
      if (activeTab === 'exp') {
        drawSlidingChart();
      }
      requestAnimationFrame(anim);
    }
    requestAnimationFrame(anim);
  }

  // Sparkline Interactive Tooltip & Crosshair
  sparklineCanvas.addEventListener('mousemove', (e) => {
    const rect = sparklineCanvas.getBoundingClientRect();
    hoverChartPos = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  });

  sparklineCanvas.addEventListener('mouseleave', () => {
    hoverChartPos = null;
    sparklineTooltip.style.display = 'none';
  });

  // Picture-in-Picture Floating Overlay
  function renderPipOverlay() {
    const w = pipCanvas.width = 360;
    const h = pipCanvas.height = 190;

    const isAlert = latestDetection.alertActive;
    pipCtx.fillStyle = isAlert ? '#4a1515' : '#141517';
    pipCtx.fillRect(0, 0, w, h);

    // Title bar
    pipCtx.fillStyle = isAlert ? '#ef4444' : '#ffcc00';
    pipCtx.font = 'bold 15px sans-serif';
    pipCtx.fillText('🍁 MapleEXP Tracker', 12, 22);

    if (isAlert) {
      pipCtx.fillStyle = '#fca5a5';
      pipCtx.font = 'bold 11px sans-serif';
      pipCtx.fillText('🚨 LOW ITEM WARNING!', 200, 22);
    }

    // Current EXP & %
    pipCtx.fillStyle = '#ffffff';
    pipCtx.font = 'bold 24px monospace';
    pipCtx.fillText(latestDetection.expVal.toLocaleString(), 12, 54);

    pipCtx.fillStyle = '#ffcc00';
    pipCtx.font = 'bold 18px monospace';
    pipCtx.fillText(`[${latestDetection.expPct.toFixed(2)}%]`, 240, 54);

    // EXP Bar
    pipCtx.fillStyle = '#000000';
    pipCtx.fillRect(12, 66, w - 24, 12);
    pipCtx.fillStyle = '#ffcc00';
    const fillW = Math.max(0, Math.min(w - 24, ((w - 24) * latestDetection.expPct) / 100));
    pipCtx.fillRect(12, 66, fillW, 12);

    // Hourly Rate & Window Gain
    const win = latestDetection.windows['5m'] || tracker.getWindowGain(300);
    pipCtx.fillStyle = '#949ba4';
    pipCtx.font = '11px sans-serif';
    pipCtx.fillText('5m Rate:', 12, 102);

    pipCtx.fillStyle = '#22c55e';
    pipCtx.font = 'bold 13px monospace';
    pipCtx.fillText(`${win.exp_rate_hr.toLocaleString()} / hr`, 70, 102);

    pipCtx.fillStyle = '#949ba4';
    pipCtx.font = '11px sans-serif';
    pipCtx.fillText('Session Gain:', 12, 124);

    pipCtx.fillStyle = '#f2f3f5';
    pipCtx.font = 'bold 13px monospace';
    pipCtx.fillText(`+${tracker.totalGainedExp.toLocaleString()}`, 100, 124);

    // Monitored Item Status
    const monKey = `${selectedCell[0]},${selectedCell[1]}`;
    const monKeyName = KEY_NAMES[selectedCell[0]][selectedCell[1]];
    const monQty = latestDetection.quantities[monKey];

    pipCtx.fillStyle = '#1e1f22';
    pipCtx.fillRect(12, 138, w - 24, 42);

    pipCtx.fillStyle = '#dbdee1';
    pipCtx.font = '12px sans-serif';
    pipCtx.fillText(`Monitored Slot [${monKeyName}]:`, 20, 163);

    pipCtx.fillStyle = (monQty !== null && monQty !== undefined && monQty < (cellAlerts[monKey].threshold || 20)) ? '#ef4444' : '#ffcc00';
    pipCtx.font = 'bold 18px monospace';
    pipCtx.fillText(monQty !== null && monQty !== undefined ? `${monQty} left` : 'No data', 240, 165);
  }

  btnPip.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        btnPip.innerHTML = '📌 Float (PiP)';
        return;
      }

      renderPipOverlay();
      const pipStream = pipCanvas.captureStream(5);
      pipVideo.srcObject = pipStream;
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();

      btnPip.innerHTML = '📌 Exit PiP';
      pipVideo.addEventListener('leavepictureinpicture', () => {
        btnPip.innerHTML = '📌 Float (PiP)';
      }, { once: true });
    } catch (err) {
      alert('Picture-in-Picture error: ' + err.message);
    }
  });

  // Footer Controls
  btnPause.addEventListener('click', () => {
    isPaused = !isPaused;
    tracker.isPaused = isPaused;
    btnPause.innerHTML = isPaused ? '▶ Resume' : '⏸ Pause';
    if (isPaused) {
      updateStatus('PAUSED', 'Tracking paused', 'paused');
    }
  });

  btnReset.addEventListener('click', () => {
    if (confirm('Reset tracking session data?')) {
      tracker.reset();
      expDetector.resetLock();
      hotbarDetector.resetLock();
      updateExpHeroUI(0, 0.0);
      updateAllStatsUI();
      updateStatus('WAITING', 'Session reset. Re-calibrating...', 'searching');
    }
  });

  btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    btnMute.innerHTML = isMuted ? '🔇 Unmute' : '🔊 Sound On';
    saveInputsToStorage();
  });

  btnExport.addEventListener('click', () => {
    const cleanSamples = tracker.history.filter(s => !s.is_outlier);
    let csv = 'Timestamp,EXP_Value,EXP_Percentage,Delta_EXP,Delta_Percentage\n';
    for (const s of cleanSamples) {
      const dateStr = new Date(s.timestamp * 1000).toISOString();
      csv += `${dateStr},${s.exp_val},${s.exp_pct},${s.delta_exp},${s.delta_pct}\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MapleStory_EXP_Session_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // File Drag & Drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (re) => {
          const img = new Image();
          img.onload = () => {
            offscreenCanvas.width = img.width;
            offscreenCanvas.height = img.height;
            offscreenCtx.drawImage(img, 0, 0);

            const isPreCropped = (img.height < 450);
            const roiH = isPreCropped ? img.height : Math.floor(img.height * 0.28);
            const roiY = isPreCropped ? 0 : (img.height - roiH);
            const roiData = offscreenCtx.getImageData(0, roiY, img.width, roiH);

            const expRes = expDetector.detect(roiData, img.width, img.height);
            const hotbarRes = hotbarDetector.detect(roiData, expRes.scale || 1.0);

            if (expRes.success) {
              tracker.addSample(expRes.exp_value, expRes.exp_pct, expRes.bar_pct);
              latestDetection.status = 'LOCKED';
              latestDetection.details = `Dropped Image: ${img.width}x${img.height} @ ${expRes.scale}x`;
              latestDetection.scale = expRes.scale;
              latestDetection.expVal = expRes.exp_value;
              latestDetection.expPct = expRes.exp_pct;

              updateStatus('LOCKED', latestDetection.details, 'locked');
              updateExpHeroUI(expRes.exp_value, expRes.exp_pct);
              if (expRes.crop_data) updateExpCropPreview(expRes.crop_data, expRes.raw_text);
            }

            if (hotbarRes.success) {
              latestDetection.hotbarFound = true;
              latestDetection.quantities = hotbarRes.quantities;
              updateHotbarGridUI(hotbarRes.cells);
              checkAlerts();
            }

            updateAllStatsUI();
            renderPipOverlay();
          };
          img.src = re.target.result;
        };
        reader.readAsDataURL(file);
      }
    }
  });

  // Initialize
  initHotbarDOM();
  btnMute.innerHTML = isMuted ? '🔇 Unmute' : '🔊 Sound On';
  selectWindow(selectedWindow);
  updateAllStatsUI();
  startSlidingChartLoop();
  processFrame();
})();

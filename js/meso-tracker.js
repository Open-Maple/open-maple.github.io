/**
 * MapleEXP Tracker - Meso Tracking Engine
 * Accurately tracks meso gains, rolling rates (1m, 5m, 10m, 30m, 1h), sparkline distributions,
 * session analytics, multi-frame dropout immunity, and transient OCR spike buffering.
 */

class MesoSample {
  constructor(timestamp, mesoVal, deltaMeso = 0, isOutlier = false) {
    this.timestamp = timestamp;
    this.meso_val = mesoVal;
    this.delta_meso = deltaMeso;
    this.is_outlier = isOutlier;
  }
}

class MesoTracker {
  constructor(maxHistorySeconds = 3700) {
    this.maxHistorySeconds = maxHistorySeconds;
    this.history = []; // Array of MesoSample
    this.sessionStartTime = null;
    this.sessionInitialMeso = null;
    this.totalGainedMeso = 0;
    this.totalSpentMeso = 0;
    this.lastSample = null;
    this.isPaused = false;
    this.anomaliesCorrected = 0;

    // Multi-frame drop immunity state: { anchorSample, dropSamples: [], timeoutStart }
    this._dropState = null;

    // Pending spike buffer: { spikeSample, prevSample, spikeDMeso }
    this._pendingSpike = null;
  }

  get total_gained_meso() { return this.totalGainedMeso; }
  get total_spent_meso() { return this.totalSpentMeso; }
  get net_meso() {
    if (this.lastSample === null || this.sessionInitialMeso === null) return 0;
    return this.lastSample.meso_val - this.sessionInitialMeso;
  }
  get anomalies_corrected() { return this.anomaliesCorrected; }
  get session_start_time() { return this.sessionStartTime; }
  set session_start_time(val) { this.sessionStartTime = val; }
  get last_sample() { return this.lastSample; }
  set last_sample(val) { this.lastSample = val; }

  reset() {
    this.history = [];
    this.sessionStartTime = null;
    this.sessionInitialMeso = null;
    this.totalGainedMeso = 0;
    this.totalSpentMeso = 0;
    this.lastSample = null;
    this.anomaliesCorrected = 0;
    this._dropState = null;
    this._pendingSpike = null;
  }

  _commitSample(sample, deltaMeso) {
    if (deltaMeso > 0) {
      this.totalGainedMeso += deltaMeso;
    } else if (deltaMeso < 0) {
      this.totalSpentMeso += Math.abs(deltaMeso);
    }

    sample.delta_meso = deltaMeso;
    this.lastSample = sample;
    this.history.push(sample);

    // Prune old samples beyond max history cutoff
    const cutoff = sample.timestamp - this.maxHistorySeconds;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
  }

  addSample(mesoVal) {
    if (this.isPaused || mesoVal === null || mesoVal === undefined || isNaN(mesoVal)) {
      return;
    }

    mesoVal = Math.round(mesoVal);
    if (mesoVal < 0) return;

    const now = Date.now() / 1000;
    const sample = new MesoSample(now, mesoVal, 0);

    // Initialize session on first valid sample
    if (this.sessionStartTime === null) {
      this.sessionStartTime = now;
      this.sessionInitialMeso = mesoVal;
      sample.delta_meso = 0;
      this.lastSample = sample;
      this.history.push(sample);
      return;
    }

    // 1. Resolve multi-frame drop state (temporary OCR glitch vs real spending)
    if (this._dropState !== null) {
      const { anchorSample, dropSamples, timeoutStart } = this._dropState;

      // Did current reading recover near or above pre-drop baseline?
      const recovered = (mesoVal >= anchorSample.meso_val * 0.95 || mesoVal >= anchorSample.meso_val - 500);

      if (recovered) {
        // OCR drop was a glitch: discard all dropped samples
        this.anomaliesCorrected += dropSamples.length;
        this._dropState = null;

        const dMeso = Math.max(0, mesoVal - anchorSample.meso_val);
        this._commitSample(sample, dMeso);
        this.sanitizeHistory();
        return;
      }

      // Buffer for up to 6 seconds or 6 frames
      if (now - timeoutStart < 6.0 && dropSamples.length < 6) {
        dropSamples.push(sample);
        return;
      } else {
        // Sustained drop confirmed: user spent mesos (bought pots, scrolls, taxi)
        this._dropState = null;
        const dMeso = mesoVal - anchorSample.meso_val;
        this._commitSample(sample, dMeso);
        this.sanitizeHistory();
        return;
      }
    }

    // 2. Resolve pending spike buffer (unfeasible sudden jump confirmation)
    if (this._pendingSpike !== null) {
      const { spikeSample, prevSample, spikeDMeso } = this._pendingSpike;
      this._pendingSpike = null;

      // Check if this new sample dropped back down near prevSample baseline
      const reverted = (mesoVal <= prevSample.meso_val * 1.05 && mesoVal <= prevSample.meso_val + 5000);

      if (reverted) {
        // The spike was an OCR glitch! Discard spikeSample
        this.anomaliesCorrected += 1;
        const dMeso = Math.max(0, mesoVal - prevSample.meso_val);
        this._commitSample(sample, dMeso);
        this.sanitizeHistory();
        return;
      } else {
        // The spike stayed high (legitimate big trade or sale)
        this._commitSample(spikeSample, spikeDMeso);
        const dMeso = mesoVal - spikeSample.meso_val;
        this._commitSample(sample, dMeso);
        this.sanitizeHistory();
        return;
      }
    }

    const prev = this.lastSample;
    if (prev !== null) {
      const deltaMeso = mesoVal - prev.meso_val;

      // Check for sudden drop
      if (deltaMeso < 0) {
        // If small drop (< 1,000) or user was at 0, process immediately
        if (Math.abs(deltaMeso) < 1000) {
          this._commitSample(sample, deltaMeso);
          return;
        }

        // Suspicious drop: enter drop immunity state
        this._dropState = { anchorSample: prev, dropSamples: [sample], timeoutStart: now };
        return;
      }

      // Check if sudden positive jump is physically unfeasible for 1 second of mob grinding
      // (e.g. > 200,000 in a single frame unless confirmed next frame)
      const isSuspiciousSpike = (prev.meso_val > 1000 && deltaMeso > 200000);
      if (isSuspiciousSpike) {
        this._pendingSpike = { spikeSample: sample, prevSample: prev, spikeDMeso: deltaMeso };
        return;
      }

      // Normal progression
      this._commitSample(sample, deltaMeso);
      this.sanitizeHistory();
      return;
    }

    sample.delta_meso = 0;
    this.lastSample = sample;
    this.history.push(sample);

    const cutoff = now - this.maxHistorySeconds;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
  }

  // Alias for snake_case python compatibility
  add_sample(mesoVal) {
    return this.addSample(mesoVal);
  }

  sanitizeHistory() {
    if (this.history.length < 3) return 0;

    const n = this.history.length;
    let anomaliesFound = 0;

    // Pass 1: Scan for transient spikes
    for (let i = 1; i < n - 1; i++) {
      const sCurr = this.history[i];
      if (sCurr.is_outlier) continue;

      let sPrev = null;
      for (let p = i - 1; p >= 0; p--) {
        if (!this.history[p].is_outlier) {
          sPrev = this.history[p];
          break;
        }
      }
      if (!sPrev) continue;

      const dVal = sCurr.meso_val - sPrev.meso_val;
      const isSpike = (dVal > 150000 && sPrev.meso_val > 5000);

      if (isSpike) {
        let reverted = false;
        for (let k = i + 1; k < Math.min(n, i + 8); k++) {
          const sAhead = this.history[k];
          if (sAhead.is_outlier) continue;
          if (sAhead.meso_val <= sPrev.meso_val * 1.05 && sAhead.meso_val <= sPrev.meso_val + 5000) {
            reverted = true;
            break;
          }
        }

        if (reverted) {
          sCurr.is_outlier = true;
          sCurr.delta_meso = 0;
          anomaliesFound++;
        }
      }
    }

    // Pass 2: Scan for transient dips
    for (let i = 1; i < n - 1; i++) {
      const sCurr = this.history[i];
      if (sCurr.is_outlier) continue;

      let sPrev = null;
      for (let p = i - 1; p >= 0; p--) {
        if (!this.history[p].is_outlier) {
          sPrev = this.history[p];
          break;
        }
      }
      if (!sPrev) continue;

      const dVal = sCurr.meso_val - sPrev.meso_val;
      if (dVal < -2000) {
        let recovered = false;
        for (let k = i + 1; k < Math.min(n, i + 8); k++) {
          const sAhead = this.history[k];
          if (sAhead.is_outlier) continue;
          if (sAhead.meso_val >= sPrev.meso_val * 0.95 || sAhead.meso_val >= sPrev.meso_val - 500) {
            recovered = true;
            break;
          }
        }

        if (recovered) {
          sCurr.is_outlier = true;
          sCurr.delta_meso = 0;
          anomaliesFound++;
        }
      }
    }

    if (anomaliesFound > 0) {
      this.anomaliesCorrected += anomaliesFound;
      this._recalculateTotalsFromHistory();
    }

    return anomaliesFound;
  }

  _recalculateTotalsFromHistory() {
    let newTotalGain = 0;
    let newTotalSpent = 0;
    let lastValid = null;

    for (const s of this.history) {
      if (s.is_outlier) {
        s.delta_meso = 0;
        continue;
      }

      if (lastValid === null) {
        s.delta_meso = 0;
        lastValid = s;
        continue;
      }

      const dMeso = s.meso_val - lastValid.meso_val;
      s.delta_meso = dMeso;

      if (dMeso > 0) {
        newTotalGain += dMeso;
      } else if (dMeso < 0) {
        newTotalSpent += Math.abs(dMeso);
      }

      lastValid = s;
    }

    this.totalGainedMeso = newTotalGain;
    this.totalSpentMeso = newTotalSpent;
  }

  getWindowGain(windowSeconds, numSlices = 128) {
    this.sanitizeHistory();

    const emptySlices = new Array(numSlices).fill(0.0);
    const sliceSec = numSlices > 0 ? (windowSeconds / numSlices) : 1.0;

    const cleanSamples = this.history.filter(s => !s.is_outlier);
    if (cleanSamples.length < 2) {
      return {
        gained_meso: 0,
        meso_rate_hr: 0,
        data_duration: 0,
        slices: emptySlices,
        slice_duration: Math.round(sliceSec * 100) / 100,
        max_slice: 0.0,
        avg_slice: 0.0
      };
    }

    const now = Date.now() / 1000;
    const targetTime = now - windowSeconds;

    let baseSample = null;
    let startIdx = 0;
    for (let i = 0; i < cleanSamples.length; i++) {
      if (cleanSamples[i].timestamp >= targetTime) {
        baseSample = cleanSamples[i];
        startIdx = i;
        break;
      }
    }

    if (!baseSample) {
      baseSample = cleanSamples[0];
      startIdx = 0;
    }

    const curr = cleanSamples[cleanSamples.length - 1];
    const elapsed = curr.timestamp - baseSample.timestamp;

    let gainedMeso = 0;
    for (let i = startIdx; i < cleanSamples.length - 1; i++) {
      const s2 = cleanSamples[i + 1];
      let dMeso = s2.delta_meso;
      if (dMeso === undefined || dMeso === null) {
        const s1 = cleanSamples[i];
        dMeso = Math.max(0, s2.meso_val - s1.meso_val);
      }
      if (dMeso > 0) gainedMeso += dMeso;
    }

    const effectiveElapsed = Math.max(3.0, elapsed);
    const rateMultiplier = 3600.0 / effectiveElapsed;
    const rawRateHr = Math.round(gainedMeso * rateMultiplier);
    const mesoRateHr = Math.min(2000000000, Math.max(0, rawRateHr));

    // Compute slices for graph
    const slices = new Array(numSlices).fill(0.0);
    const tStart = now - windowSeconds;
    const deltaT = numSlices > 0 ? (windowSeconds / numSlices) : 1.0;

    const scanStart = Math.max(0, startIdx - 1);
    for (let i = scanStart; i < cleanSamples.length - 1; i++) {
      const s1 = cleanSamples[i];
      const s2 = cleanSamples[i + 1];
      const t1 = s1.timestamp;
      const t2 = s2.timestamp;
      let dMeso = s2.delta_meso;
      if (dMeso === undefined || dMeso === null) {
        dMeso = Math.max(0, s2.meso_val - s1.meso_val);
      }

      if (dMeso <= 0 || t2 <= tStart || t1 >= now || t2 <= t1) {
        continue;
      }

      const effT1 = Math.max(t1, tStart);
      const effT2 = Math.min(t2, now);
      const rate = dMeso / (t2 - t1);

      const kStart = Math.max(0, Math.min(numSlices - 1, Math.floor((effT1 - tStart) / deltaT)));
      const kEnd = Math.max(0, Math.min(numSlices - 1, Math.floor((effT2 - tStart) / deltaT)));

      for (let k = kStart; k <= kEnd; k++) {
        const sliceT1 = tStart + k * deltaT;
        const sliceT2 = sliceT1 + deltaT;
        const overlap = Math.max(0.0, Math.min(effT2, sliceT2) - Math.max(effT1, sliceT1));
        slices[k] += rate * overlap;
      }
    }

    const roundedSlices = slices.map(x => Math.round(x * 10) / 10);
    const maxSlice = Math.round((slices.length ? Math.max(...slices) : 0.0) * 10) / 10;
    const sumSlices = slices.reduce((a, b) => a + b, 0);
    const avgSlice = Math.round((slices.length ? (sumSlices / numSlices) : 0.0) * 10) / 10;

    return {
      gained_meso: gainedMeso,
      meso_rate_hr: mesoRateHr,
      data_duration: Math.floor(elapsed),
      slices: roundedSlices,
      slice_duration: Math.round(sliceSec * 100) / 100,
      max_slice: maxSlice,
      avg_slice: avgSlice
    };
  }

  getSessionStats() {
    this.sanitizeHistory();

    if (this.lastSample === null || this.sessionStartTime === null) {
      return {
        current_meso: 0,
        initial_meso: 0,
        session_duration: 0,
        total_gained_meso: 0,
        total_spent_meso: 0,
        net_meso: 0,
        session_rate_hr: 0,
        anomalies_corrected: 0
      };
    }

    const now = Date.now() / 1000;
    const duration = Math.max(1.0, now - this.sessionStartTime);
    const effectiveDuration = Math.max(3.0, duration);
    const rateMult = 3600.0 / effectiveDuration;

    const sessionRateHr = Math.min(2000000000, Math.round(this.totalGainedMeso * rateMult));
    const netMeso = (this.lastSample.meso_val || 0) - (this.sessionInitialMeso || 0);

    return {
      current_meso: this.lastSample.meso_val,
      initial_meso: this.sessionInitialMeso,
      session_duration: Math.floor(duration),
      total_gained_meso: this.totalGainedMeso,
      total_spent_meso: this.totalSpentMeso,
      net_meso: netMeso,
      session_rate_hr: sessionRateHr,
      anomalies_corrected: this.anomaliesCorrected
    };
  }
}

// Support Node.js CommonJS, ES module, and browser window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MesoTracker, MesoSample };
}
if (typeof window !== 'undefined') {
  window.MesoTracker = MesoTracker;
  window.MesoSample = MesoSample;
}

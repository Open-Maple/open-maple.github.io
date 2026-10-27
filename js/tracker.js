/**
 * MapleEXP Tracker - Core Experience Tracking Engine
 * Accurately tracks EXP gains, rates (1m, 5m, 10m, 30m, 1h), sparkline distributions,
 * level-up detection, character death handling, multi-frame dropout immunity,
 * transient OCR spike buffering, and retroactive history sanitization.
 */

class ExpSample {
  constructor(timestamp, expVal, expPct, barPct = null, deltaExp = 0, deltaPct = 0.0, isOutlier = false, isLevelUp = false) {
    this.timestamp = timestamp;
    this.exp_val = expVal;
    this.exp_pct = expPct;
    this.bar_pct = barPct;
    this.delta_exp = deltaExp;
    this.delta_pct = deltaPct;
    this.is_outlier = isOutlier;
    this.is_level_up = isLevelUp;
  }
}

class ExpTracker {
  constructor(maxHistorySeconds = 3700) {
    this.maxHistorySeconds = maxHistorySeconds;
    this.history = []; // Array of ExpSample
    this.sessionStartTime = null;
    this.sessionInitialExp = null;
    this.sessionInitialPct = null;
    this.totalGainedExp = 0;
    this.totalGainedPct = 0.0;
    this.lastSample = null;
    this.levelUps = 0;
    this.isPaused = false;
    this.anomaliesCorrected = 0;

    // Multi-frame drop immunity state: { anchorSample, dropSamples: [], timeoutStart }
    this._dropState = null;

    // Pending spike buffer: { spikeSample, prevSample, dExp, dPct }
    this._pendingSpike = null;

    // Pending level-up buffer: { candSample, prevSample, estDExp, estDPct }
    this._pendingLvl = null;
  }

  // Getters for python-matching property names
  get total_gained_exp() { return this.totalGainedExp; }
  get total_gained_pct() { return this.totalGainedPct; }
  get level_ups() { return this.levelUps; }
  get anomalies_corrected() { return this.anomaliesCorrected; }
  get session_start_time() { return this.sessionStartTime; }
  set session_start_time(val) { this.sessionStartTime = val; }
  get last_sample() { return this.lastSample; }
  set last_sample(val) { this.lastSample = val; }

  reset() {
    this.history = [];
    this.sessionStartTime = null;
    this.sessionInitialExp = null;
    this.sessionInitialPct = null;
    this.totalGainedExp = 0;
    this.totalGainedPct = 0.0;
    this.lastSample = null;
    this.levelUps = 0;
    this.anomaliesCorrected = 0;
    this._dropState = null;
    this._pendingSpike = null;
    this._pendingLvl = null;
  }

  _commitSample(sample, deltaExp, deltaPct, isLevelUp = false) {
    if (isLevelUp) {
      this.levelUps += 1;
      sample.is_level_up = true;
    }
    if (deltaExp > 0) {
      this.totalGainedExp += deltaExp;
    }
    if (deltaPct > 0) {
      this.totalGainedPct = Math.round((this.totalGainedPct + deltaPct) * 100) / 100;
    }

    sample.delta_exp = deltaExp;
    sample.delta_pct = Math.round(deltaPct * 100) / 100;

    this.lastSample = sample;
    this.history.push(sample);

    // Prune old samples beyond max history cutoff
    const cutoff = sample.timestamp - this.maxHistorySeconds;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
  }

  addSample(expVal, expPct, barPct = null) {
    if (this.isPaused || expVal === null || expVal === undefined) {
      return;
    }

    // Optical bar inconsistency check: if both text pct and graphical bar pct are detected,
    // reject wild divergences (> 25%) as transient OCR noise
    if (expPct !== null && barPct !== null && Math.abs(expPct - barPct) > 25.0) {
      return;
    }

    const now = Date.now() / 1000;
    const sample = new ExpSample(now, expVal, expPct, barPct);

    // Initialize session on first valid non-zero sample
    if (this.sessionStartTime === null) {
      if (expVal === 0 && (expPct === null || expPct === 0.0) && barPct === null) {
        return;
      }
      this.sessionStartTime = now;
      this.sessionInitialExp = expVal;
      this.sessionInitialPct = expPct !== null ? expPct : 0.0;
      sample.delta_exp = 0;
      sample.delta_pct = 0.0;
      this.lastSample = sample;
      this.history.push(sample);
      return;
    }

    // 1. Resolve pending level-up buffer
    if (this._pendingLvl !== null) {
      const { candSample, anchorPrev, estDExp, estDPct } = this._pendingLvl;
      this._pendingLvl = null;

      // Check if this new sample reverted back near anchorPrev (meaning not a real level up)
      const reverted = (
        expVal >= anchorPrev.exp_val * 0.95 &&
        (anchorPrev.exp_pct === null || expPct === null || expPct >= anchorPrev.exp_pct - 2.0)
      );

      if (reverted) {
        // Glitch artifact confirmed: discard candSample
        this.anomaliesCorrected += 1;
        const prev = anchorPrev;
        const dExp = expVal - prev.exp_val;
        const dPct = (expPct !== null && prev.exp_pct !== null) ? (expPct - prev.exp_pct) : 0.0;
        if (dExp >= 0) {
          this._commitSample(sample, dExp, dPct, false);
        }
        return;
      } else {
        // Level up confirmed!
        this._commitSample(candSample, estDExp, estDPct, true);
        const prev = candSample;
        const dExp = expVal - prev.exp_val;
        const dPct = (expPct !== null && prev.exp_pct !== null) ? (expPct - prev.exp_pct) : 0.0;
        if (dExp >= 0) {
          this._commitSample(sample, dExp, dPct, false);
        }
        return;
      }
    }

    // 2. Resolve multi-frame drop state (black screen / portal transition immunity)
    if (this._dropState !== null) {
      const { anchorSample, dropSamples, timeoutStart } = this._dropState;

      // Did current sample return near the pre-drop anchor baseline?
      const valOk = (expVal >= anchorSample.exp_val * 0.95 || expVal >= anchorSample.exp_val - 100);
      const pctOk = (anchorSample.exp_pct === null || expPct === null || expPct >= anchorSample.exp_pct - 2.0);

      if (valOk && pctOk) {
        // Screen transition complete! Current reading is back at real baseline.
        // All dropSamples were transition artifacts: discard them completely!
        this.anomaliesCorrected += dropSamples.length;
        this._dropState = null;

        // Process current sample against the pre-drop anchor baseline
        const dExp = Math.max(0, expVal - anchorSample.exp_val);
        const dPct = (expPct !== null && anchorSample.exp_pct !== null)
          ? Math.max(0.0, expPct - anchorSample.exp_pct)
          : 0.0;
        this._commitSample(sample, dExp, dPct, false);
        this.sanitizeHistory();
        return;
      }

      // Still in drop state: buffer for up to 10 seconds or 10 frames
      if (now - timeoutStart < 10.0 && dropSamples.length < 10) {
        dropSamples.push(sample);
        return;
      } else {
        // Drop timed out (> 10s sustained lower EXP): real relog / character switch
        this._dropState = null;
        sample.delta_exp = 0;
        sample.delta_pct = 0.0;
        this.lastSample = sample;
        this.history.push(sample);
        this.sanitizeHistory();
        return;
      }
    }

    // 3. Resolve pending spike buffer (unfeasible sudden jump verification)
    if (this._pendingSpike !== null) {
      const { spikeSample, prevSample, spikeDExp, spikeDPct } = this._pendingSpike;
      this._pendingSpike = null;

      // Check if this new sample dropped back down near prevSample baseline
      const reverted = (
        expVal <= prevSample.exp_val * 1.05 &&
        (prevSample.exp_pct === null || expPct === null || expPct <= prevSample.exp_pct + 1.0)
      );

      if (reverted) {
        // The spike was an OCR glitch! Discard spikeSample completely.
        this.anomaliesCorrected += 1;
        const dExp = Math.max(0, expVal - prevSample.exp_val);
        const dPct = (expPct !== null && prevSample.exp_pct !== null)
          ? Math.max(0.0, expPct - prevSample.exp_pct)
          : 0.0;
        this._commitSample(sample, dExp, dPct, false);
        this.sanitizeHistory();
        return;
      } else {
        // The spike stayed high (legitimate massive quest reward or boss kill)
        this._commitSample(spikeSample, spikeDExp, spikeDPct, false);
        const dExp = Math.max(0, expVal - spikeSample.exp_val);
        const dPct = (expPct !== null && spikeSample.exp_pct !== null)
          ? Math.max(0.0, expPct - spikeSample.exp_pct)
          : 0.0;
        this._commitSample(sample, dExp, dPct, false);
        this.sanitizeHistory();
        return;
      }
    }

    // Check for change since last sample
    const prev = this.lastSample;
    if (prev !== null) {
      const deltaExp = expVal - prev.exp_val;
      const deltaPct = (expPct !== null && prev.exp_pct !== null) ? (expPct - prev.exp_pct) : 0.0;

      if (deltaExp < 0) {
        // In MapleStory, you cannot level up unless previous percentage was near 100% (>= 80%).
        // And after leveling up, the new percentage resets to low (<= 25%).
        const isLegitLvl = (
          prev.exp_pct !== null && prev.exp_pct >= 80.0 &&
          expPct !== null && expPct <= 25.0
        );

        if (isLegitLvl) {
          let estDExp = 0;
          let estDPct = 0.0;
          if (prev.exp_pct > 0) {
            const estMax = Math.floor(prev.exp_val / (prev.exp_pct / 100.0));
            const gainedBeforeLvl = Math.max(0, estMax - prev.exp_val);
            estDExp = gainedBeforeLvl + expVal;
            estDPct = (100.0 - prev.exp_pct) + (expPct ? expPct : 0.0);
          } else {
            estDExp = expVal;
            estDPct = expPct ? expPct : 0.0;
          }

          // Buffer for 1-frame confirmation
          this._pendingLvl = { candSample: sample, anchorPrev: prev, estDExp, estDPct };
          return;
        }

        // Check if character death (Maple penalty loses 2% to 15%)
        const isDeath = (
          prev.exp_pct !== null && expPct !== null &&
          (prev.exp_pct - expPct) >= 2.0 && (prev.exp_pct - expPct) <= 15.0 &&
          expVal > 0
        );
        if (isDeath) {
          sample.delta_exp = 0;
          sample.delta_pct = 0.0;
          this.lastSample = sample;
          this.history.push(sample);
          return;
        }

        // Sudden drop that is neither level-up nor death: start drop immunity state
        this._dropState = { anchorSample: prev, dropSamples: [sample], timeoutStart: now };
        return;
      }

      // Check if instantaneous positive jump is physically unfeasible
      const isSuspiciousSpike = (
        (prev.exp_val > 5000 && deltaExp > 50000 && deltaExp > prev.exp_val * 0.25) ||
        (deltaPct > 8.0)
      );
      if (isSuspiciousSpike) {
        this._pendingSpike = { spikeSample: sample, prevSample: prev, spikeDExp: deltaExp, spikeDPct: deltaPct };
        return;
      }

      // Normal progression
      this._commitSample(sample, deltaExp, deltaPct, false);
      this.sanitizeHistory();
      return;
    }

    sample.delta_exp = 0;
    sample.delta_pct = 0.0;
    this.lastSample = sample;
    this.history.push(sample);

    // Prune old samples
    const cutoff = now - this.maxHistorySeconds;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
  }

  // Alias for snake_case python compatibility
  add_sample(expVal, expPct, barPct = null) {
    return this.addSample(expVal, expPct, barPct);
  }

  sanitizeHistory() {
    if (this.history.length < 3) {
      return 0;
    }

    const n = this.history.length;
    let anomaliesFound = 0;

    // Pass 1: Scan for transient spikes (S[i] >> S[i-1] and S[i+k] returns to baseline)
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

      const dVal = sCurr.exp_val - sPrev.exp_val;
      const dPct = (sCurr.exp_pct !== null && sPrev.exp_pct !== null) ? (sCurr.exp_pct - sPrev.exp_pct) : 0.0;

      const isSpike = (
        (sPrev.exp_val > 5000 && dVal > 30000 && dVal > sPrev.exp_val * 0.20) ||
        (dPct > 6.0 && !sCurr.is_level_up) ||
        (dVal > 5000000)
      );

      if (isSpike) {
        let reverted = false;
        for (let k = i + 1; k < Math.min(n, i + 9); k++) {
          const sAhead = this.history[k];
          if (sAhead.is_outlier) continue;
          if (
            sAhead.exp_val <= sPrev.exp_val * 1.05 &&
            (sPrev.exp_pct === null || sAhead.exp_pct === null || sAhead.exp_pct <= sPrev.exp_pct + 1.5)
          ) {
            reverted = true;
            break;
          }
        }

        if (reverted) {
          sCurr.is_outlier = true;
          sCurr.delta_exp = 0;
          sCurr.delta_pct = 0.0;
          anomaliesFound++;
        }
      }
    }

    // Pass 2: Scan for transient dips (S[i] << S[i-1] and S[i+k] recovers)
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

      const dVal = sCurr.exp_val - sPrev.exp_val;
      const isLegitLvl = (
        sPrev.exp_pct !== null && sPrev.exp_pct >= 80.0 &&
        sCurr.exp_pct !== null && sCurr.exp_pct <= 25.0
      );

      if (dVal < 0 && !isLegitLvl) {
        let recovered = false;
        for (let k = i + 1; k < Math.min(n, i + 11); k++) {
          const sAhead = this.history[k];
          if (sAhead.is_outlier) continue;
          if (sAhead.exp_val >= sPrev.exp_val * 0.95 || sAhead.exp_val >= sPrev.exp_val - 100) {
            recovered = true;
            break;
          }
        }

        if (recovered) {
          sCurr.is_outlier = true;
          sCurr.delta_exp = 0;
          sCurr.delta_pct = 0.0;
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

  // Alias for python compatibility
  sanitize_history() {
    return this.sanitizeHistory();
  }

  _recalculateTotalsFromHistory() {
    let newTotalExp = 0;
    let newTotalPct = 0.0;
    let newLevelUps = 0;
    let lastValid = null;

    for (const s of this.history) {
      if (s.is_outlier) {
        s.delta_exp = 0;
        s.delta_pct = 0.0;
        continue;
      }

      if (lastValid === null) {
        s.delta_exp = 0;
        s.delta_pct = 0.0;
        lastValid = s;
        continue;
      }

      if (s.is_level_up) {
        newLevelUps += 1;
      } else {
        const dExp = Math.max(0, s.exp_val - lastValid.exp_val);
        const dPct = (s.exp_pct !== null && lastValid.exp_pct !== null)
          ? Math.max(0.0, s.exp_pct - lastValid.exp_pct)
          : 0.0;
        s.delta_exp = dExp;
        s.delta_pct = Math.round(dPct * 100) / 100;
      }

      if (s.delta_exp > 0) {
        newTotalExp += s.delta_exp;
      }
      if (s.delta_pct > 0) {
        newTotalPct = Math.round((newTotalPct + s.delta_pct) * 100) / 100;
      }

      lastValid = s;
    }

    this.totalGainedExp = newTotalExp;
    this.totalGainedPct = Math.round(newTotalPct * 100) / 100;
    this.levelUps = newLevelUps;
  }

  getWindowGain(windowSeconds, numSlices = 128) {
    this.sanitizeHistory();

    const emptySlices = new Array(numSlices).fill(0.0);
    const sliceSec = numSlices > 0 ? (windowSeconds / numSlices) : 1.0;

    const cleanSamples = this.history.filter(s => !s.is_outlier);
    if (cleanSamples.length < 2) {
      return {
        gained_exp: 0,
        gained_pct: 0.0,
        exp_rate_hr: 0,
        pct_rate_hr: 0.0,
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

    let gainedExp = 0;
    let gainedPct = 0.0;

    for (let i = startIdx; i < cleanSamples.length - 1; i++) {
      const s1 = cleanSamples[i];
      const s2 = cleanSamples[i + 1];
      let dExp = s2.delta_exp;
      let dPct = s2.delta_pct;

      if (dExp === undefined || dExp === null || dPct === undefined || dPct === null) {
        dExp = s2.exp_val - s1.exp_val;
        dPct = (s2.exp_pct !== null && s1.exp_pct !== null) ? (s2.exp_pct - s1.exp_pct) : 0.0;

        if (dExp < 0 && (s1.exp_pct !== null && s1.exp_pct >= 80.0 && (s2.exp_pct === null || s2.exp_pct <= 25.0))) {
          if (s1.exp_pct > 0) {
            const estMax = Math.floor(s1.exp_val / (s1.exp_pct / 100.0));
            dExp = Math.max(0, estMax - s1.exp_val) + s2.exp_val;
            dPct = (100.0 - s1.exp_pct) + (s2.exp_pct ? s2.exp_pct : 0.0);
          } else {
            dExp = s2.exp_val;
            dPct = s2.exp_pct ? s2.exp_pct : 0.0;
          }
        } else if (dExp < 0) {
          dExp = 0;
          dPct = 0.0;
        }
      }

      if (dExp > 0) gainedExp += dExp;
      if (dPct > 0) gainedPct += dPct;
    }

    const effectiveElapsed = Math.max(3.0, elapsed);
    const rateMultiplier = 3600.0 / effectiveElapsed;
    const rawExpRateHr = Math.round(gainedExp * rateMultiplier);
    const rawPctRateHr = Math.round(gainedPct * rateMultiplier * 100) / 100;

    const expRateHr = Math.min(2000000000, rawExpRateHr);
    const pctRateHr = Math.min(2000.0, rawPctRateHr);

    // Compute 128 slices for rolling graph
    const slices = new Array(numSlices).fill(0.0);
    const tStart = now - windowSeconds;
    const deltaT = numSlices > 0 ? (windowSeconds / numSlices) : 1.0;

    const scanStart = Math.max(0, startIdx - 1);
    for (let i = scanStart; i < cleanSamples.length - 1; i++) {
      const s1 = cleanSamples[i];
      const s2 = cleanSamples[i + 1];
      const t1 = s1.timestamp;
      const t2 = s2.timestamp;
      let dExp = s2.delta_exp;
      if (dExp === undefined || dExp === null) {
        dExp = Math.max(0, s2.exp_val - s1.exp_val);
      }

      if (dExp <= 0 || t2 <= tStart || t1 >= now || t2 <= t1) {
        continue;
      }

      const effT1 = Math.max(t1, tStart);
      const effT2 = Math.min(t2, now);
      const rate = dExp / (t2 - t1);

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
      gained_exp: gainedExp,
      gained_pct: Math.round(gainedPct * 100) / 100,
      exp_rate_hr: expRateHr,
      pct_rate_hr: pctRateHr,
      data_duration: Math.floor(elapsed),
      slices: roundedSlices,
      slice_duration: Math.round(sliceSec * 100) / 100,
      max_slice: maxSlice,
      avg_slice: avgSlice
    };
  }

  // Alias for snake_case python compatibility
  get_window_gain(windowSeconds, numSlices = 128) {
    return this.getWindowGain(windowSeconds, numSlices);
  }

  getSessionStats() {
    this.sanitizeHistory();

    if (this.lastSample === null || this.sessionStartTime === null) {
      return {
        current_exp: 0,
        current_pct: 0.0,
        bar_pct: null,
        session_duration: 0,
        total_gained_exp: 0,
        total_gained_pct: 0.0,
        session_rate_hr: 0,
        session_pct_rate_hr: 0.0,
        eta_seconds: null,
        level_ups: 0,
        anomalies_corrected: 0
      };
    }

    const now = Date.now() / 1000;
    const duration = Math.max(1.0, now - this.sessionStartTime);
    const effectiveDuration = Math.max(3.0, duration);
    const rateMult = 3600.0 / effectiveDuration;

    const sessionRateHr = Math.min(2000000000, Math.round(this.totalGainedExp * rateMult));
    const sessionPctRateHr = Math.min(2000.0, Math.round(this.totalGainedPct * rateMult * 100) / 100);

    let etaSeconds = null;
    const currPct = this.lastSample.exp_pct;
    if (currPct !== null && currPct < 100.0) {
      const remainingPct = 100.0 - currPct;
      const w5 = this.getWindowGain(300);
      const effectivePctRate = w5.pct_rate_hr > 0 ? w5.pct_rate_hr : sessionPctRateHr;

      if (effectivePctRate > 0.01) {
        const etaHours = remainingPct / effectivePctRate;
        etaSeconds = Math.floor(etaHours * 3600);
      }
    }

    return {
      current_exp: this.lastSample.exp_val,
      current_pct: this.lastSample.exp_pct !== null ? this.lastSample.exp_pct : 0.0,
      bar_pct: this.lastSample.bar_pct,
      session_duration: Math.floor(duration),
      total_gained_exp: this.totalGainedExp,
      total_gained_pct: Math.round(this.totalGainedPct * 100) / 100,
      session_rate_hr: sessionRateHr,
      session_pct_rate_hr: sessionPctRateHr,
      eta_seconds: etaSeconds,
      level_ups: this.levelUps,
      anomalies_corrected: this.anomaliesCorrected
    };
  }

  // Alias for python compatibility
  get_session_stats() {
    return this.getSessionStats();
  }
}

// Support Node.js CommonJS, ES module, and browser window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExpTracker, ExpSample };
}
if (typeof window !== 'undefined') {
  window.ExpTracker = ExpTracker;
  window.ExpSample = ExpSample;
}

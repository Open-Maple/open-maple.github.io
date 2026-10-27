/**
 * MapleEXP Tracker - EXP Detector
 * Calibrates scale, locks onto EXP logo anchor, performs pixel-font OCR on text crop,
 * and measures graphical yellow bar fill with cross-validation.
 */

class ExpDetector {
  constructor(cvEngine = null, tmplImageData = null) {
    this.engine = cvEngine || new (typeof CVEngine !== 'undefined' ? CVEngine : require('./cv-engine.js').CVEngine)();

    // Embedded template dimension (29x13 at 1.0x scale)
    this.tmplW = 29;
    this.tmplH = 13;
    this.tmplData = tmplImageData;

    // Load templates from environment
    const templates = (typeof CHAR_PATTERNS !== 'undefined')
      ? { CHAR_PATTERNS }
      : require('./templates.js');

    this.charTmpls = [];
    for (const [char, pat] of Object.entries(templates.CHAR_PATTERNS)) {
      const variants = (pat.length > 0 && Array.isArray(pat[0])) ? pat : [pat];
      for (const v of variants) {
        const boolGrid = v.map(row => row.split('').map(c => c === '#'));
        this.charTmpls.push({ char, grid: boolGrid, h: boolGrid.length, w: boolGrid[0].length });
      }
    }

    // State
    this.isLocked = false;
    this.lockedScale = 1.0;
    this.lockedLoc = { x: 0, y: 0 };
    this.lockedClientSize = { w: 0, h: 0 };
    this.consecutiveMisses = 0;
  }

  setTemplateData(tmplData) {
    this.tmplData = tmplData;
    this.tmplW = tmplData.width;
    this.tmplH = tmplData.height;
  }

  resetLock() {
    this.isLocked = false;
    this.consecutiveMisses = 0;
  }

  calibrate(roiData) {
    if (!this.tmplData) {
      return { found: false, loc: { x: 0, y: 0 }, scale: 1.0, conf: 0 };
    }

    const roiW = roiData.width;
    const roiH = roiData.height;

    let bestVal = -1;
    let bestScale = 1.0;
    let bestLoc = { x: 0, y: 0 };

    // The EXP bar is at the bottom of the window. Restrict search to bottom half of ROI.
    const searchStartY = Math.max(0, Math.floor(roiH * 0.4));
    const searchPad = { x: 0, y: searchStartY, w: roiW, h: roiH - searchStartY };

    // Test scales from 0.6x to 2.5x
    const scales = [];
    for (let s = 0.6; s <= 2.5001; s += 0.05) {
      scales.push(Math.round(s * 100) / 100);
    }

    for (const s of scales) {
      const sw = Math.max(5, Math.floor(this.tmplW * s));
      const sh = Math.max(3, Math.floor(this.tmplH * s));
      if (sw > roiW || sh > roiH) continue;

      const res = this.engine.matchTemplate(roiData, this.tmplData, searchPad, s);
      if (res.maxVal > bestVal) {
        bestVal = res.maxVal;
        bestScale = s;
        bestLoc = res.maxLoc;
      }
    }

    if (bestVal >= 0.75) {
      this.isLocked = true;
      this.lockedScale = bestScale;
      this.lockedLoc = bestLoc;
      this.consecutiveMisses = 0;
      return { found: true, loc: bestLoc, scale: bestScale, conf: bestVal };
    }

    this.isLocked = false;
    return { found: false, loc: { x: 0, y: 0 }, scale: 1.0, conf: bestVal };
  }

  detect(roiData, clientW, clientH) {
    if (!roiData || roiData.width === 0 || roiData.height === 0) {
      return { success: false, reason: 'Empty frame' };
    }

    const roiW = roiData.width;
    const roiH = roiData.height;

    // Detect black frame / dark map transition screen
    const stats = this.engine.calculateStats(roiData);
    if (stats.mean < 30.0 || stats.max < 65 || stats.std < 12.0) {
      return { success: false, reason: 'Screen is black (map transition / loading)' };
    }

    // Re-calibrate if window size changed
    if (clientW !== this.lockedClientSize.w || clientH !== this.lockedClientSize.h || !this.isLocked) {
      this.lockedClientSize = { w: clientW, h: clientH };
      const calib = this.calibrate(roiData);
      if (!calib.found) {
        return { success: false, reason: `EXP bar not found (score ${calib.conf.toFixed(2)})` };
      }
    } else {
      // Fast-track: verify cached position with small search window (+- 25px)
      const lx = this.lockedLoc.x;
      const ly = this.lockedLoc.y;
      const s = this.lockedScale;
      const sw = Math.max(5, Math.floor(this.tmplW * s));
      const sh = Math.max(3, Math.floor(this.tmplH * s));

      const searchPad = 25;
      const x1 = Math.max(0, lx - searchPad);
      const y1 = Math.max(0, ly - searchPad);
      const x2 = Math.min(roiW, lx + sw + searchPad);
      const y2 = Math.min(roiH, ly + sh + searchPad);

      const subW = x2 - x1;
      const subH = y2 - y1;

      if (subH >= sh && subW >= sw) {
        const searchPadRegion = { x: x1, y: y1, w: subW, h: subH };
        const res = this.engine.matchTemplate(roiData, this.tmplData, searchPadRegion, s);
        if (res.maxVal >= 0.70) {
          this.lockedLoc = res.maxLoc;
          this.consecutiveMisses = 0;
        } else {
          this.consecutiveMisses++;
        }
      } else {
        this.consecutiveMisses++;
      }

      if (this.consecutiveMisses > 2) {
        const calib = this.calibrate(roiData);
        if (!calib.found) {
          return { success: false, reason: 'Lost track of EXP bar' };
        }
      } else if (this.consecutiveMisses > 0) {
        return { success: false, reason: 'EXP logo match below threshold' };
      }
    }

    const expX = this.lockedLoc.x;
    const expY = this.lockedLoc.y;
    const s = this.lockedScale;

    // Crop the text line immediately following the EXP logo
    const textX = expX + Math.floor(this.tmplW * s);
    const textW = Math.floor(125 * s);
    const textH = Math.floor(14 * s);

    if (textX + textW > roiW || expY + textH > roiH || expY < 0 || textX < 0) {
      return { success: false, reason: 'Crop out of bounds' };
    }

    const textCrop = this.engine.crop(roiData, textX, expY, textW, textH);

    // Verify text crop illumination and contrast
    const cropStats = this.engine.calculateStats(textCrop);
    if (cropStats.mean < 25.0 || cropStats.max < 150 || cropStats.std < 12.0) {
      return { success: false, reason: 'EXP text crop too dim or low contrast (transition)' };
    }

    // Normalize text crop to 1.0x scale
    let normCrop = textCrop;
    if (Math.abs(s - 1.0) > 0.05) {
      const normW = Math.max(10, Math.round(textW / s));
      const normH = Math.max(5, Math.round(textH / s));
      normCrop = this.engine.resize(textCrop, normW, normH);
    }

    // Binarize text (white & lime-green text is bright: gray > 125)
    const normW = normCrop.width;
    const normH = normCrop.height;
    const normData = normCrop.data;
    const binGrid = [];

    for (let y = 0; y < normH; y++) {
      const row = new Uint8Array(normW);
      for (let x = 0; x < normW; x++) {
        const idx = (y * normW + x) * 4;
        const gray = Math.round(normData[idx] * 0.299 + normData[idx + 1] * 0.587 + normData[idx + 2] * 0.114);
        row[x] = gray > 125 ? 1 : 0;
      }
      binGrid.push(row);
    }

    // Segment characters by vertical projection (columns)
    const hasPixel = new Array(normW).fill(false);
    for (let x = 0; x < normW; x++) {
      for (let y = 0; y < normH; y++) {
        if (binGrid[y][x] === 1) {
          hasPixel[x] = true;
          break;
        }
      }
    }

    const segments = [];
    let inChar = false;
    let startX = 0;
    for (let i = 0; i < normW; i++) {
      if (hasPixel[i] && !inChar) {
        inChar = true;
        startX = i;
      } else if (!hasPixel[i] && inChar) {
        inChar = false;
        segments.push([startX, i]);
      }
    }
    if (inChar) {
      segments.push([startX, normW]);
    }

    // Character matcher helper
    const matchChar = (sX, eX) => {
      const segW = eX - sX;
      // Find row span with active pixels
      let rStart = -1, rEnd = -1;
      for (let y = 0; y < normH; y++) {
        let rowHasPx = false;
        for (let x = sX; x < eX; x++) {
          if (binGrid[y][x] === 1) {
            rowHasPx = true;
            break;
          }
        }
        if (rowHasPx) {
          if (rStart === -1) rStart = y;
          rEnd = y;
        }
      }

      if (rStart === -1) return '';
      const ch = rEnd - rStart + 1;
      const cw = segW;

      let bestC = '?';
      let bestDiff = 9999;

      for (const tmpl of this.charTmpls) {
        const th = tmpl.h;
        const tw = tmpl.w;
        if (Math.abs(ch - th) <= 1 && Math.abs(cw - tw) <= 1) {
          const maxH = Math.max(ch, th);
          const maxW = Math.max(cw, tw);
          let diff = 0;

          for (let r = 0; r < maxH; r++) {
            for (let c = 0; c < maxW; c++) {
              const charPx = (r < ch && c < cw) ? (binGrid[rStart + r][sX + c] === 1) : false;
              const tmplPx = (r < th && c < tw) ? tmpl.grid[r][c] : false;
              if (charPx !== tmplPx) diff++;
            }
          }

          if (diff < bestDiff) {
            bestDiff = diff;
            bestC = tmpl.char;
          }
        }
      }

      if (bestDiff > 3) return '?';
      return bestC;
    };

    const recognized = [];
    for (const [sX, eX] of segments) {
      const ch = matchChar(sX, eX);
      if (ch === '?') {
        return { success: false, reason: 'Unrecognized character or noise artifact in EXP text' };
      }
      recognized.push(ch);
      if (ch === ']') break;
    }

    const rawStr = recognized.join('');

    // Parse number and percentage: e.g. 10,869[37.51%]
    let expVal = null;
    let expPct = null;
    let m = rawStr.match(/([\d,]+)\s*\[\s*([\d\.]+)\s*%?\s*\]?/);
    if (!m) {
      m = rawStr.match(/([\d,]+)\s*\[?\s*([\d\.]+)\s*%/);
    }

    if (m) {
      const parsedVal = parseInt(m[1].replace(/,/g, ''), 10);
      const parsedPct = parseFloat(m[2]);
      if (!isNaN(parsedVal) && !isNaN(parsedPct) && parsedPct >= 0.0 && parsedPct <= 100.0 && parsedVal >= 0) {
        expVal = parsedVal;
        expPct = parsedPct;
      }
    }

    // Measure yellow bar fill directly underneath
    const barY = expY + Math.floor(14 * s);
    const barH = Math.floor(12 * s);
    const barW = Math.floor(140 * s);

    let barPct = null;
    if (barY + barH <= roiH && expX + barW <= roiW) {
      const barCrop = this.engine.crop(roiData, expX, barY, barW, barH);
      if (barCrop.height >= 3 && barCrop.width >= 20) {
        const midRowY = Math.floor(barCrop.height / 2);
        const bData = barCrop.data;
        const bW = barCrop.width;

        let yCount = 0;
        let gCount = 0;

        for (let x = 0; x < bW; x++) {
          const idx = (midRowY * bW + x) * 4;
          const r = bData[idx];
          const g = bData[idx + 1];
          const b = bData[idx + 2];

          const isYellow = (r > 150 && g > 180 && b < 80);
          const isGray = (Math.abs(r - g) < 20 && b > 130 && b < 230);

          if (isYellow) yCount++;
          else if (isGray) gCount++;
        }

        if (yCount + gCount >= Math.floor(15 * s)) {
          barPct = Math.round((yCount / (yCount + gCount)) * 10000) / 100;
        }
      }
    }

    let valid = (expVal !== null);
    if (valid && barPct !== null && expPct !== null) {
      if (Math.abs(expPct - barPct) > 25.0) {
        valid = false;
      }
    }

    return {
      success: valid,
      exp_value: expVal,
      exp_pct: expPct,
      bar_pct: barPct,
      raw_text: rawStr,
      scale: Math.round(s * 100) / 100,
      pos: { x: expX, y: expY },
      crop_data: textCrop
    };
  }
}

// Exports
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExpDetector };
}
if (typeof window !== 'undefined') {
  window.ExpDetector = ExpDetector;
}

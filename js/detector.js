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

    // The EXP bar is along the bottom of the window. Restrict search to bottom 85% of ROI.
    const searchStartY = Math.max(0, Math.floor(roiH * 0.15));
    const searchPad = { x: 0, y: searchStartY, w: roiW, h: roiH - searchStartY };

    // Test priority common MapleStory & high-DPI UI scales first:
    // 1.0x (default), 1.25x, 1.33x, 1.5x, 1.75x, 2.0x, 2.25x, 2.5x, 3.0x, 3.5x, 4.0x, 0.8x, 0.67x
    const priorityScales = [1.0, 1.25, 1.33, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 3.5, 4.0, 0.8, 0.67];

    for (const s of priorityScales) {
      const sw = Math.round(this.tmplW * s);
      const sh = Math.round(this.tmplH * s);
      if (sw > roiW || sh > roiH) continue;

      const res = this.engine.matchTemplate(roiData, this.tmplData, searchPad, s, 2, 1);
      if (res.maxVal > bestVal) {
        bestVal = res.maxVal;
        bestScale = s;
        bestLoc = res.maxLoc;
        if (bestVal >= 0.78) break; // Strong priority hit!
      }
    }

    // If no priority scale had an immediate strong hit, sweep from 0.6x to 4.0x with step 0.10
    if (bestVal < 0.72) {
      for (let s = 0.6; s <= 4.001; s += 0.10) {
        const roundedS = Math.round(s * 100) / 100;
        if (priorityScales.includes(roundedS)) continue; // already tested
        const sw = Math.round(this.tmplW * roundedS);
        const sh = Math.round(this.tmplH * roundedS);
        if (sw > roiW || sh > roiH) continue;

        const res = this.engine.matchTemplate(roiData, this.tmplData, searchPad, roundedS, 2, 1);
        if (res.maxVal > bestVal) {
          bestVal = res.maxVal;
          bestScale = roundedS;
          bestLoc = res.maxLoc;
          if (bestVal >= 0.82) break;
        }
      }
    }

    // Fine-tune around best candidate (+-0.08 with step 0.02)
    if (bestVal >= 0.65) {
      const minS = Math.max(0.6, bestScale - 0.08);
      const maxS = Math.min(4.0, bestScale + 0.08);
      const finePad = {
        x: Math.max(0, bestLoc.x - Math.ceil(20 * bestScale)),
        y: Math.max(0, bestLoc.y - Math.ceil(15 * bestScale)),
        w: Math.min(roiW - Math.max(0, bestLoc.x - Math.ceil(20 * bestScale)), Math.ceil((this.tmplW + 40) * bestScale)),
        h: Math.min(roiH - Math.max(0, bestLoc.y - Math.ceil(15 * bestScale)), Math.ceil((this.tmplH + 30) * bestScale))
      };

      for (let s = minS; s <= maxS + 0.001; s += 0.02) {
        const roundedS = Math.round(s * 100) / 100;
        const sw = Math.round(this.tmplW * roundedS);
        const sh = Math.round(this.tmplH * roundedS);
        if (sw > roiW || sh > roiH) continue;

        const res = this.engine.matchTemplate(roiData, this.tmplData, finePad, roundedS, 1, 1);
        if (res.maxVal > bestVal) {
          bestVal = res.maxVal;
          bestScale = roundedS;
          bestLoc = res.maxLoc;
        }
      }

      if (bestVal >= 0.68) {
        this.isLocked = true;
        this.lockedScale = bestScale;
        this.lockedLoc = bestLoc;
        this.consecutiveMisses = 0;
        return { found: true, loc: bestLoc, scale: bestScale, conf: bestVal };
      }
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

    // Re-calibrate if window size changed or not locked
    if (clientW !== this.lockedClientSize.w || clientH !== this.lockedClientSize.h || !this.isLocked) {
      this.lockedClientSize = { w: clientW, h: clientH };
      const calib = this.calibrate(roiData);
      if (!calib.found) {
        return { success: false, reason: `EXP bar not found (score ${calib.conf.toFixed(2)})` };
      }
    } else {
      // Fast-track: verify cached position with adaptive search window
      const lx = this.lockedLoc.x;
      const ly = this.lockedLoc.y;
      const s = this.lockedScale;
      const sw = Math.max(5, Math.round(this.tmplW * s));
      const sh = Math.max(3, Math.round(this.tmplH * s));

      const searchPad = Math.max(25, Math.ceil(30 * s));
      const x1 = Math.max(0, lx - searchPad);
      const y1 = Math.max(0, ly - searchPad);
      const x2 = Math.min(roiW, lx + sw + searchPad);
      const y2 = Math.min(roiH, ly + sh + searchPad);

      const subW = x2 - x1;
      const subH = y2 - y1;

      if (subH >= sh && subW >= sw) {
        const searchPadRegion = { x: x1, y: y1, w: subW, h: subH };
        const res = this.engine.matchTemplate(roiData, this.tmplData, searchPadRegion, s, 1, 1);
        if (res.maxVal >= 0.62) {
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
    const textW = Math.min(Math.floor(135 * s), roiW - textX);
    const textH = Math.min(Math.floor(15 * s), roiH - expY);

    if (textX + Math.floor(40 * s) > roiW || expY + textH > roiH || expY < 0 || textX < 0 || textW < 20 || textH < 5) {
      return { success: false, reason: 'Crop out of bounds' };
    }

    const textCrop = this.engine.crop(roiData, textX, expY, textW, textH);

    // Verify text crop illumination and contrast
    const cropStats = this.engine.calculateStats(textCrop);
    if (cropStats.mean < 20.0 || cropStats.max < 130 || cropStats.std < 10.0) {
      return { success: false, reason: 'EXP text crop too dim or low contrast (transition)' };
    }

    // Binarize text directly at native resolution (white & lime-green text is bright: gray > 125)
    const tW = textCrop.width;
    const tH = textCrop.height;
    const tData = textCrop.data;
    const binGrid = [];

    for (let y = 0; y < tH; y++) {
      const row = new Uint8Array(tW);
      for (let x = 0; x < tW; x++) {
        const idx = (y * tW + x) * 4;
        const gray = Math.round(tData[idx] * 0.299 + tData[idx + 1] * 0.587 + tData[idx + 2] * 0.114);
        row[x] = gray > 125 ? 1 : 0;
      }
      binGrid.push(row);
    }

    // Segment characters by vertical projection (columns) at native scale
    const hasPixel = new Array(tW).fill(false);
    for (let x = 0; x < tW; x++) {
      for (let y = 0; y < tH; y++) {
        if (binGrid[y][x] === 1) {
          hasPixel[x] = true;
          break;
        }
      }
    }

    const segments = [];
    let inChar = false;
    let startX = 0;
    for (let i = 0; i < tW; i++) {
      if (hasPixel[i] && !inChar) {
        inChar = true;
        startX = i;
      } else if (!hasPixel[i] && inChar) {
        inChar = false;
        segments.push([startX, i]);
      }
    }
    if (inChar) {
      segments.push([startX, tW]);
    }

    // Normalized center-point sampling character matcher
    const matchChar = (sX, eX) => {
      const segW = eX - sX;
      // Find row span with active pixels
      let rStart = -1, rEnd = -1;
      let activePixels = 0;
      for (let y = 0; y < tH; y++) {
        let rowHasPx = false;
        for (let x = sX; x < eX; x++) {
          if (binGrid[y][x] === 1) {
            rowHasPx = true;
            activePixels++;
          }
        }
        if (rowHasPx) {
          if (rStart === -1) rStart = y;
          rEnd = y;
        }
      }

      // Ignore single dust pixel noise
      if (rStart === -1 || activePixels < Math.max(1, Math.floor(s * 0.8))) return '';
      const segH = rEnd - rStart + 1;

      let bestC = '?';
      let bestDiff = 9999;
      let bestScore = -1;

      for (const tmpl of this.charTmpls) {
        const th = tmpl.h;
        const tw = tmpl.w;
        const expW = tw * s;
        const expH = th * s;

        // Size check tolerance scaled with s
        if (Math.abs(segW - expW) > Math.max(3, 1.4 * s) || Math.abs(segH - expH) > Math.max(3, 1.4 * s)) {
          continue;
        }

        let diff = 0;
        let matches = 0;
        const total = th * tw;

        for (let tr = 0; tr < th; tr++) {
          const sr = Math.min(segH - 1, Math.floor((tr + 0.5) * segH / th));
          for (let tc = 0; tc < tw; tc++) {
            const sc = Math.min(segW - 1, Math.floor((tc + 0.5) * segW / tw));
            const charPx = (binGrid[rStart + sr][sX + sc] === 1);
            const tmplPx = tmpl.grid[tr][tc];
            if (charPx !== tmplPx) {
              diff++;
            } else {
              matches++;
            }
          }
        }

        const score = matches / total;
        if (diff < bestDiff) {
          bestDiff = diff;
          bestScore = score;
          bestC = tmpl.char;
        }
      }

      if (bestDiff > 4 && bestScore < 0.72) return '?';
      return bestC;
    };

    const recognized = [];
    for (const [sX, eX] of segments) {
      const ch = matchChar(sX, eX);
      if (ch === '') continue; // ignore tiny dust
      recognized.push(ch);
      if (ch === ']') break;
    }

    const rawStr = recognized.join('');

    // Parse number and percentage: e.g. 10,869[37.51%] or 10.869[37.51%]
    let expVal = null;
    let expPct = null;
    let m = rawStr.match(/([\d,\.]+)\s*\[\s*([\d\.]+)\s*%?\s*\]?/);
    if (!m) {
      m = rawStr.match(/([\d,\.]+)\s*\[?\s*([\d\.]+)\s*%/);
    }
    if (!m) {
      m = rawStr.match(/([\d,\.]+)/);
    }

    if (m) {
      const parsedVal = parseInt(m[1].replace(/[,.]/g, ''), 10);
      if (!isNaN(parsedVal) && parsedVal >= 0) {
        expVal = parsedVal;
      }
      if (m[2]) {
        const parsedPct = parseFloat(m[2]);
        if (!isNaN(parsedPct) && parsedPct >= 0.0 && parsedPct <= 100.0) {
          expPct = parsedPct;
        }
      }
    }

    // Measure yellow bar fill directly underneath with multi-row sampling
    const barY = expY + Math.floor(14 * s);
    const barH = Math.max(3, Math.floor(12 * s));
    const barW = Math.min(Math.floor(140 * s), roiW - expX);

    let barPct = null;
    if (barY + barH <= roiH && expX + Math.floor(20 * s) <= roiW) {
      const barCrop = this.engine.crop(roiData, expX, barY, barW, barH);
      if (barCrop.height >= 3 && barCrop.width >= 15) {
        const bW = barCrop.width;
        const bH = barCrop.height;
        const bData = barCrop.data;

        const midRowY = Math.floor(bH / 2);
        const rowsToTest = [midRowY];
        if (midRowY > 0) rowsToTest.push(midRowY - 1);
        if (midRowY < bH - 1) rowsToTest.push(midRowY + 1);

        let bestYellow = 0;
        let bestTotal = 0;

        for (const rowY of rowsToTest) {
          let yCount = 0;
          let gCount = 0;

          for (let x = 0; x < bW; x++) {
            const idx = (rowY * bW + x) * 4;
            const r = bData[idx];
            const g = bData[idx + 1];
            const b = bData[idx + 2];

            const isYellow = (r > 140 && g > 160 && b < 100);
            const isGray = (Math.abs(r - g) < 25 && b > 110 && b < 240);

            if (isYellow) yCount++;
            else if (isGray) gCount++;
          }

          if (yCount + gCount > bestTotal) {
            bestTotal = yCount + gCount;
            bestYellow = yCount;
          }
        }

        if (bestTotal >= Math.floor(15 * s)) {
          barPct = Math.round((bestYellow / bestTotal) * 10000) / 100;
        }
      }
    }

    let valid = (expVal !== null);
    if (valid && barPct !== null && expPct !== null) {
      if (Math.abs(expPct - barPct) > 25.0) {
        valid = false;
      }
    } else if (!valid && barPct !== null) {
      valid = true;
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

/**
 * MapleEXP Tracker - Meso Detector
 * Locates the Item Inventory meso counter, supports transparent inventory windows,
 * and performs pixel-exact OCR on meso digits with multi-scale calibration.
 */

class MesoDetector {
  constructor(cvEngine = null, mesoAnchorTmpl = null) {
    this.engine = cvEngine || new (typeof CVEngine !== 'undefined' ? CVEngine : require('./cv-engine.js').CVEngine)();

    // Meso anchor template (40x18 at 1.0x scale):
    // Covers the right border of the meso white input box and the word "MESOS"
    this.tmplW = 40;
    this.tmplH = 18;
    this.tmplData = mesoAnchorTmpl;

    // Load templates from environment
    const templates = (typeof MESO_CHAR_PATTERNS !== 'undefined')
      ? { MESO_CHAR_PATTERNS }
      : require('./templates.js');

    this.charTmpls = [];
    const patterns = templates.MESO_CHAR_PATTERNS || templates.CHAR_PATTERNS;
    for (const [char, pat] of Object.entries(patterns)) {
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

  calibrate(roiData, forcedScale = null) {
    if (!this.tmplData) {
      return { found: false, loc: { x: 0, y: 0 }, scale: 1.0, conf: 0 };
    }

    const roiW = roiData.width;
    const roiH = roiData.height;

    // Search sectors covering the entire window in order of probability:
    // 1. Top-Right quadrant (default inventory placement)
    // 2. Bottom-Right quadrant (above or beside hotbar / bottom dock)
    // 3. Top-Left quadrant
    // 4. Bottom-Left quadrant
    // 5. Full-Screen sweep fallback
    const sectors = [
      { name: 'Top-Right', x: Math.floor(roiW * 0.45), y: 0, w: Math.ceil(roiW * 0.55), h: Math.ceil(roiH * 0.60) },
      { name: 'Bottom-Right', x: Math.floor(roiW * 0.45), y: Math.floor(roiH * 0.40), w: Math.ceil(roiW * 0.55), h: Math.ceil(roiH * 0.60) },
      { name: 'Top-Left', x: 0, y: 0, w: Math.ceil(roiW * 0.55), h: Math.ceil(roiH * 0.60) },
      { name: 'Bottom-Left', x: 0, y: Math.floor(roiH * 0.40), w: Math.ceil(roiW * 0.55), h: Math.ceil(roiH * 0.60) },
      { name: 'Full-Screen', x: 0, y: 0, w: roiW, h: roiH }
    ];

    const scalesToTest = (forcedScale && forcedScale >= 0.5 && forcedScale <= 4.0)
      ? [forcedScale]
      : [1.0, 1.25, 1.33, 1.5, 1.75, 2.0, 0.8, 0.67];

    let bestVal = -1;
    let bestScale = 1.0;
    let bestLoc = { x: 0, y: 0 };

    for (const sec of sectors) {
      for (const s of scalesToTest) {
        const sw = Math.round(this.tmplW * s);
        const sh = Math.round(this.tmplH * s);
        if (sw > sec.w || sh > sec.h) continue;

        // Use optStepX=1, optStepY=1 so pixel font details at odd coordinates are never skipped
        const res = this.engine.matchTemplate(roiData, this.tmplData, sec, s, 1, 1);
        if (res.maxVal > bestVal) {
          bestVal = res.maxVal;
          bestScale = s;
          bestLoc = res.maxLoc;
          if (bestVal >= 0.68) break; // Strong hit in this sector
        }
      }
      if (bestVal >= 0.68) break; // Stop checking other sectors once found!
    }

    // Fine-tune around best candidate (+-0.06 with step 0.02)
    if (bestVal >= 0.54) {
      const minS = Math.max(0.6, bestScale - 0.06);
      const maxS = Math.min(4.0, bestScale + 0.06);
      const finePad = {
        x: Math.max(0, bestLoc.x - Math.ceil(25 * bestScale)),
        y: Math.max(0, bestLoc.y - Math.ceil(20 * bestScale)),
        w: Math.min(roiW - Math.max(0, bestLoc.x - Math.ceil(25 * bestScale)), Math.ceil((this.tmplW + 50) * bestScale)),
        h: Math.min(roiH - Math.max(0, bestLoc.y - Math.ceil(20 * bestScale)), Math.ceil((this.tmplH + 40) * bestScale))
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

      if (bestVal >= 0.54) {
        this.isLocked = true;
        this.lockedScale = bestScale;
        this.lockedLoc = bestLoc;
        this.lastConfidence = bestVal;
        this.consecutiveMisses = 0;
        return { found: true, loc: bestLoc, scale: bestScale, conf: bestVal };
      }
    }

    this.isLocked = false;
    return { found: false, loc: { x: 0, y: 0 }, scale: 1.0, conf: bestVal };
  }

  detect(roiData, clientW, clientH, forcedScale = null) {
    if (!roiData || roiData.width === 0 || roiData.height === 0) {
      return { success: false, reason: 'Empty frame' };
    }

    const roiW = roiData.width;
    const roiH = roiData.height;

    // Detect dark transition / map loading
    const stats = this.engine.calculateStats(roiData);
    if (stats.mean < 25.0 || stats.max < 60 || stats.std < 10.0) {
      return { success: false, reason: 'Screen is black (map transition / loading)' };
    }

    // Re-calibrate if window size changed or not locked
    if (clientW !== this.lockedClientSize.w || clientH !== this.lockedClientSize.h || !this.isLocked) {
      this.lockedClientSize = { w: clientW, h: clientH };
      const calib = this.calibrate(roiData, forcedScale);
      if (!calib.found) {
        return { success: false, reason: `Meso bar not found (score ${calib.conf.toFixed(2)})` };
      }
    } else {
      // Fast-track: verify cached position with tight search pad
      const lx = this.lockedLoc.x;
      const ly = this.lockedLoc.y;
      const s = this.lockedScale;
      const sw = Math.max(5, Math.round(this.tmplW * s));
      const sh = Math.max(3, Math.round(this.tmplH * s));

      const pad = Math.max(20, Math.ceil(30 * s));
      const x1 = Math.max(0, lx - pad);
      const y1 = Math.max(0, ly - pad);
      const x2 = Math.min(roiW, lx + sw + pad);
      const y2 = Math.min(roiH, ly + sh + pad);

      const subW = x2 - x1;
      const subH = y2 - y1;

      if (subH >= sh && subW >= sw) {
        const searchPadRegion = { x: x1, y: y1, w: subW, h: subH };
        const res = this.engine.matchTemplate(roiData, this.tmplData, searchPadRegion, s, 1, 1);
        if (res.maxVal >= 0.50) {
          this.lockedLoc = res.maxLoc;
          this.consecutiveMisses = 0;
        } else {
          this.consecutiveMisses++;
        }
      } else {
        this.consecutiveMisses++;
      }

      if (this.consecutiveMisses > 2) {
        const calib = this.calibrate(roiData, forcedScale);
        if (!calib.found) {
          return { success: false, reason: 'Lost track of Meso counter' };
        }
      } else if (this.consecutiveMisses > 0) {
        return { success: false, reason: 'Meso anchor match below threshold' };
      }
    }

    const anchorX = this.lockedLoc.x;
    const anchorY = this.lockedLoc.y;
    const s = this.lockedScale;

    // Crop the white text box immediately to the left of the anchor right border
    const boxW = Math.round(142 * s);
    const boxH = Math.round(14 * s);
    const boxX = anchorX + Math.round(2 * s) - boxW;
    const boxY = anchorY + Math.round(2 * s);

    if (boxX < 0 || boxY < 0 || boxX + boxW > roiW || boxY + boxH > roiH || boxW < 30 || boxH < 6) {
      return { success: false, reason: 'Meso box crop out of bounds' };
    }

    const boxCrop = this.engine.crop(roiData, boxX, boxY, boxW, boxH);
    const bW = boxCrop.width;
    const bH = boxCrop.height;
    const bData = boxCrop.data;

    // Grayscale
    const gray = new Uint8Array(bW * bH);
    for (let i = 0; i < bW * bH; i++) {
      const idx = i * 4;
      gray[i] = Math.round(bData[idx] * 0.299 + bData[idx + 1] * 0.587 + bData[idx + 2] * 0.114);
    }

    // Adaptive per-column binarization:
    // Handles transparent inventory windows by analyzing local min/max contrast per column.
    // Text pixels are locally darker than the box background even when alpha-blended.
    const binGrid = [];
    for (let y = 0; y < bH; y++) {
      binGrid.push(new Uint8Array(bW));
    }

    for (let x = 0; x < bW; x++) {
      let colMin = 255;
      let colMax = 0;
      for (let y = 0; y < bH; y++) {
        const g = gray[y * bW + x];
        if (g < colMin) colMin = g;
        if (g > colMax) colMax = g;
      }

      const contrast = colMax - colMin;
      // Real text pixels are dark (colMin <= 110) with solid contrast against the box (contrast >= 35)
      // This completely suppresses vertical gradient noise from transparent windows over dark map tiles
      if (colMin <= 110 && contrast >= 35) {
        const thresh = Math.min(115, Math.round(colMin + contrast * 0.45));
        for (let y = 0; y < bH; y++) {
          binGrid[y][x] = (gray[y * bW + x] <= thresh) ? 1 : 0;
        }
      }
    }

    // Segment characters by vertical projection (columns)
    const hasPixel = new Array(bW).fill(false);
    for (let x = 0; x < bW; x++) {
      for (let y = 0; y < bH; y++) {
        if (binGrid[y][x] === 1) {
          hasPixel[x] = true;
          break;
        }
      }
    }

    const segments = [];
    let inChar = false;
    let startX = 0;
    for (let i = 0; i < bW; i++) {
      if (hasPixel[i] && !inChar) {
        inChar = true;
        startX = i;
      } else if (!hasPixel[i] && inChar) {
        inChar = false;
        segments.push([startX, i]);
      }
    }
    if (inChar) {
      segments.push([startX, bW]);
    }

    // Normalized center-point sampling character matcher
    const matchChar = (sX, eX) => {
      const segW = eX - sX;
      let rStart = -1, rEnd = -1;
      let activePixels = 0;
      for (let y = 0; y < bH; y++) {
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

      // Ignore dust pixels or wide line/shadow noise from transparent windows
      if (rStart === -1 || activePixels < Math.max(1, Math.floor(s * 0.8))) return '';
      const segH = rEnd - rStart + 1;
      if (segW > Math.ceil(8 * s) || segH < Math.floor(3 * s)) return '';

      let bestC = '?';
      let bestScore = -1;
      let bestDiff = 9999;

      for (const tmpl of this.charTmpls) {
        const th = tmpl.h;
        const tw = tmpl.w;
        const expW = tw * s;
        const expH = th * s;

        // Size check tolerance scaled with s
        if (Math.abs(segW - expW) > Math.max(2, 1.2 * s) || Math.abs(segH - expH) > Math.max(3, 1.4 * s)) {
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
        if (score > bestScore) {
          bestScore = score;
          bestDiff = diff;
          bestC = tmpl.char;
        }
      }

      if (bestScore < 0.65) return '';
      return bestC;
    };

    const recognized = [];
    for (const [sX, eX] of segments) {
      const ch = matchChar(sX, eX);
      if (ch !== '') recognized.push(ch);
    }

    const rawStr = recognized.join('');
    const cleanStr = rawStr.replace(/[^\d]/g, '');
    let mesoVal = null;
    if (cleanStr.length > 0) {
      const parsed = parseInt(cleanStr, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        mesoVal = parsed;
      }
    }

    const valid = (mesoVal !== null);

    return {
      success: valid,
      meso_val: mesoVal,
      confidence: this.lastConfidence || 1.0,
      meso_value: mesoVal,
      raw_text: rawStr,
      scale: Math.round(s * 100) / 100,
      pos: { x: anchorX, y: anchorY },
      box_loc: { x: anchorX, y: anchorY },
      box: { x: boxX, y: boxY, w: boxW, h: boxH },
      crop_data: boxCrop
    };
  }
}

// Exports
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MesoDetector };
}
if (typeof window !== 'undefined') {
  window.MesoDetector = MesoDetector;
}

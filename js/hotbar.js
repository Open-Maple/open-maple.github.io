/**
 * MapleEXP Tracker - Hotbar Detector
 * Locates the 3x4 MapleStory quickslot hotbar, crops individual slots,
 * and performs pixel-exact quantity OCR.
 */

class HotbarDetector {
  constructor(cvEngine = null, frameBottomTmpl = null, ctrlBtnTmpl = null) {
    this.engine = cvEngine || new (typeof CVEngine !== 'undefined' ? CVEngine : require('./cv-engine.js').CVEngine)();

    this.frameTmpl = frameBottomTmpl;
    this.frameW = frameBottomTmpl ? frameBottomTmpl.width : 147;
    this.frameH = frameBottomTmpl ? frameBottomTmpl.height : 8;

    this.ctrlTmpl = ctrlBtnTmpl;
    this.ctrlW = ctrlBtnTmpl ? ctrlBtnTmpl.width : 31;
    this.ctrlH = ctrlBtnTmpl ? ctrlBtnTmpl.height : 31;

    // Standard grid dimensions at 1.0x scale
    this.gridW = 147;
    this.gridH = 112;

    this.cellCols = [[5, 36], [40, 71], [75, 106], [110, 141]];
    this.cellRows = [[5, 36], [39, 70], [73, 104]];

    const templates = (typeof KEY_NAMES !== 'undefined')
      ? { KEY_NAMES, DIGIT_TEMPLATES }
      : require('./templates.js');

    this.keyNames = templates.KEY_NAMES;
    this.digitTemplates = templates.DIGIT_TEMPLATES;

    this.isLocked = false;
    this.lockedLoc = { x: 0, y: 0 };
    this.lockedScale = 1.0;
    this.consecutiveMisses = 0;
  }

  setTemplates(frameBottomTmpl, ctrlBtnTmpl) {
    if (frameBottomTmpl) {
      this.frameTmpl = frameBottomTmpl;
      this.frameW = frameBottomTmpl.width;
      this.frameH = frameBottomTmpl.height;
    }
    if (ctrlBtnTmpl) {
      this.ctrlTmpl = ctrlBtnTmpl;
      this.ctrlW = ctrlBtnTmpl.width;
      this.ctrlH = ctrlBtnTmpl.height;
    }
  }

  resetLock() {
    this.isLocked = false;
    this.consecutiveMisses = 0;
  }

  parseCellQuantity(cellData) {
    if (!cellData || cellData.height < 31 || cellData.width < 31) {
      return null;
    }

    const cW = cellData.width;
    const cData = cellData.data;

    // Number region: y: 21..30 (9 rows), x: 0..24
    const roiH = 9;
    const roiW = 24;
    const whiteMask = [];
    let whiteCount = 0;

    for (let r = 0; r < roiH; r++) {
      const y = 21 + r;
      const rowMask = new Uint8Array(roiW);
      for (let x = 0; x < roiW; x++) {
        const idx = (y * cW + x) * 4;
        const g = cData[idx + 1];
        const b = cData[idx + 2];
        if (b > 165 && g > 155) {
          rowMask[x] = 1;
          whiteCount++;
        } else {
          rowMask[x] = 0;
        }
      }
      whiteMask.push(rowMask);
    }

    // Black outline verification near bottom-left: corner y: 20..31, x: 0..22
    let blackCount = 0;
    for (let y = 20; y < 31; y++) {
      for (let x = 0; x < 22; x++) {
        const idx = (y * cW + x) * 4;
        if (cData[idx] < 50 && cData[idx + 1] < 50 && cData[idx + 2] < 50) {
          blackCount++;
        }
      }
    }

    if (blackCount < 20 || whiteCount < 7) {
      return null;
    }

    const matches = [];
    for (let x = 0; x <= roiW - 2; x++) {
      for (const [d, tmpl] of Object.entries(this.digitTemplates)) {
        const tw = tmpl[0].length;
        const th = tmpl.length; // 9
        if (x + tw <= roiW) {
          let matched = 0;
          let missedTmpl = 0;
          let unexplained = 0;
          let totalTmpl = 0;

          for (let r = 0; r < th; r++) {
            for (let c = 0; c < tw; c++) {
              const sVal = whiteMask[r][x + c];
              const tVal = tmpl[r][c];
              if (tVal === 1) totalTmpl++;

              if (sVal === 1 && tVal === 1) matched++;
              else if (sVal === 0 && tVal === 1) missedTmpl++;
              else if (sVal === 1 && tVal === 0) unexplained++;
            }
          }

          const maxUnexplained = (d === '1') ? 4 : 14;
          const minRatio = (d !== '1' && unexplained > 5) ? 0.85 : 0.75;

          if (totalTmpl > 0 && (matched / totalTmpl) >= minRatio && unexplained <= maxUnexplained) {
            const score = matched - 0.8 * unexplained - 1.0 * missedTmpl;
            matches.push({ x, d, score, w: tw });
          }
        }
      }
    }

    if (matches.length === 0) {
      return null;
    }

    // Greedy non-overlapping selection by highest score
    matches.sort((a, b) => b.score - a.score);
    const selected = [];
    for (const m of matches) {
      let overlap = false;
      for (const s of selected) {
        if (Math.max(m.x, s.x) < Math.min(m.x + m.w, s.x + s.w)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        selected.push(m);
      }
    }

    // Sort left to right
    selected.sort((a, b) => a.x - b.x);
    const numStr = selected.map(s => s.d).join('');
    if (!numStr) return null;
    const parsed = parseInt(numStr, 10);
    return isNaN(parsed) ? null : parsed;
  }

  detect(roiData, uiScale = 1.0) {
    if (!roiData || roiData.width === 0 || roiData.height === 0) {
      return { success: false, reason: 'Empty frame' };
    }

    // Detect dark screen
    const stats = this.engine.calculateStats(roiData);
    if (stats.mean < 25.0 || stats.max < 50) {
      return { success: false, reason: 'Screen is black (map transition / loading)' };
    }

    const roiW = roiData.width;
    const roiH = roiData.height;

    let bestVal = -1;
    let bestLoc = { x: 0, y: 0 };
    let bestScale = uiScale;

    // 1. Fast verification near cached location (if already locked)
    if (this.isLocked && Math.abs(uiScale - this.lockedScale) < 0.05 && this.frameTmpl) {
      const lx = this.lockedLoc.x;
      const ly = this.lockedLoc.y;
      const s = this.lockedScale;

      const fy = ly + Math.floor(104 * s);
      const fx = lx;
      const searchPad = 20;

      const y1 = Math.max(0, fy - searchPad);
      const y2 = Math.min(roiH, fy + Math.floor(this.frameH * s) + searchPad);
      const x1 = Math.max(0, fx - searchPad);
      const x2 = Math.min(roiW, fx + Math.floor(this.frameW * s) + searchPad);

      if (y2 > y1 + 5 && x2 > x1 + 10) {
        const searchRegion = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        const res = this.engine.matchTemplate(roiData, this.frameTmpl, searchRegion, s);
        if (res.maxVal >= 0.70) {
          bestVal = res.maxVal;
          bestLoc = { x: res.maxLoc.x, y: res.maxLoc.y - Math.floor(104 * s) };
          bestScale = s;
        }
      }
    }

    // 2. Full scan across ROI using bottom frame anchor
    if (bestVal < 0.70 && this.frameTmpl) {
      const scalesToTest = [];
      if (Math.abs(uiScale - 1.0) > 0.05) scalesToTest.push(uiScale);
      scalesToTest.push(1.0, 1.25, 1.5, 2.0, 0.8, 0.67);
      const uniqueScales = [...new Set(scalesToTest.map(s => Math.round(s * 100) / 100))];

      for (const s of uniqueScales) {
        const sw = Math.max(5, Math.floor(this.frameW * s));
        const sh = Math.max(3, Math.floor(this.frameH * s));
        if (sw > roiW || sh > roiH) continue;

        const res = this.engine.matchTemplate(roiData, this.frameTmpl, null, s);
        if (res.maxVal > bestVal) {
          bestVal = res.maxVal;
          bestScale = s;
          bestLoc = { x: res.maxLoc.x, y: res.maxLoc.y - Math.floor(104 * s) };
          if (bestVal > 0.90) break;
        }
      }
    }

    // 3. Fallback to Ctrl button template if frame bottom wasn't matched
    if (bestVal < 0.65 && this.ctrlTmpl) {
      for (const s of [uiScale, 1.0, 1.25]) {
        const sw = Math.max(5, Math.floor(this.ctrlW * s));
        const sh = Math.max(5, Math.floor(this.ctrlH * s));
        if (sw > roiW || sh > roiH) continue;

        const res = this.engine.matchTemplate(roiData, this.ctrlTmpl, null, s);
        if (res.maxVal > bestVal) {
          bestVal = res.maxVal;
          bestScale = s;
          bestLoc = { x: res.maxLoc.x - Math.floor(5 * s), y: res.maxLoc.y - Math.floor(73 * s) };
          if (bestVal > 0.85) break;
        }
      }
    }

    if (bestVal < 0.65) {
      this.consecutiveMisses++;
      if (this.consecutiveMisses > 3) {
        this.isLocked = false;
      }
      return { success: false, reason: `Hotbar not found (score ${bestVal.toFixed(2)})` };
    }

    this.isLocked = true;
    this.lockedLoc = bestLoc;
    this.lockedScale = bestScale;
    this.consecutiveMisses = 0;

    const gridX = bestLoc.x;
    const gridY = bestLoc.y;
    const scaledW = Math.floor(this.gridW * bestScale);
    const scaledH = Math.floor(this.gridH * bestScale);

    if (gridX < 0 || gridY < 0 || gridX + scaledW > roiW || gridY + scaledH > roiH) {
      return { success: false, reason: 'Hotbar out of frame bounds' };
    }

    const gridCrop = this.engine.crop(roiData, gridX, gridY, scaledW, scaledH);
    let normGrid = gridCrop;
    if (Math.abs(bestScale - 1.0) > 0.05) {
      normGrid = this.engine.resize(gridCrop, this.gridW, this.gridH);
    }

    const cells = [];
    const quantities = {};

    for (let rIdx = 0; rIdx < this.cellRows.length; rIdx++) {
      const [r1, r2] = this.cellRows[rIdx];
      const rowCells = [];
      for (let cIdx = 0; cIdx < this.cellCols.length; cIdx++) {
        const [c1, c2] = this.cellCols[cIdx];
        const cellData = this.engine.crop(normGrid, c1, r1, c2 - c1, r2 - r1);
        const qty = this.parseCellQuantity(cellData);
        quantities[`${rIdx},${cIdx}`] = qty;

        rowCells.push({
          row: rIdx,
          col: cIdx,
          key: this.keyNames[rIdx][cIdx],
          quantity: qty,
          norm_crop_data: cellData
        });
      }
      cells.push(rowCells);
    }

    return {
      success: true,
      grid_loc: bestLoc,
      scale: bestScale,
      confidence: bestVal,
      grid_crop_data: gridCrop,
      cells: cells,
      quantities: quantities
    };
  }
}

// Exports
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HotbarDetector };
}
if (typeof window !== 'undefined') {
  window.HotbarDetector = HotbarDetector;
}

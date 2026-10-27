/**
 * MapleEXP Tracker - Computer Vision & Image Processing Engine
 * Provides dual-engine execution:
 * 1. WebAssembly-accelerated OpenCV.js when loaded (high performance, identical to desktop)
 * 2. Optimized pure JavaScript fallback for zero-dependency / instant offline execution
 */

class CVEngine {
  constructor() {
    this.isOpenCvReady = false;
    this.cv = null;
    this._checkOpenCv();
  }

  _checkOpenCv() {
    if (typeof window !== 'undefined' && window.cv && window.cv.Mat) {
      this.cv = window.cv;
      this.isOpenCvReady = true;
    }
  }

  setOpenCv(cvInstance) {
    this.cv = cvInstance;
    this.isOpenCvReady = true;
  }

  /**
   * Calculates mean, max, and standard deviation of an RGB/RGBA image or slice.
   */
  calculateStats(imageData) {
    const data = imageData.data;
    const len = data.length;
    if (len === 0) return { mean: 0, max: 0, std: 0 };

    let sum = 0;
    let maxVal = 0;
    const count = (len / 4) * 3; // 3 channels: R, G, B

    for (let i = 0; i < len; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      sum += r + g + b;
      if (r > maxVal) maxVal = r;
      if (g > maxVal) maxVal = g;
      if (b > maxVal) maxVal = b;
    }

    const mean = sum / count;
    let sumSqDiff = 0;

    for (let i = 0; i < len; i += 4) {
      const dr = data[i] - mean;
      const dg = data[i + 1] - mean;
      const db = data[i + 2] - mean;
      sumSqDiff += dr * dr + dg * dg + db * db;
    }

    const std = Math.sqrt(sumSqDiff / count);
    return { mean, max: maxVal, std };
  }

  /**
   * Converts RGBA ImageData to a 1D grayscale Uint8Array.
   */
  toGrayscale(imageData) {
    const { width, height, data } = imageData;
    const gray = new Uint8Array(width * height);
    let p = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Standard ITU-R BT.601 luma formula
      gray[p++] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }
    return gray;
  }

  /**
   * Resizes ImageData to (newW, newH) using bilinear interpolation.
   */
  resize(srcData, newW, newH) {
    const sw = srcData.width;
    const sh = srcData.height;
    const sBuf = srcData.data;
    const dst = new Uint8ClampedArray(newW * newH * 4);

    const xRatio = (sw - 1) / Math.max(1, newW - 1);
    const yRatio = (sh - 1) / Math.max(1, newH - 1);

    for (let y = 0; y < newH; y++) {
      const sy = y * yRatio;
      const y0 = Math.floor(sy);
      const y1 = Math.min(sh - 1, y0 + 1);
      const yDiff = sy - y0;

      for (let x = 0; x < newW; x++) {
        const sx = x * xRatio;
        const x0 = Math.floor(sx);
        const x1 = Math.min(sw - 1, x0 + 1);
        const xDiff = sx - x0;

        const idx00 = (y0 * sw + x0) * 4;
        const idx10 = (y0 * sw + x1) * 4;
        const idx01 = (y1 * sw + x0) * 4;
        const idx11 = (y1 * sw + x1) * 4;

        const outIdx = (y * newW + x) * 4;

        for (let c = 0; c < 4; c++) {
          const top = sBuf[idx00 + c] * (1 - xDiff) + sBuf[idx10 + c] * xDiff;
          const bottom = sBuf[idx01 + c] * (1 - xDiff) + sBuf[idx11 + c] * xDiff;
          dst[outIdx + c] = Math.round(top * (1 - yDiff) + bottom * yDiff);
        }
      }
    }

    return { width: newW, height: newH, data: dst };
  }

  /**
   * Crops a sub-region from ImageData.
   */
  crop(srcData, x, y, w, h) {
    const sw = srcData.width;
    const sh = srcData.height;
    const sBuf = srcData.data;

    x = Math.max(0, Math.min(sw - 1, Math.floor(x)));
    y = Math.max(0, Math.min(sh - 1, Math.floor(y)));
    w = Math.max(1, Math.min(sw - x, Math.floor(w)));
    h = Math.max(1, Math.min(sh - y, Math.floor(h)));

    const dst = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const srcOffset = ((y + row) * sw + x) * 4;
      const dstOffset = row * w * 4;
      dst.set(sBuf.subarray(srcOffset, srcOffset + w * 4), dstOffset);
    }

    return { width: w, height: h, data: dst };
  }

  /**
   * Normalized cross-correlation (TM_CCOEFF_NORMED equivalent).
   * Works on grayscale buffers.
   */
  matchTemplateGrayscale(imgGray, imgW, imgH, tmplGray, tmplW, tmplH, optStep = 1, searchRegion = null) {
    let rx0 = 0, ry0 = 0, rx1 = imgW, ry1 = imgH;
    if (searchRegion) {
      rx0 = Math.max(0, Math.floor(searchRegion.x));
      ry0 = Math.max(0, Math.floor(searchRegion.y));
      rx1 = Math.min(imgW, Math.floor(searchRegion.x + searchRegion.w));
      ry1 = Math.min(imgH, Math.floor(searchRegion.y + searchRegion.h));
    }

    const maxSearchX = rx1 - tmplW;
    const maxSearchY = ry1 - tmplH;
    if (maxSearchX < rx0 || maxSearchY < ry0) {
      return { maxVal: -1, maxLoc: { x: 0, y: 0 } };
    }

    // Precompute template mean and standard deviation
    const tCount = tmplW * tmplH;
    let tSum = 0;
    for (let i = 0; i < tCount; i++) tSum += tmplGray[i];
    const tMean = tSum / tCount;

    let tVariance = 0;
    const tZeroMean = new Float32Array(tCount);
    for (let i = 0; i < tCount; i++) {
      const diff = tmplGray[i] - tMean;
      tZeroMean[i] = diff;
      tVariance += diff * diff;
    }
    const tStd = Math.sqrt(tVariance);
    if (tStd < 1e-4) return { maxVal: -1, maxLoc: { x: 0, y: 0 } };

    let bestVal = -1;
    let bestLoc = { x: rx0, y: ry0 };

    for (let y = ry0; y <= maxSearchY; y += optStep) {
      for (let x = rx0; x <= maxSearchX; x += optStep) {
        // Compute patch mean
        let pSum = 0;
        for (let ty = 0; ty < tmplH; ty++) {
          const imgRowOffset = (y + ty) * imgW + x;
          for (let tx = 0; tx < tmplW; tx++) {
            pSum += imgGray[imgRowOffset + tx];
          }
        }
        const pMean = pSum / tCount;

        let num = 0;
        let pVariance = 0;
        let tIdx = 0;

        for (let ty = 0; ty < tmplH; ty++) {
          const imgRowOffset = (y + ty) * imgW + x;
          for (let tx = 0; tx < tmplW; tx++) {
            const pDiff = imgGray[imgRowOffset + tx] - pMean;
            num += pDiff * tZeroMean[tIdx++];
            pVariance += pDiff * pDiff;
          }
        }

        const denom = tStd * Math.sqrt(pVariance);
        const score = denom > 1e-4 ? (num / denom) : -1;

        if (score > bestVal) {
          bestVal = score;
          bestLoc = { x, y };
        }
      }
    }

    return { maxVal: bestVal, maxLoc: bestLoc };
  }

  /**
   * Unified matchTemplate: delegates to OpenCV.js if loaded, or falls back to pure JS.
   */
  matchTemplate(roiData, tmplData, searchPad = null, scale = 1.0) {
    this._checkOpenCv();

    if (this.isOpenCvReady && this.cv) {
      try {
        const cv = this.cv;
        const roiMat = cv.matFromImageData(roiData);
        let tmplMat = cv.matFromImageData(tmplData);

        if (Math.abs(scale - 1.0) > 0.02) {
          const sw = Math.max(5, Math.round(tmplData.width * scale));
          const sh = Math.max(3, Math.round(tmplData.height * scale));
          const resized = new cv.Mat();
          cv.resize(tmplMat, resized, new cv.Size(sw, sh), 0, 0, scale < 1.0 ? cv.INTER_AREA : cv.INTER_LINEAR);
          tmplMat.delete();
          tmplMat = resized;
        }

        if (roiMat.cols < tmplMat.cols || roiMat.rows < tmplMat.rows) {
          roiMat.delete();
          tmplMat.delete();
          return { maxVal: -1, maxLoc: { x: 0, y: 0 } };
        }

        const resMat = new cv.Mat();
        cv.matchTemplate(roiMat, tmplMat, resMat, cv.TM_CCOEFF_NORMED);
        const minMax = cv.minMaxLoc(resMat);

        roiMat.delete();
        tmplMat.delete();
        resMat.delete();

        return { maxVal: minMax.maxVal, maxLoc: { x: minMax.maxLoc.x, y: minMax.maxLoc.y } };
      } catch (err) {
        console.warn('OpenCV.js matchTemplate error, falling back to pure JS:', err);
      }
    }

    // Pure JS fallback
    let sTmpl = tmplData;
    if (Math.abs(scale - 1.0) > 0.02) {
      const sw = Math.max(5, Math.round(tmplData.width * scale));
      const sh = Math.max(3, Math.round(tmplData.height * scale));
      sTmpl = this.resize(tmplData, sw, sh);
    }

    const roiGray = this.toGrayscale(roiData);
    const tmplGray = this.toGrayscale(sTmpl);

    return this.matchTemplateGrayscale(
      roiGray, roiData.width, roiData.height,
      tmplGray, sTmpl.width, sTmpl.height,
      1, searchPad
    );
  }
}

// Support Node.js CommonJS and browser window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CVEngine };
}
if (typeof window !== 'undefined') {
  window.CVEngine = CVEngine;
}

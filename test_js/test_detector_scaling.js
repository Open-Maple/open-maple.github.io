const assert = require('assert');
const zlib = require('zlib');
const { CVEngine } = require('../js/cv-engine.js');
const { ExpDetector } = require('../js/detector.js');
const { HotbarDetector } = require('../js/hotbar.js');
const { RAW_TEMPLATES } = require('../js/templates.js');
const { SAMPLE_CAPTURE_B64 } = require('../js/sample-data.js');

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

function decodePNGToRGBA(buf) {
  let pos = 8, width, height, idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
    } else if (type === 'IDAT') idatChunks.push(buf.slice(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * 3;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const scanline = new Uint8Array(stride);
  const prevLine = new Uint8Array(stride);
  let srcPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = decompressed[srcPos++];
    for (let i = 0; i < stride; i++) {
      const raw = decompressed[srcPos++];
      const a = (i >= 3) ? scanline[i - 3] : 0;
      const b = prevLine[i];
      const c = (i >= 3) ? prevLine[i - 3] : 0;
      let val = raw;
      if (filter === 1) val = (raw + a) & 0xff;
      else if (filter === 2) val = (raw + b) & 0xff;
      else if (filter === 3) val = (raw + Math.floor((a + b) / 2)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (raw + pr) & 0xff;
      }
      scanline[i] = val;
    }
    prevLine.set(scanline);
    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4;
      const inIdx = x * 3;
      rgba[outIdx] = scanline[inIdx];
      rgba[outIdx + 1] = scanline[inIdx + 1];
      rgba[outIdx + 2] = scanline[inIdx + 2];
      rgba[outIdx + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

console.log('--- Running Multi-Scale ExpDetector & Hotbar Tests ---');

const cvEngine = new CVEngine();
const expLogoTmpl = createTmplImageData(RAW_TEMPLATES.exp_logo);
const frameBottomTmpl = createTmplImageData(RAW_TEMPLATES.frame_bottom);
const ctrlBtnTmpl = createTmplImageData(RAW_TEMPLATES.ctrl_btn);

const baseRoi = decodePNGToRGBA(Buffer.from(SAMPLE_CAPTURE_B64, 'base64'));
// The sample capture has the EXP bar around x=998, y=277 and hotbar around x=1760, y=190
// Let's crop a focused sub-region containing the entire bottom bar and hotbar
const subRoi = cvEngine.crop(baseRoi, 800, 100, 1120, 211);

// Test 1: Baseline 1.0x detection
{
  const detector = new ExpDetector(cvEngine, expLogoTmpl);
  const res = detector.detect(subRoi, subRoi.width, subRoi.height);
  assert.strictEqual(res.success, true, 'Scale 1.0x detection failed: ' + res.reason);
  assert.strictEqual(res.exp_value, 13308, 'EXP value mismatch at 1.0x');
  assert.strictEqual(res.exp_pct, 20.9, 'EXP percentage mismatch at 1.0x');
  console.log('✓ Test 1: Native 1.0x EXP detection passed (val=' + res.exp_value + ', pct=' + res.exp_pct + '%)');
}

// Test 2: Multi-scale detection across various UI scaling factors
const testScales = [1.25, 1.33, 1.5, 1.75, 2.0, 2.5, 3.0];
for (const scale of testScales) {
  const scaledRoi = cvEngine.resizeNearest(
    subRoi,
    Math.round(subRoi.width * scale),
    Math.round(subRoi.height * scale)
  );

  const detector = new ExpDetector(cvEngine, expLogoTmpl);
  const res = detector.detect(scaledRoi, scaledRoi.width, scaledRoi.height);

  assert.strictEqual(res.success, true, `Scale ${scale}x detection failed: ${res.reason}`);
  assert.strictEqual(res.exp_value, 13308, `Scale ${scale}x EXP value mismatch: expected 13308, got ${res.exp_value}`);
  assert.strictEqual(res.exp_pct, 20.9, `Scale ${scale}x EXP pct mismatch: expected 20.9, got ${res.exp_pct}`);
  assert(Math.abs(res.scale - scale) <= 0.15, `Scale mismatch: expected ~${scale}, detected ${res.scale}`);

  console.log(`✓ Test 2: Scale ${scale}x EXP detection passed (detected scale: ${res.scale}x, raw: ${res.raw_text})`);
}

// Test 3: Fast-track cached lock across consecutive frames at 1.5x scale
{
  const scale = 1.5;
  const scaledRoi = cvEngine.resizeNearest(
    subRoi,
    Math.round(subRoi.width * scale),
    Math.round(subRoi.height * scale)
  );

  const detector = new ExpDetector(cvEngine, expLogoTmpl);
  const res1 = detector.detect(scaledRoi, scaledRoi.width, scaledRoi.height);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(detector.isLocked, true);

  // Consecutive frame (should use fast-track path seamlessly)
  const res2 = detector.detect(scaledRoi, scaledRoi.width, scaledRoi.height);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.exp_value, 13308);
  console.log('✓ Test 3: Fast-track tracking across consecutive frames passed at 1.5x');
}

// Test 4: Hotbar detection with scaled UI
{
  const scale = 1.5;
  const scaledRoi = cvEngine.resizeNearest(
    subRoi,
    Math.round(subRoi.width * scale),
    Math.round(subRoi.height * scale)
  );

  const hotbar = new HotbarDetector(cvEngine, frameBottomTmpl, ctrlBtnTmpl);
  const res = hotbar.detect(scaledRoi, scale);
  assert.strictEqual(res.success, true, 'Hotbar detection failed at scale 1.5x: ' + res.reason);
  console.log(`✓ Test 4: Hotbar detection passed at scale ${scale}x (confidence: ${res.confidence.toFixed(2)})`);
}

console.log('>>> ALL MULTI-SCALE EXP & HOTBAR TESTS PASSED! <<<');

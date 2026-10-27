const assert = require('assert');
const { ExpTracker, ExpSample } = require('../js/tracker.js');

console.log('--- Running JS ExpTracker Unit Tests ---');

// 1. Normal grinding
{
  const tracker = new ExpTracker();
  tracker.add_sample(10000, 35.00, 35.0);
  assert.strictEqual(tracker.total_gained_exp, 0);

  for (let i = 1; i <= 5; i++) {
    tracker.add_sample(10000 + i * 50, 35.00 + i * 0.05, 35.0 + i * 0.05);
  }

  assert.strictEqual(tracker.total_gained_exp, 250);
  assert.strictEqual(Math.round(tracker.total_gained_pct * 100) / 100, 0.25);
  console.log('✓ test_normal_grinding passed');
}

// 2. Black screen multi-frame dropout
{
  const tracker = new ExpTracker();
  tracker.add_sample(10000, 35.00, 35.0);
  tracker.add_sample(10050, 35.05, 35.05);

  // Screen goes black during map transition (lasts 3 seconds reading 0 EXP)
  tracker.add_sample(0, 0.0, null);
  tracker.add_sample(0, 0.0, null);
  tracker.add_sample(0, 0.0, null);

  // Screen returns: EXP is 10060
  tracker.add_sample(10060, 35.06, 35.06);
  tracker.add_sample(10110, 35.11, 35.11);

  assert.strictEqual(tracker.total_gained_exp, 110);
  assert.strictEqual(Math.round(tracker.total_gained_pct * 100) / 100, 0.11);

  const w1 = tracker.get_window_gain(60);
  assert.strictEqual(w1.gained_exp, 110);
  console.log('✓ test_black_screen_multi_frame_dropout passed');
}

// 3. Transient OCR spike
{
  const tracker = new ExpTracker();
  tracker.add_sample(10000, 35.00, 35.0);
  tracker.add_sample(10050, 35.05, 35.05);

  // OCR glitch inserts extra digit: reads 100,500 (+90,450 fake gain)
  tracker.add_sample(100500, 35.05, 35.05);

  // Next frame: OCR reads correct value 10,100
  tracker.add_sample(10100, 35.10, 35.10);
  tracker.add_sample(10150, 35.15, 35.15);

  assert.strictEqual(tracker.total_gained_exp, 150);
  const w1 = tracker.get_window_gain(60);
  assert.strictEqual(w1.gained_exp, 150);
  console.log('✓ test_transient_ocr_spike passed');
}

// 4. Multi-frame spike sanitization
{
  const tracker = new ExpTracker();
  const now = Date.now() / 1000;
  const s0 = new ExpSample(now - 8, 10000, 35.0, 35.0);
  const s1 = new ExpSample(now - 6, 10050, 35.05, 35.05, 50, 0.05);
  const s2 = new ExpSample(now - 4, 150000, 35.05, 35.05, 139950, 0.0);
  const s3 = new ExpSample(now - 2, 10100, 35.10, 35.10, 0, 0.05);

  tracker.history.push(s0, s1, s2, s3);
  tracker.last_sample = s3;
  tracker.session_start_time = now - 8;
  tracker.totalGainedExp = 50 + 139950;
  tracker.totalGainedPct = 0.10;

  const anomalies = tracker.sanitize_history();
  assert.ok(anomalies >= 1);
  assert.strictEqual(tracker.total_gained_exp, 100);
  console.log('✓ test_multi_frame_spike_sanitization passed');
}

// 5. Retroactive sanitization of corrupted history
{
  const tracker = new ExpTracker();
  const now = Date.now() / 1000;
  const s0 = new ExpSample(now - 10, 10000, 35.0, 35.0, 0, 0.0);
  const s1 = new ExpSample(now - 8, 10050, 35.05, 35.05, 50, 0.05);
  const s2 = new ExpSample(now - 6, 500000, 35.05, 35.05, 489950, 0.0);
  const s3 = new ExpSample(now - 4, 10100, 35.10, 35.10, 0, 0.05);
  const s4 = new ExpSample(now - 2, 10150, 35.15, 35.15, 50, 0.05);

  tracker.history.push(s0, s1, s2, s3, s4);
  tracker.totalGainedExp = 50 + 489950 + 50;
  tracker.totalGainedPct = 0.15;
  tracker.last_sample = s4;
  tracker.session_start_time = now - 10;

  const anomalies = tracker.sanitize_history();
  assert.ok(anomalies >= 1);
  assert.strictEqual(tracker.total_gained_exp, 150);
  console.log('✓ test_retroactive_sanitization_of_corrupted_history passed');
}

// 6. Legitimate level up
{
  const tracker = new ExpTracker();
  tracker.add_sample(995000, 99.50, 99.50);
  tracker.add_sample(999000, 99.90, 99.90);

  // Level up! EXP resets to 500 [0.05%]
  tracker.add_sample(500, 0.05, 0.05);
  // Next frame confirms level up
  tracker.add_sample(1000, 0.10, 0.10);

  assert.strictEqual(tracker.level_ups, 1);
  assert.ok(tracker.total_gained_exp > 1500);
  console.log('✓ test_legitimate_level_up passed');
}

// 7. Character death
{
  const tracker = new ExpTracker();
  tracker.add_sample(100000, 50.00, 50.00);
  tracker.add_sample(100500, 50.25, 50.25);

  // Character dies: loses 10% EXP
  tracker.add_sample(80500, 40.25, 40.25);
  tracker.add_sample(80600, 40.30, 40.30);

  assert.strictEqual(tracker.total_gained_exp, 600);
  assert.strictEqual(tracker.level_ups, 0);
  console.log('✓ test_character_death passed');
}

// 8. Optical divergence rejected
{
  const tracker = new ExpTracker();
  tracker.add_sample(10000, 35.00, 35.00);
  // Divergence: 80% vs 35% (> 25%)
  tracker.add_sample(25000, 80.00, 35.00);
  assert.strictEqual(tracker.total_gained_exp, 0);
  console.log('✓ test_optical_divergence_rejected passed');
}

console.log('>>> ALL JS ExpTracker TESTS PASSED! <<<');

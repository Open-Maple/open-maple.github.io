const assert = require('assert');
const { MesoTracker, MesoSample } = require('../js/meso-tracker.js');

console.log('--- Running JS MesoTracker Unit Tests ---');

// 1. Normal grinding meso gains
{
  const tracker = new MesoTracker();
  tracker.add_sample(48000);
  assert.strictEqual(tracker.total_gained_meso, 0);

  // Mobs drop mesos: 48,000 -> 48,720 (+720) -> 49,687 (+967) -> 50,612 (+925)
  tracker.add_sample(48720);
  tracker.add_sample(49687);
  tracker.add_sample(50612);

  assert.strictEqual(tracker.total_gained_meso, 2612);
  assert.strictEqual(tracker.net_meso, 2612);
  assert.strictEqual(tracker.total_spent_meso, 0);

  const w1 = tracker.getWindowGain(60);
  assert.strictEqual(w1.gained_meso, 2612);
  assert.ok(w1.meso_rate_hr > 0);
  console.log('✓ test_normal_grinding passed');
}

// 2. Multi-frame drop immunity (e.g. inventory closed or single frame drop)
{
  const tracker = new MesoTracker();
  tracker.add_sample(50000);
  tracker.add_sample(50500);

  // Sudden OCR drop to 5,050 (missed leading '5')
  tracker.add_sample(5050);

  // Recovers to 50,800
  tracker.add_sample(50800);
  tracker.add_sample(51200);

  assert.strictEqual(tracker.total_gained_meso, 1200);
  assert.strictEqual(tracker.anomalies_corrected, 1);
  console.log('✓ test_multi_frame_drop_immunity passed');
}

// 3. Transient OCR spike (e.g. noise creates extra digit)
{
  const tracker = new MesoTracker();
  tracker.add_sample(50000);
  tracker.add_sample(50500);

  // Sudden fake spike: 505,000 (+454,500 fake)
  tracker.add_sample(505000);

  // Next frame returns to 51,000
  tracker.add_sample(51000);
  tracker.add_sample(51500);

  assert.strictEqual(tracker.total_gained_meso, 1500);
  assert.strictEqual(tracker.anomalies_corrected, 1);
  console.log('✓ test_transient_ocr_spike passed');
}

// 4. Legitimate spending (buying potions or taxi)
{
  const tracker = new MesoTracker();
  tracker.add_sample(50000);
  tracker.add_sample(51000);

  // User buys 100 potions: meso drops from 51,000 to 31,000 (-20,000)
  // Sustained across several seconds:
  tracker.add_sample(31000);
  tracker.add_sample(31000);
  tracker.add_sample(31000);
  tracker.add_sample(31000);
  tracker.add_sample(31000);
  tracker.add_sample(31000);
  tracker.add_sample(31000);

  // Then resumes grinding
  tracker.add_sample(31500);

  assert.strictEqual(tracker.total_gained_meso, 1500); // 1000 before + 500 after
  assert.strictEqual(tracker.total_spent_meso, 20000);
  assert.strictEqual(tracker.net_meso, -18500);
  console.log('✓ test_legitimate_spending passed');
}

// 5. Rolling window rates
{
  const tracker = new MesoTracker();
  const now = Date.now() / 1000;
  tracker.add_sample(50000);
  tracker.add_sample(51000);
  tracker.add_sample(52000);

  const stats = tracker.getSessionStats();
  assert.strictEqual(stats.current_meso, 52000);
  assert.strictEqual(stats.initial_meso, 50000);
  assert.strictEqual(stats.total_gained_meso, 2000);
  assert.strictEqual(stats.net_meso, 2000);
  console.log('✓ test_session_stats passed');
}

console.log('All MesoTracker unit tests passed successfully!');

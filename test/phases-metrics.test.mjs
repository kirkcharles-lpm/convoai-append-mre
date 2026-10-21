import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, runPhase } from '../src/phases.mjs';
import { summarize, verdict } from '../src/metrics.mjs';

function clock({ latency = 0, silent = false } = {}) {
  let t = 0;
  const sends = [];
  return { sends, now: () => t,
    sleep: async (ms) => { t += ms; },
    send: async () => { sends.push(t); t += latency; },
    waitForStart: async () => { t += 500; },
    waitForEnd: async (sent, end) => { t = Math.min(end, sent + (silent ? 8000 : 4000)); },
  };
}

test('phase durations total 330 seconds in the requested order', () => {
  assert.deepEqual(PHASES.map((p) => [p.name, p.durationMs]), [
    ['serial', 60000], ['one-queued', 60000], ['two-queued', 120000], ['recovery-serial', 90000],
  ]);
  assert.equal(PHASES.reduce((sum, p) => sum + p.durationMs, 0), 330000);
});

test('serial waits for completion plus 3 seconds; no request crosses the boundary', async () => {
  const io = clock();
  assert.deepEqual(await runPhase(PHASES[0], io), { name: 'serial', start: 0, end: 60000 });
  assert.deepEqual(io.sends, [0, 7000, 14000, 21000, 28000, 35000, 42000, 49000, 56000]);
  assert.equal(io.now(), 60000);
});

test('one-queued uses wall-clock 4-second cadence despite REST latency', async () => {
  const io = clock({ latency: 200 });
  await runPhase(PHASES[1], io);
  assert.deepEqual(io.sends, Array.from({ length: 15 }, (_, i) => i * 4000));
  assert.equal(io.now(), 60000);
});

test('two-queued seeds playback, then sends pairs every 9 seconds', async () => {
  const io = clock({ latency: 100 });
  await runPhase(PHASES[2], io);
  assert.deepEqual(io.sends, [0, ...Array.from({ length: 14 }, (_, i) => [600 + i * 9000, 700 + i * 9000]).flat()]);
  assert.equal(io.now(), 120000);
});

test('silent recovery completes its full 90 seconds', async () => {
  const io = clock({ silent: true });
  await runPhase(PHASES[3], io);
  assert.deepEqual(io.sends, [0, 11000, 22000, 33000, 44000, 55000, 66000, 77000, 88000]);
  assert.equal(io.now(), 90000);
});

test('slow REST cannot silently turn the queue workload into a different cadence', async () => {
  await assert.rejects(runPhase(PHASES[1], clock({ latency: 6000 })), /schedule slipped/);
});

test('speech duration and longest silence use the 100ms bins within phase boundaries', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ t: (i + 1) * 100, rms: i >= 20 && i < 60 ? 0.1 : 0 }));
  const result = summarize(samples, { name: 'recovery-serial', start: 0, end: 10000 }, 0.01);
  assert.deepEqual(result, { phase: 'recovery-serial', speechSeconds: 4, speechPercent: 40,
    longestSilence: 4, coveragePercent: 100, speechBurstCount: 1, meanSpeechBurstSeconds: 4 });
  const clipped = summarize(samples, { name: 'clip', start: 2050, end: 6050 }, 0.01);
  assert.equal(clipped.speechSeconds, 3.95);
  assert.equal(clipped.longestSilence, 0.05);
});

test('missing RMS ticks are incomplete measurements, not confirmed silence', () => {
  const result = summarize([{ t: 100, rms: 0 }, { t: 10000, rms: 0 }],
    { name: 'missing', start: 0, end: 10000 }, 0.01);
  assert.equal(result.coveragePercent, 2);
  assert.equal(result.longestSilence, 0.1);
});

test('jittering sample times cannot double-count speech duration', () => {
  const result = summarize([100, 150, 200].map((t) => ({ t, rms: 0.1 })),
    { name: 'jitter', start: 0, end: 200 }, 0.01);
  assert.equal(result.speechPercent, 100);
  assert.equal(result.coveragePercent, 100);
});

const healthy = {
  oneQueuedSpeechPercent: 100, twoQueuedSpeechPercent: 92,
  recoverySpeechPercent: 42, finalWindowSpeechPercent: 42,
  coveragePercents: [100, 100, 100, 100], agentStatus: 'RUNNING', audioPublished: true,
};

for (const [ratio, reproduced] of [[0.70, false], [0.699, true], [0.48, true], [0.93, false]]) {
  test(`queue ratio ${ratio}: ${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}`, () => {
    const result = verdict({ ...healthy, twoQueuedSpeechPercent: ratio * 100 });
    assert.deepEqual(result, {
      label: reproduced ? 'REPRODUCED' : 'NOT REPRODUCED', exitCode: reproduced ? 1 : 0,
      queuedSpeechRatio: ratio, reasons: reproduced ? ['queued line dropped'] : [],
    });
  });
}

test('ratio uses the one-queued percentage from the same run', () => {
  assert.equal(verdict({ ...healthy, oneQueuedSpeechPercent: 76, twoQueuedSpeechPercent: 38 }).queuedSpeechRatio, 0.5);
});

for (const [field, boundary, below] of [
  ['recoverySpeechPercent', 20, 19.999], ['finalWindowSpeechPercent', 10, 9.999],
]) {
  test(`${field} alone triggers audio died strictly below ${boundary}`, () => {
    assert.deepEqual(verdict({ ...healthy, [field]: below }).reasons, ['audio died']);
    assert.equal(verdict({ ...healthy, [field]: below }).exitCode, 1);
    assert.equal(verdict({ ...healthy, [field]: boundary }).exitCode, 0);
  });
}

test('unpublished audio alone reproduces with RUNNING agent and exactly 95% phase coverage', () => {
  const result = verdict({ ...healthy, audioPublished: false, coveragePercents: [95, 95, 95, 95] });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.reasons, ['audio track unpublished while agent RUNNING']);
});

test('all independent reasons are retained, with audio died reported once', () => {
  assert.deepEqual(verdict({ ...healthy, twoQueuedSpeechPercent: 50, recoverySpeechPercent: 0,
    finalWindowSpeechPercent: 0, audioPublished: false }).reasons,
  ['queued line dropped', 'audio died', 'audio track unpublished while agent RUNNING']);
});

test('invalid percentages, missing inputs and zero denominator cannot receive a verdict', () => {
  for (const field of ['oneQueuedSpeechPercent', 'twoQueuedSpeechPercent', 'recoverySpeechPercent', 'finalWindowSpeechPercent']) {
    for (const value of [NaN, Infinity, -1, 101, undefined, null, '42']) {
      assert.throws(() => verdict({ ...healthy, [field]: value }), /percentage/);
    }
  }
  assert.throws(() => verdict(), /percentage/);
  assert.throws(() => verdict({ ...healthy, oneQueuedSpeechPercent: 0 }), /positive/);
});

test('invalid status, publication or phase coverage overrides every symptom', () => {
  const symptomatic = { ...healthy, twoQueuedSpeechPercent: 0, recoverySpeechPercent: 0,
    finalWindowSpeechPercent: 0, audioPublished: false };
  for (const agentStatus of ['STOPPED', 'FAILED', 'STOPPING', 'STARTING', 'IDLE', undefined]) {
    assert.throws(() => verdict({ ...symptomatic, agentStatus }), /not RUNNING/);
  }
  for (const coveragePercents of [undefined, [], [100, 100, 100], [100, 94.999, 100, 100],
    [100, NaN, 100, 100], [100, 101, 100, 100]]) {
    assert.throws(() => verdict({ ...symptomatic, coveragePercents }), /coverage/);
  }
  for (const audioPublished of [undefined, null, 'false', 0]) {
    assert.throws(() => verdict({ ...healthy, audioPublished }), /boolean/);
  }
});

test('burst mean counts runs of speech bins, including clipped leading and trailing bursts', () => {
  const samples = [1, 1, 0, 1, 1, 1, 0, 1].map((rms, i) => ({ t: (i + 1) * 100, rms }));
  const result = summarize(samples, { name: 'bursts', start: 50, end: 750 }, 0.5);
  assert.equal(result.speechSeconds, 0.5);
  assert.equal(result.speechBurstCount, 3);
  assert.equal(result.meanSpeechBurstSeconds, 0.5 / 3);
});

test('missing bins split speech bursts; overlapping bins do not double-count them', () => {
  const result = summarize([100, 150, 200, 400, 500].map((t) => ({ t, rms: 0.1 })),
    { name: 'gaps', start: 0, end: 500 }, 0.01);
  assert.equal(result.speechBurstCount, 2);
  assert.equal(result.meanSpeechBurstSeconds, 0.2);
});

test('silence and no samples have zero bursts and a zero mean', () => {
  for (const samples of [[], [{ t: 100, rms: 0 }]]) {
    const result = summarize(samples, { name: 'silent', start: 0, end: 100 }, 0.01);
    assert.equal(result.speechBurstCount, 0);
    assert.equal(result.meanSpeechBurstSeconds, 0);
  }
});

test('RMS summary rejects invalid phase windows, thresholds and samples', () => {
  const window = { name: 'invalid', start: 0, end: 100 };
  for (const phase of [{ ...window, end: 0 }, { ...window, start: NaN }, { ...window, end: Infinity },
    { ...window, name: '' }]) assert.throws(() => summarize([], phase, 0.01), /Invalid/);
  for (const threshold of [0, -1, NaN, undefined]) assert.throws(() => summarize([], window, threshold), /Invalid/);
  for (const samples of [null, [null], [{ t: NaN, rms: 0 }], [{ t: 100, rms: -1 }],
    [{ t: 100, rms: Infinity }], [{ t: 100, rms: 0 }, { t: 50, rms: 0 }]]) {
    assert.throws(() => summarize(samples, window, 0.01), /Invalid/);
  }
});

test('timer jitter within the 50ms gap tolerance preserves a speech burst', () => {
  const result = summarize([100, 201, 300].map((t) => ({ t, rms: 0.1 })),
    { name: 'jitter-burst', start: 0, end: 300 }, 0.01);
  assert.equal(result.speechBurstCount, 1);
  assert.equal(result.meanSpeechBurstSeconds, 0.299);
});

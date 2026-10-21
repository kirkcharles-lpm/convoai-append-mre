import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reproduce } from '../src/repro.mjs';

async function isolated(run) {
  mkdirSync('.cache', { recursive: true });
  const cwd = process.cwd();
  process.chdir(mkdtempSync(join(resolve('.cache'), 'lifecycle-')));
  try { return await run(); } finally { process.chdir(cwd); }
}

test('missing .env fails before dependencies, browser startup or network access', () => {
  mkdirSync('.cache', { recursive: true });
  const cwd = mkdtempSync(join(resolve('.cache'), 'missing-env-'));
  const result = spawnSync(process.execPath, [resolve('src/repro.mjs')], { cwd, env: {}, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing .env.*cp .env.example .env/);
});

test('Ctrl-C during /join waits for agent_id, then always leaves and closes listener', async () => {
  const calls = [];
  const c = { avatar: 'none', listenUid: 101, rmsThreshold: 0.01 };
  const before = process.listenerCount('SIGINT');
  const result = await isolated(() => reproduce(c, {
    log() {}, tokens: { agent: '<fixture>' }, listenerToken: '<fixture>',
    startListener: async () => ({ close: async () => calls.push('close') }),
    api: {
      join: async () => { calls.push('join'); process.emit('SIGINT'); return { agent_id: 'fixture' }; },
      leave: async (id) => { assert.equal(id, 'fixture'); calls.push('leave'); },
    },
  }));
  assert.equal(result, 130);
  assert.deepEqual(calls, ['join', 'leave', 'close']);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('a readiness failure still leaves; a failed /leave gets one retry', async () => {
  const calls = [];
  const result = await isolated(() => reproduce({ avatar: 'none', listenUid: 101, rmsThreshold: 0.01 }, {
    log() {}, tokens: { agent: '<fixture>' }, listenerToken: '<fixture>',
    startListener: async () => ({
      check: async () => { throw new Error('Injected browser failure'); },
      close: async () => { calls.push('close'); },
    }),
    api: {
      join: async () => ({ agent_id: 'fixture' }),
      speak: async () => {},
      leave: async () => { calls.push('leave'); if (calls.length === 1) throw new Error('Injected failure'); },
    },
  }));
  assert.equal(result, 2);
  assert.deepEqual(calls, ['leave', 'leave', 'close']);
});

for (const scenario of [
  { name: 'healthy', reasons: [] },
  { name: 'silent recovery', silentRecovery: true, reasons: ['audio died'] },
  { name: 'queued line dropped', dropQueued: true, reasons: ['queued line dropped'] },
  { name: 'unpublished alone', unpublished: true, reasons: ['audio track unpublished while agent RUNNING'] },
  { name: 'all symptoms', dropQueued: true, silentRecovery: true, unpublished: true,
    reasons: ['queued line dropped', 'audio died', 'audio track unpublished while agent RUNNING'] },
  { name: 'stopped and unpublished', status: 'STOPPED', unpublished: true, invalid: true },
  { name: 'failed', status: 'FAILED', invalid: true },
  { name: 'incomplete coverage and unpublished', lowCoverage: true, unpublished: true, invalid: true },
]) {
  test(`complete offline runner: ${scenario.name}`, async (t) => {
    const { silentRecovery } = scenario;
    t.mock.method(console, 'log', () => {});
    let table;
    t.mock.method(console, 'table', (rows) => { table = rows; });
    let clock = 0;
    let audibleUntil = 1000;
    let sample;
    let phase;
    const logs = [];
    const calls = [];
    const c = { avatar: 'none', listenUid: 101, rmsThreshold: 0.01 };
    let summary;
    let queuedSends = 0;
    const code = await isolated(async () => {
      const result = await reproduce(c, {
        now: () => clock,
        tokens: { agent: '<fixture>' }, listenerToken: '<fixture>',
        log: (message) => {
          logs.push(message);
          const match = message.match(/^PHASE (\S+) START/);
          if (match) phase = match[1];
          if (phase === 'recovery-serial' && silentRecovery) audibleUntil = clock;
        },
        sleep: async (ms) => {
          clock += ms;
          if (!(scenario.lowCoverage && phase === 'recovery-serial' && Math.floor(clock / 100) % 2)) {
            sample({ t: clock, rms: clock < audibleUntil ? 0.1 : 0 });
          }
        },
        startListener: async (_c, _token, options) => {
          sample = options.onSample;
          return { check: async () => ({ published: !(scenario.unpublished && phase === 'recovery-serial') }),
            close: async () => calls.push('close') };
        },
        api: {
          join: async () => ({ agent_id: 'fixture' }),
          speak: async (_id, _text, priority) => {
            assert.equal(priority, 'APPEND');
            if (phase === 'two-queued' && scenario.dropQueued && ++queuedSends % 2 === 0) return;
            if (!(phase === 'recovery-serial' && silentRecovery)) audibleUntil = Math.max(clock, audibleUntil) + 4000;
          },
          query: async () => ({ status: scenario.status || 'RUNNING' }),
          leave: async () => calls.push('leave'),
        },
      });
      summary = JSON.parse(readFileSync('out/summary.json', 'utf8'));
      return result;
    });
    const expectedCode = scenario.invalid ? 2 : scenario.reasons.length ? 1 : 0;
    assert.equal(code, expectedCode);
    assert.equal(summary.exitCode, expectedCode);
    if (scenario.invalid) {
      assert.equal(summary.verdict, null);
      assert.deepEqual(summary.reasons, []);
      assert.ok(logs.some((message) => message.startsWith('ERROR:')));
    } else {
      assert.equal(table.length, 4);
      assert.equal(summary.verdict, scenario.reasons.length ? 'REPRODUCED' : 'NOT REPRODUCED');
      assert.deepEqual(summary.reasons, scenario.reasons);
      assert.equal(summary.queuedSpeechRatio, summary.phases[2].speechPercent / summary.phases[1].speechPercent);
      assert.equal(summary.audioPublished, !scenario.unpublished);
      assert.ok(logs.some((message) => message.includes('speech ratio=')));
      for (const reason of scenario.reasons) assert.ok(logs.includes(`REASON: ${reason}`));
      for (const [i, row] of summary.phases.entries()) {
        assert.ok(row.speechBurstCount >= 0);
        const expectedMean = row.speechBurstCount ? row.speechSeconds / row.speechBurstCount : 0;
        assert.ok(Math.abs(row.meanSpeechBurstSeconds - expectedMean) < 1e-12);
        assert.equal(table[i]['mean speech burst (s)'], row.meanSpeechBurstSeconds.toFixed(2));
      }
      assert.ok(logs.includes(`${summary.verdict} avatar=none`));
    }
    assert.deepEqual(calls, ['leave', 'close']);
  });
}

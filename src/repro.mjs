import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv, readConfig } from './config.mjs';
import { buildJoinBody, LINE } from './join-body.mjs';
import { PHASES, runPhase } from './phases.mjs';
import { summarize, verdict } from './metrics.mjs';

export async function reproduce(c, overrides = {}) {
  const { createAgora, publisherToken, listenerToken } = await import('./agora.mjs');
  const { startListener } = await import('../listener/run.mjs');
  const now = overrides.now || (() => performance.now());
  const origin = now();
  const log = overrides.log || ((message) => console.log(`${new Date().toISOString()} +${((now() - origin) / 1000).toFixed(1)}s ${message}`));
  const api = overrides.api || createAgora(c, { log });
  const abort = overrides.abort || new AbortController();
  const signal = abort.signal;
  const stop = (name) => { log(`${name}: stopping; /leave will run.`); abort.abort(new Error(name)); };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  mkdirSync('out', { recursive: true });
  const csv = openSync('out/timeline.csv', 'w');
  writeSync(csv, 't,state,rms\n');
  const samples = [];
  let bucket;
  let listener;
  let agentId;
  let code = 2;
  let phaseOrigin;
  let result;
  let finalWindow;
  let agentStatus;
  let audioPublished;
  const flush = () => {
    if (!bucket?.count) return;
    const line = `${bucket.second},${bucket.speech ? 'speech' : 'silence'},${Math.sqrt(bucket.energy / bucket.count).toFixed(6)}`;
    writeSync(csv, `${line}\n`);
    console.log(line);
    bucket = undefined;
  };
  const onSample = (sample) => {
    samples.push(sample);
    if (phaseOrigin === undefined) return;
    const second = Math.floor((sample.t - phaseOrigin) / 1000);
    if (bucket && bucket.second !== second) flush();
    bucket ||= { second, count: 0, energy: 0, speech: false };
    bucket.count++;
    bucket.energy += sample.rms ** 2;
    bucket.speech ||= sample.rms >= c.rmsThreshold;
  };
  const sleep = async (ms) => {
    // Health and signal checks continue even during the 9-second queue cadence.
    const end = now() + ms;
    while (now() < end) {
      signal.throwIfAborted();
      await (overrides.sleep || ((n) => delay(n, undefined, { signal })))(Math.min(100, end - now()));
      if (listener) await listener.check();
    }
    signal.throwIfAborted();
  };
  const speechSince = (since) => samples.some((s) => s.t >= since && s.rms >= c.rmsThreshold);
  const waitForStart = async (since, deadline) => {
    const limit = Math.min(deadline, now() + 8000);
    while (now() < limit && !speechSince(since)) await sleep(100);
    if (!speechSince(since)) throw new Error('No decoded speech within 8 seconds of the two-queued seed. Run invalid.');
  };
  const waitForEnd = async (since, deadline) => {
    const startLimit = Math.min(deadline, now() + 8000);
    while (now() < startLimit && !speechSince(since)) await sleep(100);
    // Bounded wait permits silent recovery to finish and receive a verdict.
    if (!speechSince(since)) return;
    while (now() < deadline) {
      const lastSpeech = samples.findLast((s) => s.rms >= c.rmsThreshold)?.t || since;
      if (now() - lastSpeech >= 700) return;
      await sleep(100);
    }
  };
  const rows = [];
  const boundaries = [];
  try {
    signal.throwIfAborted();
    const tokens = overrides.tokens || {
      agent: publisherToken(c),
      ...(c.avatar === 'lemonslice' ? { avatar: publisherToken(c, c.avatarUid) } : {}),
    };
    const name = `append-mre-${randomUUID()}`;
    log(`avatar=${c.avatar} listen_uid=${c.listenUid} threshold=${c.rmsThreshold}; ${PHASES.reduce((sum, p) => sum + p.durationMs, 0) / 1000} seconds of phases`);
    listener = await (overrides.startListener || startListener)(c, overrides.listenerToken || listenerToken(c), { now, log, onSample });
    signal.throwIfAborted();
    // Do not cancel an in-flight /join on Ctrl-C: obtain its ID, then leave in finally.
    const readySince = now();
    const joined = await api.join(buildJoinBody(c, tokens, name));
    agentId = joined?.agent_id;
    if (!agentId) throw new Error('/join did not return agent_id.');
    signal.throwIfAborted();
    // Audience presence need not trigger automatic greetings. Warm up explicitly.
    log('Warmup APPEND (outside timed phases)');
    await api.speak(agentId, LINE, 'APPEND');
    const readyDeadline = readySince + 60000;
    while (now() < readyDeadline) {
      if ((await listener.check()).published && speechSince(readySince)) break;
      await sleep(100);
    }
    if (!(await listener.check()).published || !speechSince(readySince)) {
      throw new Error('Startup: no published, decoded warmup audio in 60 seconds. Check LISTEN_UID and vendor configuration.');
    }
    await waitForEnd(readySince, now() + 15000);
    await sleep(3000);
    let sequence = 0;
    const send = async () => {
      signal.throwIfAborted();
      log(`speak #${++sequence} APPEND`);
      await api.speak(agentId, LINE, 'APPEND');
    };
    for (const phase of PHASES) {
      if (phaseOrigin === undefined) phaseOrigin = now();
      log(`PHASE ${phase.name} START (${phase.durationMs / 1000}s)`);
      const boundary = await runPhase(phase, { now, sleep, send, waitForStart, waitForEnd });
      // Obtain the last 100ms bin before summarizing the exact phase window.
      await sleep(100);
      boundaries.push({ ...boundary, start: boundary.start - phaseOrigin, end: boundary.end - phaseOrigin });
      const row = summarize(samples, boundary, c.rmsThreshold);
      rows.push(row);
      log(`PHASE ${phase.name} END`);
      if (row.coveragePercent < 95) throw new Error(`${phase.name}: less than 95% RMS sampling coverage. Run invalid.`);
      if (phase.name === 'serial' && row.speechPercent < 20) {
        throw new Error('Serial baseline has less than 20% speech. Fix baseline audio before interpreting recovery.');
      }
    }
    const status = await api.query(agentId);
    log(`Agent final status=${['IDLE', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED'].includes(status?.status) ? status.status : 'unknown'}`);
    const finalState = await listener.check();
    log(`Target audio still published=${finalState.published}`);
    agentStatus = status?.status;
    audioPublished = finalState.published;
    console.table(rows.map((r) => ({ phase: r.phase,
      'speech seconds': r.speechSeconds.toFixed(1), '% speech': r.speechPercent.toFixed(1),
      'longest silence (s)': r.longestSilence.toFixed(1),
      'mean speech burst (s)': r.meanSpeechBurstSeconds.toFixed(2),
    })));
    const recovery = boundaries.at(-1);
    finalWindow = summarize(samples, { name: 'recovery-final-30s', start: recovery.end + phaseOrigin - 30000, end: recovery.end + phaseOrigin }, c.rmsThreshold);
    log(`recovery final 30 s: ${finalWindow.speechPercent.toFixed(1)}% speech`);
    result = verdict({
      oneQueuedSpeechPercent: rows.find((r) => r.phase === 'one-queued').speechPercent,
      twoQueuedSpeechPercent: rows.find((r) => r.phase === 'two-queued').speechPercent,
      recoverySpeechPercent: rows.at(-1).speechPercent,
      finalWindowSpeechPercent: finalWindow.speechPercent,
      coveragePercents: rows.map((r) => r.coveragePercent), agentStatus, audioPublished,
    });
    log(`two-queued / one-queued speech ratio=${result.queuedSpeechRatio.toFixed(4)} (queued line dropped if <0.70)`);
    for (const reason of result.reasons) log(`REASON: ${reason}`);
    log(`${result.label} avatar=${c.avatar}`);
    code = result.exitCode;
  } catch (error) {
    log(`ERROR: ${signal.aborted ? 'Interrupted' : error.message}`);
    code = signal.aborted ? 130 : 2;
  } finally {
    // Cleanup is independent of the run's aborted signal. A failed leave gets one retry.
    if (agentId) {
      let left = false;
      for (let attempt = 1; attempt <= 2 && !left; attempt++) {
        try { await api.leave(agentId); left = true; log('Agent left.'); }
        catch { log(`/leave attempt ${attempt} failed.`); }
      }
      if (!left) { log('ERROR: /leave failed twice. Stop the session in Agora Console.'); code = 2; }
    }
    try { await listener?.close(); } catch { log('ERROR: listener cleanup failed.'); code = 2; }
    flush();
    closeSync(csv);
    writeFileSync('out/summary.json', `${JSON.stringify({
      avatar: c.avatar, listenUid: c.listenUid, rmsThreshold: c.rmsThreshold,
      phases: rows, boundaries, exitCode: code,
      verdict: result?.label ?? null, queuedSpeechRatio: result?.queuedSpeechRatio ?? null,
      reasons: result?.reasons ?? [], finalWindow: finalWindow ?? null,
      agentStatus: agentStatus ?? null, audioPublished: audioPublished ?? null,
    }, null, 2)}\n`);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await reproduce(readConfig(loadEnv())); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 2; }
}

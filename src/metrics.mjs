export function summarize(samples, { name, start, end }, threshold) {
  if (!Array.isArray(samples) || typeof name !== 'string' || !name ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      !Number.isFinite(threshold) || threshold <= 0) {
    throw new Error('Invalid samples, phase window or RMS threshold.');
  }
  let speechMs = 0;
  let speechBurstCount = 0;
  let inSpeech = false;
  let silenceMs = 0;
  let longestMs = 0;
  let coverageMs = 0;
  let previousEnd = start;
  let previousTime = -Infinity;
  // Each RMS observation represents at most the preceding 100ms. Missing browser
  // ticks are unknown, never silently counted as measured silence.
  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.t) || sample.t < previousTime ||
        !Number.isFinite(sample.rms) || sample.rms < 0) {
      throw new Error('Invalid RMS sample: finite, nonnegative RMS and ordered finite times required.');
    }
    previousTime = sample.t;
    const from = Math.max(start, previousEnd, sample.t - 100);
    const to = Math.min(end, sample.t);
    const dt = Math.max(0, to - from);
    if (!dt) continue;
    // Use the existing 50ms gap tolerance for speech as well as silence, so
    // ordinary timer jitter does not split a burst into individual samples.
    if (from - previousEnd > 50) { inSpeech = false; silenceMs = 0; }
    previousEnd = to;
    coverageMs += dt;
    if (sample.rms >= threshold) {
      if (!inSpeech) speechBurstCount++;
      inSpeech = true;
      speechMs += dt;
      silenceMs = 0;
    } else {
      inSpeech = false;
      silenceMs += dt;
      longestMs = Math.max(longestMs, silenceMs);
    }
  }
  return {
    phase: name, speechSeconds: speechMs / 1000,
    speechPercent: 100 * speechMs / (end - start), longestSilence: longestMs / 1000,
    coveragePercent: 100 * coverageMs / (end - start),
    speechBurstCount,
    meanSpeechBurstSeconds: speechBurstCount ? speechMs / speechBurstCount / 1000 : 0,
  };
}

// All reasons are independent; validity checks take precedence over symptoms.
export function verdict({ oneQueuedSpeechPercent, twoQueuedSpeechPercent,
  recoverySpeechPercent, finalWindowSpeechPercent, coveragePercents, agentStatus, audioPublished } = {}) {
  for (const p of [oneQueuedSpeechPercent, twoQueuedSpeechPercent, recoverySpeechPercent, finalWindowSpeechPercent]) {
    if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error('Speech percentage must be between 0 and 100.');
  }
  if (oneQueuedSpeechPercent === 0) throw new Error('One-queued speech percentage must be positive to compute the ratio. Run invalid.');
  if (!Array.isArray(coveragePercents) || coveragePercents.length !== 4 ||
      coveragePercents.some((p) => !Number.isFinite(p) || p < 95 || p > 100)) {
    throw new Error('Every phase must have at least 95% RMS sampling coverage. Run invalid.');
  }
  if (agentStatus !== 'RUNNING') throw new Error('Agent is not RUNNING. Run invalid.');
  if (typeof audioPublished !== 'boolean') throw new Error('Target audio publication state must be boolean. Run invalid.');
  const queuedSpeechRatio = twoQueuedSpeechPercent / oneQueuedSpeechPercent;
  const reasons = [];
  if (queuedSpeechRatio < 0.70) reasons.push('queued line dropped');
  if (finalWindowSpeechPercent < 10 || recoverySpeechPercent < 20) reasons.push('audio died');
  if (!audioPublished) reasons.push('audio track unpublished while agent RUNNING');
  return { label: reasons.length ? 'REPRODUCED' : 'NOT REPRODUCED',
    exitCode: reasons.length ? 1 : 0, queuedSpeechRatio, reasons };
}

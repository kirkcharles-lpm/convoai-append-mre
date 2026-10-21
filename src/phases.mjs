export const PHASES = [
  { name: 'serial', durationMs: 60000 },
  { name: 'one-queued', durationMs: 60000, intervalMs: 4000, batch: 1 },
  { name: 'two-queued', durationMs: 120000, intervalMs: 9000, batch: 2 },
  { name: 'recovery-serial', durationMs: 90000 },
];

// Injected clock/audio waits make the real scheduler testable without a network.
export async function runPhase(phase, io) {
  const start = io.now();
  const end = start + phase.durationMs;
  const until = async (target) => {
    if (target > io.now()) await io.sleep(target - io.now());
  };
  if (phase.batch) {
    // Seed one playing utterance so the first pair really queues TWO behind it.
    if (phase.batch === 2) {
      const seed = io.now();
      await io.send();
      await io.waitForStart(seed, end);
    }
    const anchor = io.now();
    for (let tick = anchor; tick < end; tick += phase.intervalMs) {
      await until(tick);
      if (io.now() >= end) break;
      if (io.now() - tick > 1000) throw new Error(`${phase.name}: schedule slipped over 1 second; run invalid.`);
      for (let n = 0; n < phase.batch; n++) {
        if (io.now() >= end) break;
        await io.send(); // Back to back, preserving REST acceptance order.
      }
    }
  } else {
    while (io.now() < end) {
      const sent = io.now();
      await io.send();
      await io.waitForEnd(sent, end);
      await until(Math.min(end, io.now() + 3000));
    }
  }
  await until(end);
  return { name: phase.name, start, end };
}

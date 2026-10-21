import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test('muted headless Chromium plays a synthetic stream and measures silence offline', {
  skip: !existsSync(chromium.executablePath()) ? 'Install Chromium to run the synthetic audio check.' : false,
  timeout: 15000,
}, async () => {
  const temp = resolve('.cache/tmp');
  mkdirSync(temp, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    let requests = 0;
    await page.route('**/*', (route) => { requests++; return route.abort(); });
    const samples = [];
    await page.exposeFunction('onAudioSample', (sample) => samples.push(sample));
    await page.exposeFunction('onListenerEvent', () => {});
    await page.evaluate(async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.2;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      window.testOscillator = oscillator;
      window.testContext = context;
      window.subscriptions = 0;
      const handlers = {};
      const track = { isPlaying: false, play() {
        window.testAudio = new Audio();
        window.testAudio.srcObject = destination.stream;
        window.testAudio.play();
        this.isPlaying = true;
      },
        stop() { this.isPlaying = false; window.testAudio.pause(); }, on() {},
        getMediaStreamTrack: () => destination.stream.getAudioTracks()[0] };
      window.testTrack = track;
      window.AgoraRTC = { setLogLevel() {}, disableLogUpload() {}, createClient: () => ({
        setClientRole: async () => {}, on: (name, fn) => { handlers[name] = fn; },
        subscribe: async () => { window.subscriptions++; }, leave: async () => {},
        join: async () => {
          handlers['user-published']({ uid: 999, audioTrack: track }, 'audio');
          handlers['user-published']({ uid: 101, audioTrack: track }, 'video');
          handlers['user-published']({ uid: 101, audioTrack: track }, 'audio');
        },
      }) };
    });
    await page.addScriptTag({ path: resolve('listener/page.js') });
    await page.evaluate(() => window.startListener({ listenUid: 101 }));
    await delay(900);
    assert.equal(await page.evaluate(() => window.testTrack.isPlaying), true);
    assert.equal(await page.evaluate(() => !window.testAudio.paused && window.testAudio.readyState >= 2), true);
    assert.equal(await page.evaluate(() => window.subscriptions), 1);
    assert.ok(samples.length >= 5);
    assert.ok(samples.every((s) => s.healthy));
    assert.ok(samples.some((s) => s.rms > 0.1));
    await page.evaluate(() => window.testOscillator.stop());
    await delay(500);
    assert.ok(samples.at(-1).rms < 0.001);
    assert.equal(requests, 0);
    await page.evaluate(async () => { await window.stopListener(); await window.testContext.close(); });
  } finally { await browser.close(); }
});

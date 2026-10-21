import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const bounded = (promise, ms) => Promise.race([promise, delay(ms, undefined, { ref: false }).then(() => {
  throw new Error('Listener browser operation timed out.');
})]);

export async function startListener(c, token, { now, onSample, log }) {
  const files = new Map(await Promise.all(['index.html', 'page.js'].map(async (name) =>
    [`/${name === 'index.html' ? '' : name}`, await readFile(new URL(name, import.meta.url))])));
  const server = createServer((request, response) => {
    const content = files.get(request.url);
    response.writeHead(content ? 200 : 404, {
      'Content-Type': request.url === '/page.js' ? 'text/javascript' : 'text/html',
      'Cache-Control': 'no-store',
    });
    response.end(content || 'Not found');
  });
  let browser;
  let page;
  const close = async () => {
    if (page) await bounded(page.evaluate(() => window.stopListener?.()), 2000).catch(() => {});
    await browser?.close();
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
  };
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const temp = resolve('.cache/tmp');
    mkdirSync(temp, { recursive: true });
    browser = await chromium.launch({
      headless: true,
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });
    page = await browser.newPage();
    let failure;
    let lastSample = now();
    page.on('pageerror', () => { failure = 'Listener page failed; check SDK loading and browser compatibility.'; });
    page.on('crash', () => { failure = 'Listener Chromium page crashed.'; });
    await page.exposeFunction('onAudioSample', (sample) => {
      lastSample = now();
      if (!sample.healthy) failure = 'Listener AudioContext or audio playback stopped.';
      if (!Number.isFinite(sample.rms)) failure = 'Listener emitted invalid RMS.';
      onSample({ t: lastSample, rms: sample.rms });
    });
    await page.exposeFunction('onListenerEvent', (event) => log(`RTC ${event} uid=${c.listenUid}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { timeout: 30000 });
    await bounded(page.evaluate((config) => window.startListener(config), {
      appId: c.appId, channel: c.channel, uid: c.listenerUid, token, listenUid: c.listenUid,
    }), 30000);
    lastSample = now();
    return {
      close,
      async check() {
        if (!browser.isConnected() || page.isClosed()) throw new Error('Listener browser closed.');
        if (failure) throw new Error(failure);
        if (now() - lastSample > 1500) throw new Error('Listener RMS sampling stalled for over 1.5 seconds.');
        const state = await bounded(page.evaluate(() => window.listenerState), 2000);
        if (state.error) throw new Error(state.error);
        return state;
      },
    };
  } catch (error) {
    await close();
    // Browser errors may include URLs or tokens; keep the user-facing error fixed.
    throw new Error('Listener startup failed. Install Chromium with: npx playwright install chromium. Check CDN access and RTC configuration.');
  }
}

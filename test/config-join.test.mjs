import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, loadEnv } from '../src/config.mjs';
import { buildJoinBody, LINE } from '../src/join-body.mjs';
import { createAgora, publisherToken, listenerToken } from '../src/agora.mjs';

// All credentials below are inert placeholders, never read from the real .env.
export const fixture = {
  AGORA_APP_ID: '0'.repeat(32), AGORA_APP_CERTIFICATE: '0'.repeat(32),
  AGORA_CUSTOMER_ID: '<fixture>', AGORA_CUSTOMER_SECRET: '<fixture>',
  CHANNEL: 'append-test', LLM_URL: 'https://example.invalid/chat/completions',
  LLM_API_KEY: '<fixture>', LLM_MODEL: '<fixture>', TTS_VENDOR: 'elevenlabs',
  TTS_KEY: '<fixture>', ELEVENLABS_BASE_URL: 'wss://example.invalid/v1',
  ELEVENLABS_MODEL: '<fixture>', ELEVENLABS_VOICE_ID: '<fixture>',
};

for (const vendor of ['elevenlabs', 'microsoft']) {
  for (const avatar of ['none', 'lemonslice']) {
    test(`join: ${vendor}, avatar=${avatar}`, () => {
      const c = readConfig({ ...fixture, TTS_VENDOR: vendor, AVATAR: avatar,
        MICROSOFT_REGION: '<fixture>', MICROSOFT_VOICE_NAME: '<fixture>',
        LEMONSLICE_API_KEY: '<fixture>', LEMONSLICE_IMAGE_URL: 'https://example.invalid/portrait.jpg' });
      const { name, properties: p } = buildJoinBody(c, { agent: '<agent-token>', avatar: '<avatar-token>' }, 'unique-test-name');
      assert.equal(name, 'unique-test-name');
      assert.equal(p.channel, 'append-test');
      assert.equal(p.agent_rtc_uid, '101');
      assert.deepEqual(p.remote_rtc_uids, ['103']);
      assert.equal(p.token, '<agent-token>');
      assert.equal(p.idle_timeout, 0);
      assert.deepEqual(p.llm, { url: c.llmUrl, api_key: '<fixture>', style: 'openai',
        params: { model: '<fixture>' } });
      assert.equal(LINE.split(' ').length, 12);
      assert.deepEqual(p.tts, { vendor, params: vendor === 'elevenlabs'
        ? { key: '<fixture>', base_url: 'wss://example.invalid/v1', model_id: '<fixture>', voice_id: '<fixture>' }
        : { key: '<fixture>', region: '<fixture>', voice_name: '<fixture>' } });
      if (avatar === 'none') {
        assert.equal(Object.hasOwn(p, 'avatar'), false);
        assert.equal(c.listenUid, 101);
      } else {
        assert.equal(c.listenUid, 102);
        assert.deepEqual(p.avatar, { vendor: 'generic', enable: true, params: {
          api_key: '<fixture>', api_base_url: 'https://lemonslice.com/api/liveai/agora',
          avatar_id: 'lemonslice', agent_image_url: c.avatarImage,
          agora_uid: '102', agora_token: '<avatar-token>',
        } });
        assert.throws(() => buildJoinBody(c, { agent: '<token>' }, 'unique'), /avatar publisher RTC token/);
      }
      assert.equal(JSON.stringify(p).includes('customerSecret'), false);
    });
  }
}

test('configuration rejects missing credentials, UID collisions and invalid controls', () => {
  assert.throws(() => readConfig({ ...fixture, TTS_KEY: '' }), /Missing TTS_KEY/);
  assert.throws(() => readConfig({ ...fixture, AVATAR: 'other' }), /AVATAR must/);
  assert.throws(() => readConfig({ ...fixture, TTS_VENDOR: 'other' }), /TTS_VENDOR must/);
  assert.throws(() => readConfig({ ...fixture, LISTENER_UID: '101' }), /distinct/);
  assert.throws(() => readConfig({ ...fixture, LISTEN_UID: '999' }), /LISTEN_UID/);
  assert.throws(() => readConfig({ ...fixture, RMS_THRESHOLD: '0' }), /RMS_THRESHOLD/);
  assert.throws(() => readConfig({ ...fixture, AGENT_UID: '4294967296' }), /numeric UID/);
  assert.throws(() => readConfig({ ...fixture, LLM_URL: 'bad' }), /HTTPS/);
  assert.throws(() => loadEnv(new URL('./missing.env', import.meta.url)), /Missing .env/);
});

test('official RTC token builders generate tokens locally for both roles', () => {
  const c = readConfig(fixture);
  for (const token of [publisherToken(c), publisherToken(c, 102), listenerToken(c)]) {
    assert.ok(token.startsWith('007'));
    assert.ok(token.length > 100);
  }
});

test('REST contract: exact paths, Basic auth, APPEND body and empty success responses', async () => {
  const calls = [];
  const api = createAgora(readConfig(fixture), { log() {}, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(calls.length === 1 ? '{"agent_id":"fixture-agent"}' : '', { status: 200 });
  } });
  assert.deepEqual(await api.join({ name: 'fixture' }), { agent_id: 'fixture-agent' });
  assert.equal(await api.speak('fixture-agent', LINE, 'APPEND'), null);
  await api.query('fixture-agent');
  await api.leave('fixture-agent');
  const base = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${fixture.AGORA_APP_ID}`;
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['POST', `${base}/join`], ['POST', `${base}/agents/fixture-agent/speak`],
    ['GET', `${base}/agents/fixture-agent`], ['POST', `${base}/agents/fixture-agent/leave`],
  ]);
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('<fixture>:<fixture>').toString('base64')}`);
  assert.deepEqual(JSON.parse(calls[1].body), { text: LINE, priority: 'APPEND', interruptable: false });
  assert.equal(calls[3].body, undefined);
  assert.throws(() => api.speak('fixture-agent', 'a'.repeat(513)), /512/);
});

test('HTTP failure does not expose a credential echoed by the server', async () => {
  const api = createAgora(readConfig(fixture), { log() {}, fetchImpl: async () =>
    new Response('do-not-echo-this-response', { status: 401 }) });
  await assert.rejects(api.query('fixture-agent'), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes('do-not-echo'), false);
    return true;
  });
});

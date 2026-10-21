import agoraToken from 'agora-token';

const { RtcTokenBuilder, RtcRole } = agoraToken;
const TOKEN_SECONDS = 3600; // Relative TTLs, not Unix timestamps (AccessToken2).

export function publisherToken(c, uid = c.agentUid) {
  return RtcTokenBuilder.buildTokenWithUid(c.appId, c.certificate, c.channel, uid,
    RtcRole.PUBLISHER, TOKEN_SECONDS, TOKEN_SECONDS);
}

export function listenerToken(c) {
  return RtcTokenBuilder.buildTokenWithUid(c.appId, c.certificate, c.channel, c.listenerUid,
    RtcRole.SUBSCRIBER, TOKEN_SECONDS, TOKEN_SECONDS);
}

// Docs: https://docs.agora.io/en/api-reference/api-ref/conversational-ai/speak
// Never log request/response bodies: vendors can echo credentials in errors.
export function createAgora(c, { fetchImpl = fetch, log = console.log } = {}) {
  const base = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${encodeURIComponent(c.appId)}`;
  const authorization = `Basic ${Buffer.from(`${c.customerId}:${c.customerSecret}`).toString('base64')}`;
  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { throw new Error(`${method} ${path}: network failure or 15-second timeout. No automatic retry.`); }
    log(`REST ${method} ${path} -> ${response.status}`);
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}. Check provider configuration and console logs.`);
    const text = await response.text();
    if (!text.trim()) return null;
    try { return JSON.parse(text); }
    catch { throw new Error(`${method} ${path}: expected JSON or an empty success body.`); }
  }
  const agentPath = (id) => `/agents/${encodeURIComponent(id)}`;
  return {
    join: (body) => request('POST', '/join', body),
    speak: (id, text, priority = 'APPEND') => {
      if (!['APPEND', 'INTERRUPT', 'IGNORE'].includes(priority)) throw new Error('Invalid speak priority.');
      if (!text || Buffer.byteLength(text) > 512) throw new Error('Speak text must be 1–512 UTF-8 bytes.');
      return request('POST', `${agentPath(id)}/speak`, { text, priority, interruptable: false });
    },
    leave: (id) => request('POST', `${agentPath(id)}/leave`),
    query: (id) => request('GET', agentPath(id)),
  };
}

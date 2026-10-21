import { readFileSync } from 'node:fs';

// A deliberately small .env reader: KEY=value, quotes and comments; no expansion.
export function loadEnv(path = '.env', shell = process.env) {
  let source;
  try { source = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing .env. Run: cp .env.example .env, then fill the required values.');
    throw error;
  }
  const values = {};
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid .env syntax at line ${index + 1}. Use KEY=value.`);
    let [, key, value] = match;
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.lastIndexOf(value[0]);
      if (end === 0 || !/^\s*(#.*)?$/.test(value.slice(end + 1))) {
        throw new Error(`Invalid .env quoting at line ${index + 1}.`);
      }
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    values[key] = value;
  }
  return { ...values, ...shell };
}

export function readConfig(env) {
  const need = (key) => {
    if (!env[key]?.trim()) throw new Error(`Missing ${key} in .env.`);
    return env[key].trim();
  };
  const uid = (key, fallback) => {
    const value = env[key]?.trim() || fallback;
    if (!/^\d+$/.test(value) || +value < 1 || +value > 4294967295) {
      throw new Error(`${key} must be a numeric UID from 1 to 4294967295.`);
    }
    return +value;
  };
  const https = (key) => {
    const value = need(key);
    try { if (new URL(value).protocol === 'https:') return value; } catch {}
    throw new Error(`${key} must be an HTTPS URL.`);
  };
  const avatar = env.AVATAR || 'none';
  const ttsVendor = need('TTS_VENDOR');
  if (!['none', 'lemonslice'].includes(avatar)) throw new Error('AVATAR must be none or lemonslice.');
  if (!['elevenlabs', 'microsoft'].includes(ttsVendor)) throw new Error('TTS_VENDOR must be elevenlabs or microsoft.');
  const c = {
    appId: need('AGORA_APP_ID'), certificate: need('AGORA_APP_CERTIFICATE'),
    customerId: need('AGORA_CUSTOMER_ID'), customerSecret: need('AGORA_CUSTOMER_SECRET'),
    channel: need('CHANNEL'), avatar, ttsVendor, ttsKey: need('TTS_KEY'),
    agentUid: uid('AGENT_UID', '101'), listenerUid: uid('LISTENER_UID', '103'),
    avatarUid: uid('AVATAR_UID', '102'), llmUrl: https('LLM_URL'),
    llmKey: need('LLM_API_KEY'), llmModel: need('LLM_MODEL'),
    rmsThreshold: +(env.RMS_THRESHOLD || '0.01'),
  };
  for (const key of ['appId', 'certificate']) {
    if (!/^[\da-f]{32}$/i.test(c[key])) throw new Error(`Agora ${key} must contain 32 hexadecimal characters.`);
  }
  if (Buffer.byteLength(c.channel) > 63 || /[^a-zA-Z0-9 !#$%&()+\-:;<=>?@[\]^_{|}~.,]/.test(c.channel)) {
    throw new Error('CHANNEL must use Agora-supported characters and be at most 63 bytes.');
  }
  if (!(c.rmsThreshold > 0 && c.rmsThreshold < 1)) throw new Error('RMS_THRESHOLD must be between 0 and 1.');
  const participants = [c.agentUid, c.listenerUid, ...(avatar === 'lemonslice' ? [c.avatarUid] : [])];
  if (new Set(participants).size !== participants.length) throw new Error('Agent, listener and active avatar UIDs must be distinct.');
  c.listenUid = uid('LISTEN_UID', String(avatar === 'none' ? c.agentUid : c.avatarUid));
  if (!participants.filter((id) => id !== c.listenerUid).includes(c.listenUid)) {
    throw new Error('LISTEN_UID must identify the agent or active avatar publisher.');
  }
  if (ttsVendor === 'elevenlabs') Object.assign(c, {
    ttsBaseUrl: need('ELEVENLABS_BASE_URL'), ttsModel: need('ELEVENLABS_MODEL'),
    ttsVoice: need('ELEVENLABS_VOICE_ID'),
  });
  else Object.assign(c, { ttsRegion: need('MICROSOFT_REGION'), ttsVoice: need('MICROSOFT_VOICE_NAME') });
  if (avatar === 'lemonslice') Object.assign(c, {
    avatarKey: need('LEMONSLICE_API_KEY'), avatarImage: https('LEMONSLICE_IMAGE_URL'),
  });
  return c;
}

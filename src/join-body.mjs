// Current REST schema: https://docs.agora.io/en/api-reference/api-ref/conversational-ai/join
// Avatar: https://docs.agora.io/en/ai/models/avatar/lemonslice
export const LINE = 'The quiet river carries little paper boats beneath the old wooden bridge.';

export function buildJoinBody(c, tokens, name) {
  if (!name || !tokens.agent) throw new Error('Join requires a unique name and agent RTC token.');
  const properties = {
    channel: c.channel,
    agent_rtc_uid: String(c.agentUid),
    remote_rtc_uids: [String(c.listenerUid)],
    token: tokens.agent,
    // Audience users are not always visible as hosts. Avoid the default 30s idle exit.
    idle_timeout: 0,
    llm: {
      url: c.llmUrl, api_key: c.llmKey, style: 'openai', params: { model: c.llmModel },
    },
    tts: {
      vendor: c.ttsVendor,
      params: c.ttsVendor === 'elevenlabs'
        ? { key: c.ttsKey, base_url: c.ttsBaseUrl, model_id: c.ttsModel, voice_id: c.ttsVoice }
        : { key: c.ttsKey, region: c.ttsRegion, voice_name: c.ttsVoice },
    },
  };
  if (c.avatar === 'lemonslice') {
    if (!tokens.avatar) throw new Error('LemonSlice requires an avatar publisher RTC token.');
    properties.avatar = {
      vendor: 'generic', enable: true,
      params: {
        api_key: c.avatarKey, api_base_url: 'https://lemonslice.com/api/liveai/agora',
        avatar_id: 'lemonslice', agent_image_url: c.avatarImage,
        agora_uid: String(c.avatarUid), agora_token: tokens.avatar,
      },
    };
  }
  return { name, properties };
}

/* global AgoraRTC */
window.startListener = async ({ appId, channel, uid, token, listenUid }) => {
  AgoraRTC.setLogLevel(4);
  AgoraRTC.disableLogUpload();
  const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
  await client.setClientRole('audience');
  const context = new AudioContext();
  await context.resume();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  const data = new Float32Array(analyser.fftSize);
  // Keep the graph rendering; actual playback/decoding comes from track.play().
  const gain = context.createGain();
  gain.gain.value = 0;
  analyser.connect(gain).connect(context.destination);
  let source;
  let track;
  window.listenerState = { published: false, error: null };
  const event = (kind) => window.onListenerEvent(kind);
  const fail = () => { window.listenerState.error = 'Listener subscription or playback failed.'; };
  const attach = async (user, type) => {
    if (String(user.uid) !== String(listenUid) || type !== 'audio') return;
    await client.subscribe(user, 'audio');
    track = user.audioTrack;
    track.play();
    const connect = () => {
      source?.disconnect();
      source = context.createMediaStreamSource(new MediaStream([track.getMediaStreamTrack()]));
      source.connect(analyser);
    };
    connect();
    track.on('track-updated', connect);
    window.listenerState.published = true;
    event('audio-published');
  };
  client.on('user-published', (user, type) => { attach(user, type).catch(fail); });
  client.on('user-unpublished', (user, type) => {
    if (String(user.uid) !== String(listenUid) || type !== 'audio') return;
    window.listenerState.published = false;
    source?.disconnect();
    source = undefined;
    track = undefined;
    event('audio-unpublished');
  });
  client.on('user-left', (user) => {
    if (String(user.uid) === String(listenUid)) event('publisher-left');
  });
  client.on('connection-state-change', (state) => {
    if (state === 'DISCONNECTED') window.listenerState.error = 'RTC listener disconnected.';
  });
  AgoraRTC.onAutoplayFailed = () => { window.listenerState.error = 'Chromium blocked audio autoplay.'; };
  await client.join(appId, channel, token, uid);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    const rms = source ? Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length) : 0;
    window.onAudioSample({ rms, healthy: context.state === 'running' && (!source || !!track?.isPlaying) });
  }, 100);
  window.stopListener = async () => {
    clearInterval(timer);
    track?.stop();
    source?.disconnect();
    await client.leave();
    await context.close();
  };
};

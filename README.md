# ConvoAI APPEND audio MRE

Observed 2026-10-21: with short REST `/speak` messages using `priority: "APPEND"`, LemonSlice output drops to roughly half as much speech when two lines are queued together instead of one. This happened in all three initial LemonSlice runs. The primary verdict now tests that repeatable symptom; recovery silence remains a separate symptom. The same workload without an avatar provides a comparison.

## Setup

Node 20 or newer. Only npm dependencies: official `agora-token` and `playwright`, pinned in the lockfile.

1. Install: `npm i`
2. Install Chromium: `npx playwright install chromium`
3. Copy: `cp .env.example .env`
4. Fill Agora, LLM and your selected TTS credentials in `.env`. For LemonSlice, also fill its key and a public image URL.

The Agora project must have ConvoAI enabled. LLM URL means the full HTTPS OpenAI-compatible chat completions URL; its key and model are required by this example. The listener never publishes microphone audio, so `/speak` uses TTS without initiating LLM turns. `.env` supports `KEY=value`, quotes and comments, without interpolation or multiline values. Shell variables override `.env`; a missing `.env` always fails before browser startup or network access.

## Run each path

```sh
AVATAR=none npm run repro
```

After that run, save `out/` if needed, then compare:

```sh
AVATAR=lemonslice npm run repro
```

Each command creates a fresh agent, runs 330 seconds of phases plus startup/cleanup, and calls `/leave`. Allow about 7 minutes per run. Default UIDs: agent 101, listener 103, avatar 102. `LISTEN_UID` selects agent 101 without an avatar and avatar 102 with LemonSlice; set it to 101 with LemonSlice to inspect the agent's publisher separately if needed. Use an otherwise empty channel. Output files are replaced on each run; they are git-ignored.

| Phase | Duration | Requests |
| --- | ---: | --- |
| serial | 60 s | Send one; detect its audio ending; wait another 3 s |
| one-queued | 60 s | One every 4 s |
| two-queued | 120 s | Seed one playing line, then a back-to-back pair every 9 s |
| recovery-serial | 90 s | Same serial pacing, without restarting |

Every line is the same twelve-word sentence, approximately four seconds at a normal voice speed. Actual duration depends on the TTS voice/model. Queued schedules use fixed clock deadlines, independent of REST latency; a delay exceeding one second invalidates the run. Pairs are sent sequentially immediately after each HTTP response so request order is explicit. The two-queued seed is inside its 120-second phase; the first pair waits for decoded speech. This ensures the initial pair is queued behind playing audio; later queue depth depends on actual TTS duration.

## Measurement and interpretation

Chromium loads Web SDK 4.24.8 from Agora's CDN, joins as an audience, subscribes only to `LISTEN_UID`, and calls `audioTrack.play()`. `--mute-audio` suppresses speaker output while allowing decoding. An `AnalyserNode` samples normalized PCM RMS every 100 ms. A running Web Audio graph and active playback are checked throughout the run.

`RMS_THRESHOLD=0.01` classifies each sample as speech or silence. `out/timeline.csv` and stdout contain one line per second: `t,state,rms`. `t=0` is the start of serial; each row reports combined RMS and says `speech` if any sample crossed the threshold. The phase table uses **100 ms bins**, so speech seconds can be fractional. Longest silence includes leading/trailing silent bins. Missing browser ticks reduce measurement coverage; less than 95% coverage invalidates a phase. A speech burst is a run of consecutive speech bins within a phase. Silence or an unmeasured gap longer than 50 ms ends the burst; phase edges clip it. The 50 ms gap tolerance, also used for silence runs, prevents ordinary timer jitter from splitting bursts. Mean burst length is total measured speech time divided by the number of bursts, or zero when there are none. The table prints each phase's mean burst length.

`out/summary.json` records phase boundaries, raw phase metrics (including `speechBurstCount` and `meanSpeechBurstSeconds`), mode, threshold and exit code. It also records `queuedSpeechRatio`, all `reasons`, the `verdict`, the final recovery window metrics, final `agentStatus` and `audioPublished`. If validity checks prevent scoring, the verdict and ratio are `null` and reasons are empty. Cleanup errors still override the exit code even if symptoms were scored.

Serial completion is inferred from at least one speech sample followed by 700 ms below the threshold; it then waits 3 s. If no speech starts within 8 s, serial pacing continues after the 3 s gap, allowing a completely silent recovery to be scored. An explicit `/speak` warms up the subscription before phase timing; automatic greetings are omitted because audience presence need not trigger one. No warmup audio, a serial baseline below 20% speech, disconnected/stalled measurement, a stopped or failed agent, or zero speech in one-queued is an **invalid run** (exit 2). A target audio track unpublished at the end is a reproduction symptom when the agent is still RUNNING and every phase has at least 95% sampling coverage.

The verdict prints the two-queued / one-queued speech ratio and every reason that fired. Any of these makes a valid run **REPRODUCED** (exit 1):

1. **queued line dropped**: two-queued speech percentage is less than 0.70 times one-queued speech percentage in the same run. In plain words, queuing pairs produces less than 70% as much speech as queuing single lines. A ratio of exactly 0.70 does not trigger this reason.
2. **audio died**: recovery as a whole has less than 20% speech, or its final 30 seconds have less than 10% speech while serial lines are still being sent. Both tests share this reason, so it prints once.
3. **audio track unpublished while agent RUNNING**: the target audio is unpublished at the end, despite a RUNNING agent and at least 95% coverage in every phase.

Reasons 2 and 3 also fire if something outside ConvoAI and LemonSlice ends the avatar session during the run. Before reading them as a vendor symptom, check the log for `RTC publisher-left uid=<avatar uid>`: an avatar that leaves the channel was ended, not silenced. See the correction below.

Exit codes: **0** = NOT REPRODUCED (no reason fired); **1** = REPRODUCED; **2** = invalid run or configuration/runtime/cleanup error; **130** = interruption with successful cleanup. A stopped or failed agent remains invalid even if other symptoms fired.

### First three runs per mode

Same project and same spoken line; each row summarizes three runs. Phase columns are speech percentages.

| Mode | serial | one-queued | two-queued | recovery | longest recovery silence |
| --- | --- | --- | --- | --- | --- |
| no avatar ×3 | 40–41% | 76–78% | 70–71% | 42–43% | 4.5–4.6 s |
| LemonSlice ×3 | 36–37% | 75–77% | 36–39% | 27–37%\* | 5.6–26.3 s\* |

The two-queued / one-queued ratios were 0.467–0.515 with LemonSlice and 0.894–0.935 without an avatar. With two lines queued, LemonSlice speech bursts were about one line long (≈3.2 s), compared with ≈6.7 s without an avatar. This is consistent with one line of each queued pair playing and the other being dropped, in 3 of 3 LemonSlice runs. The listener measures received audio, so it cannot identify which individual line was dropped or independently verify server-side TTS production or internal error events.

The **0.70 threshold was chosen after these first runs**, then confirmed on fresh runs below.

\* See the correction below: the LemonSlice recovery-phase values were affected by our own environment.

### Confirmation runs (fresh, after the threshold was fixed)

Two more runs per mode, alternating modes, same project and line, with the 0.70 threshold unchanged:

| Mode | Run | two-queued / one-queued ratio | Verdict |
| --- | --- | --- | --- |
| no avatar | 1 | 0.890 | NOT REPRODUCED |
| LemonSlice | 1 | 0.475 | REPRODUCED (queued line dropped) |
| no avatar | 2 | 0.901 | NOT REPRODUCED |
| LemonSlice | 2 | 0.480 | REPRODUCED (queued line dropped) |

Across all five runs per mode the ratios separate cleanly: LemonSlice 0.467–0.515, no avatar 0.890–0.935.

### Correction (2026-10-22): late-run silences in our LemonSlice runs came from our own environment

In our project, a session-cleanup job outside this repository ended LemonSlice avatar sessions about five minutes after they started. In the three LemonSlice runs whose logs we kept and that ended with recovery silence or an unpublished avatar track, the avatar left the channel (`RTC publisher-left`) 310–340 s after the run started, while the agent was still RUNNING. The one other kept LemonSlice log shows no such exit and a normal recovery phase. The first run's log was not kept; its recovery silence falls in the same window. That exit was our cleanup job, not ConvoAI or LemonSlice, so please disregard the recovery-phase observations and the unpublished-track result.

The two-queued phase ends about 4.3 minutes into a run, before that cutoff, so **the queued-line-drop result above is unaffected**. In a project without such a job, the expected symptom is the queued-line drop only.

A healthy bare-agent run plus a failing avatar run points to the avatar-enabled path; if both fail, the failure also exists without the avatar. A clean run is evidence for that exact configuration, not proof the symptom is absent.

Cleanup handles SIGINT/Ctrl-C and SIGTERM, waits for an in-flight `/join` response, and attempts `/leave` twice independently of cancellation. Network loss, a lost `/join` response before its ID is known, or SIGKILL cannot guarantee remote cleanup; stop any remaining session in Agora Console. Agent idle timeout is disabled to prevent the audience-only session ending after the default 30 seconds.

## Offline checks

```sh
npm test
```

Tests use inert fixtures, stubbed REST, virtual phase clocks and Node's built-in runner. They cover both TTS vendors with/without an avatar, REST payloads, local RTC tokens, scheduler timing, RMS summaries and burst lengths, the strict 0.70 queue-ratio boundary, each symptom alone and together, recovery boundaries, unpublished tracks, invalid inputs/status/coverage, missing `.env`, JSON/stdout reporting, and cleanup on interruption/errors. If Chromium is installed, a synthetic-audio test checks the real listener page's playback/RMS with a stub SDK and all network requests blocked; otherwise that check is skipped. Tests do not load the CDN or contact Agora, LemonSlice, TTS or LLM services. A real reproduction requires your credentials and the run commands above.

## Questions for Agora and LemonSlice

1. What queue depth does `/speak` APPEND support, and what happens when it is exceeded?
2. Does the failure originate in ConvoAI's audio queue or its avatar forwarding/playback path? Compare the same TTS settings in both modes.
3. Is there a per-utterance **started playing** event, with a correlation ID, distinct from TTS generation or REST acceptance?

## Related incident

[2026-10-22: mid-line audio stall and a lost APPEND line](incidents/2026-10-22-mid-line-stall.md). With strictly one
line at a time (no queueing), the avatar's audio stopped mid-sentence, the next APPEND line was never played, and
normal playback resumed about 10 s later. The report has the agent ID, channel, exact UTC timestamps and our questions.

## API sources and choices

Checked against public Agora documentation on 2026-10-21: [join](https://docs.agora.io/en/api-reference/api-ref/conversational-ai/join), [speak](https://docs.agora.io/en/api-reference/api-ref/conversational-ai/speak), [leave](https://docs.agora.io/en/api-reference/api-ref/conversational-ai/leave), [query](https://docs.agora.io/en/api-reference/api-ref/conversational-ai/query), [LemonSlice](https://docs.agora.io/en/ai/models/avatar/lemonslice), [ElevenLabs](https://docs.agora.io/en/ai/models/tts/elevenlabs), [Microsoft](https://docs.agora.io/en/ai/models/tts/microsoft), [Web SDK setup](https://docs.agora.io/en/realtime-media/rtc/voice-quickstart/web).

LemonSlice follows the current public `vendor: "generic"`, `avatar_id: "lemonslice"`, `agent_image_url` shape. Optional avatar tuning is omitted. `/speak` always sends `interruptable: false`; there is no microphone source. No RTM client, webhooks, ASR customization, application code or automatic agent restart is included. Credentials and tokens stay in memory and `.env`; REST bodies, SDK logs and vendor error bodies are never printed or written to output.

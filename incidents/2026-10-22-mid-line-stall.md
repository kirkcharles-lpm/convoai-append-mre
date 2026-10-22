# Incident: mid-line audio stall and a lost APPEND line (2026-10-22)

Seen once on our stage environment during a scripted 10-minute run: 1 occurrence in 11 runs that day. We haven't
reproduced it on demand yet.

## Setup (API level)
- **Agent:** Agora ConvoAI with a custom LLM endpoint that returns audio (pre-rendered PCM, 24 kHz mono).
- **Avatar:** LemonSlice; agent uid 101, avatar uid 102.
- **Sending:** one `/speak` (`priority: "APPEND"`) at a time.
  - Each line goes out only after the previous line's audio has finished: its observed in-channel start plus its exact
    PCM duration.
  - Nothing is queued or overlapping, unlike the `two-queued` phase of this repository's MRE.
- **IDs:** agent `A46AD92RE39JF28LE25PY24DR56ME97J`, channel `schedule-mvj7hqke-22v2t4`.
- **Agent lifetime:** created 07:15:18 UTC and stopped normally at 07:25:52 UTC.

## Timeline (UTC, 2026-10-22)

| Time | Event |
| --- | --- |
| 07:18:42.08 | `/speak` line A (94 chars); 200 in 84 ms |
| 07:18:42.18 | Agent fetches line A audio from our LLM endpoint: 218,312 bytes of PCM (4.55 s), served in 100 ms |
| 07:18:43.56 | Line A audible in the channel (our in-channel recorder, avatar uid 102 audio) |
| **07:18:45.44** | **Audio stops mid-sentence, 1.88 s into the 4.55 s clip** |
| 07:18:48.08 | `/speak` line B (35 chars), sent when line A would have finished (start + PCM duration); 200 in 80 ms |
| 07:18:48.18 | Agent fetches line B audio: 80,106 bytes (1.67 s), served in 49 ms |
| — | **Line B is never heard** |
| 07:18:53.87 | `/speak` line C; 200 |
| 07:18:55.86 | Line C audible. Playback is normal for the rest of the run: 81 of 82 lines heard |

Silence lasted from 07:18:45.44 to 07:18:55.86, 10.4 s.

## What we checked on our side
- **No other request:** between 07:18:40 and 07:18:58 there was no other `/speak`, no `/think`, no interrupt, and no
  avatar action or pose call.
- **No self-interrupt:** the agent's `remote_rtc_uids` lists a uid that never joins, and `audio_scenario` is
  `"aiserver"`.
- **No recorder gap:** our recorder wrote continuous 5 s chunks, and the recording shows true silence (−50 dBFS) for
  the whole window.
- **No restart or error:** there was no LemonSlice session restart, and the agent status shows a normal stop with
  `message: ok`.

## Questions
1. What happened in the agent's audio output or the LemonSlice session between 07:18:45.4 and 07:18:55.9 UTC?
2. Why didn't line B, fetched at 07:18:48.18, play? Was it dropped because the avatar still treated line A as playing?
3. Is there an event or callback we can subscribe to for "audio stopped early" or "queued audio dropped", so we can
   detect and recover?

We can share a 23-second recording of the window privately on request.

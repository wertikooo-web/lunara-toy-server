# Lunara: Memory, Content, Conversation State, Audio Cache

This document fixes the architecture boundary for the toy server.

The most important rule:

```text
Memory ≠ Content
Content ≠ Conversation State
Audio Cache ≠ Memory
```

If these layers are mixed, Lumi starts to lose the thread of the dialogue, remember random STT noise, and treat prepared content as personal child memory.

## 1. Child Memory

Child Memory is what Lumi knows about the child personally.

Examples:

- child name
- age
- preferred address / nickname
- favorite color, animal, food, toy, game, cartoon, character
- pet name
- best friend first name
- current stable interests
- safe shared play world state

Storage:

```text
Postgres
```

Reason:

- structured data
- parent review and editing
- deletion must be possible
- should not be stored as loose files
- should not be mixed with content packs

Important rule:

Only explicit, stable, child-safe facts should enter memory. Random dialogue, unclear STT, self-listening artifacts, and generated replies must not become memory.

## 2. Memory Guard

Before running memory extraction, the server must check whether the transcript is safe and useful enough to remember.

Block memory update if the transcript:

- looks like STT garbage
- is likely a playback/self-listening artifact
- contains mixed-language filler like `thank you`, `subtitles`, `yeah boss`
- is too ambiguous
- does not contain an explicit child fact or explicit memory command
- looks like random words after a long playback

Example to block:

```text
А на Боку-ка реку царство и лёжа на Боку
```

Correct behavior:

```text
[MemoryGuard] skipped reason=...
```

No memory extraction. No OpenAI call for memory. No Postgres update.

## 3. Content Library

Content Library is prepared material for Lumi to speak or use in games.

Examples:

- riddles
- tongue twisters
- jokes
- facts
- mini-games
- story seeds
- roleplay prompts
- learning cards

Storage now:

```text
JSON files in repository
```

Storage later:

```text
S3 / Cloudflare R2 / Backblaze B2 + manifest
```

Rule:

Content Library is not child memory. Adding 150 tongue twisters or 150 jokes must not increase child memory.

Recommended future layout:

```text
data/content/riddles_ru.json
data/content/tongue_twisters_ru.json
data/content/jokes_ru.json
data/content/facts_ru.json
```

Or later:

```text
content-packs/riddles/ru/v1.json
content-packs/tongue_twisters/ru/v1.json
content-packs/jokes/ru/v1.json
```

## 4. Conversation State

Conversation State is the short-term thread of the current dialogue.

Examples:

- current mode: chat / riddle / story / game
- active riddle
- last Lumi question
- expected child reply
- pending offer
- last topic
- last child intent
- recent turns

Storage now:

```text
RAM in WebSocket/session state
```

Storage later:

```text
Redis / Upstash Redis with TTL
```

Rule:

Conversation State is not long-term memory. It can expire after 10–30 minutes.

## 5. Audio Cache

Audio Cache is generated audio files and prepared voice assets.

Examples:

- TTS responses
- cached riddles audio
- thinking phrases
- greeting audio
- retry audio
- content audio

Storage now:

```text
local app audio directory
```

Problem:

On Railway redeploy, local cache can disappear if persistent volume is not configured.

Storage later:

```text
Cloudflare R2 / S3-compatible bucket
```

Rule:

Audio Cache is not memory. It can be regenerated or expired.

## 6. Priority order

Do not start with S3 just because it looks clean.

Current priority:

1. Stop writing STT garbage into memory.
2. Keep the conversation thread stable.
3. Keep content packs separate from child memory.
4. Move audio/cache to R2/S3 only after the conversation logic is stable.

## 7. MVP rule

For the next prototype/demo:

- Postgres keeps verified child memory and parent settings.
- RAM keeps current session state.
- JSON keeps content packs.
- Local audio cache is acceptable temporarily.
- MemoryGuard blocks unsafe or unclear memory updates.

This is enough for demo, parent testing, and manufacturer conversations.

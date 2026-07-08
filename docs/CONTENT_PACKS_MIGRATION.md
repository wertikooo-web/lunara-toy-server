# Content Packs Migration

Goal: separate prepared content from child memory.

## What belongs here

Content packs are prepared content:

- riddles
- tongue twisters
- jokes
- facts
- mini games

This is not child memory.

## Current source of truth during migration

For the first migration, the most reliable source is the existing `content_items` table in Postgres, because production already seeded the old content there.

## Export commands

Export only playable content packs:

```bash
npm run export:content-packs
```

Export playable packs plus a full legacy archive grouped by original DB type:

```bash
npm run export:content-packs:all
```

Required environment:

```bash
DATABASE_URL=postgres://...
PGSSL=true
```

## Output

Playable files:

```text
data/content-packs/riddles_ru_v1.json
data/content-packs/tongue_twisters_ru_v1.json
data/content-packs/jokes_ru_v1.json
data/content-packs/facts_ru_v1.json
data/content-packs/games_ru_v1.json
```

Full archive, if `--legacy-all` is used:

```text
data/content-packs/legacy/<original_type>_ru_v1.json
```

## Important rule

Do not blindly convert internal templates into playable child-facing content.

Example: `riddle_template` may be a generation template, not a finished riddle. It should first go to `legacy/` unless a human confirms it is safe and ready to speak aloud.

## Verification

After export, run:

```bash
npm run check:content-packs
```

After Railway deploy, startup logs should include:

```text
[ContentPacksPreload] content packs injected into content.js
[ContentPacks] loaded ... pack source(s), ... item(s)
```

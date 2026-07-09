# HANDOFF.md — Lunara Toy Server

Дата: 2026-07-10  
Рабочий репозиторий: `D:\BIZ\TOYS AI\LUNARA TOY - SERVER\Lunara_TOY_Server_v2 (1)\lunara_server`

## Над чем работали

Последняя задача пользователя: создать короткий `CONTEXT.md` для проекта с ключевыми терминами, ролями, сущностями, правилами, тем, что нельзя путать, и названиями важных процессов.

До этого обсуждался большой блок по Semantic Intent Pipeline, cleanup контента, устойчивости `llm.js`, thinking-фразам и Voice UX. Пользователь сказал, что "все сделано"; текущая задача была уже не про код pipeline, а про документацию контекста.

## Что уже сделано

Создан файл:

- `CONTEXT.md`

В нём описаны:

- что такое Lunara Toy Server;
- сущности `Lumi`, `child`, `toy`, `parentConfig`, `state/sessionRef`, `content item`, `content pack`, `voiceUxPhrases`, `thinking phrase`;
- процессы `STT`, `AudioInputGuard`, `Semantic Intent Pipeline`, `content cache`, `LLM fallback`, `Story Guard`, `Riddle flow`, `TTS`, `commit-push-deploy` / `КПД`;
- что нельзя путать: `topic` vs `intent`, `riddle` vs `activeRiddle`, prepared story vs LLM story, `childGender` vs `toyGender`;
- правило: `toyGender` только `female` или `male`, среднего рода нет;
- ключевые файлы проекта.

Проверки перед коммитом:

- `node -c server.js` — прошёл;
- `node -c modules/content.js` — прошёл;
- `node -c modules/llm.js` — прошёл.

Коммит сделан:

- `5e4a387 Add project context guide`

Push выполнен:

- `main` запушен на GitHub: `31cef2b..5e4a387 main -> main`

## Где сейчас застряли

Deploy через Railway не был завершён.

Причина:

- Railway CLI в этой папке не привязан к проекту: `No linked project found. Run railway link to connect to a project`.
- Команда `railway up` опасна в текущем состоянии, потому что рабочая папка грязная: она может отправить в deploy незакоммиченные изменения, которые не относятся к `CONTEXT.md`.
- Без `projectId` / `serviceId` нельзя безопасно выполнить `railway redeploy --from-source`.

Важно: push на GitHub уже сделан. Если Railway подключён к GitHub source, deploy мог запуститься автоматически на стороне Railway. Локально это не подтверждено.

## Текущее состояние git

После `git pull --rebase --autostash` remote был подтянут, мой коммит переигран поверх свежего `origin/main`, но возврат старого autostash дал конфликты в двух файлах:

- `modules/content.js`
- `modules/contentIntentPatch.js`

Конфликты были вручную разрешены:

- в `modules/content.js` оставлена гендерная логика `russianRiddleReactions(correctAnswer, childGender)`;
- в `modules/contentIntentPatch.js` оставлены живые intro-фразы и гибкий ключ `process.env.AUDIO_CACHE_VERSION || 'v3'`.

После этого файлы синтаксически проверены:

- `node -c modules/content.js` — прошёл;
- `node -c modules/contentIntentPatch.js` — прошёл.

Рабочая папка всё равно остаётся грязной из-за старых изменений, которые существовали до задачи `CONTEXT.md`.

Последний видимый статус был примерно такой:

- `M modules/content.js`
- `M modules/contentIntentPatch.js`
- `M modules/creativeRiddlePatch.js`
- `M modules/serverPipelinePatch.js`
- `M modules/topicRiddlePatch.js`
- `M modules/voiceUxPhrases.js`
- `M server.js`
- untracked: `PROJECT_STATE_2026-06-18.md`
- untracked: `SKILL-lunara-voice-ux.local-backup.md`
- untracked: `cleaner.js`
- untracked: `generate_greeting.js`
- untracked: `graphify/`
- untracked: `modules/stt.backup.js`
- untracked: `tmp_content_test_audio/`

Stash list содержал:

- `stash@{0}: autostash`
- `stash@{1}: On main: pre-github-sync-local-response-debug`
- `stash@{2}: On main: local public index before content cache rebase`

Не удалять stash вслепую.

## План на следующий шаг

1. Выполнить `git status -sb` в `D:\BIZ\TOYS AI\LUNARA TOY - SERVER\Lunara_TOY_Server_v2 (1)\lunara_server`.
2. Убедиться, что `CONTEXT.md` уже в истории: `git log --oneline -5`.
3. Решить, что делать с текущими незакоммиченными изменениями:
   - если это нужные изменения пользователя/Клода/Gemini — проверить, протестировать и коммитить отдельным осознанным коммитом;
   - если это временный мусор — сначала получить явное разрешение пользователя на очистку.
4. Для deploy:
   - не использовать `railway up`, пока рабочее дерево грязное;
   - либо подтвердить auto-deploy через GitHub/Railway dashboard;
   - либо привязать Railway проект (`railway link`) и выполнить `railway redeploy --from-source -p <projectId> -s <service> -e <env> -y`.
5. После deploy проверить `/health`.

## Грабли, на которые нельзя наступать снова

- Не запускать `railway up` из грязного рабочего дерева: он может задеплоить незакоммиченные локальные изменения.
- Не делать `git reset --hard` и не откатывать чужие изменения без прямого разрешения пользователя.
- Не коммитить все `M`/`??` подряд: в дереве есть старые изменения, не относящиеся к текущей задаче.
- Не удалять `stash@{0}` и другие stash без проверки: там может быть работа пользователя или предыдущего агента.
- Не считать папку `D:\BIZ\TOYS AI\LUNARA TOY - SERVER` git-репозиторием. Реальный repo сейчас внутри `Lunara_TOY_Server_v2 (1)\lunara_server`.
- Не путать папку `Дополнительны файлы - загадки-скороговорки-игры-шутки` с боевым серверным кодом. Боевой код находится в `lunara_server`.
- Не возвращать средний род для игрушки: `toyGender` только `female` или `male`.
- Не добавлять технические префиксы в текст контента: `Загадка.`, `Факт.`, `Шутка.`, `Игра.`, `Скороговорка.` должны быть Voice UX/metadata, а не spoken content.
- Не ломать правило пользователя: после завершённого блока работ обычно нужно `commit -> push -> deploy`; отдельная команда `КПД` означает то же самое. В этой сессии commit и push по `CONTEXT.md` сделаны, deploy локально не подтверждён из-за Railway link/dirty tree.


# Lunara TOY Server v2.0

WebSocket сервер для AI-игрушки Lunara. ESP32 (мишка) подключается по WebSocket, сервер обрабатывает голос через Whisper → Claude → Google TTS и возвращает URL на PCM-файл.

## Структура

```
lunara_server/
  server.js           — главный файл, WS + Express
  modules/
    stt.js            — Whisper (OpenAI) Speech-to-Text
    llm.js            — Claude (Anthropic) диалог
    tts.js            — Google Cloud TTS
    cleaner.js        — авто-удаление старых PCM файлов
    logger.js         — логирование
  audio/              — PCM файлы ответов (раздаются как static)
  uploads/            — временные входящие PCM от ESP32
  .env                — переменные окружения (не коммитить!)
```

## Переменные окружения

Создай `.env` файл (или добавь в Railway Variables):

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
PUBLIC_URL=https://your-app.railway.app
PORT=3000
```

> **Google TTS на Railway:** загрузи JSON сервисного аккаунта как файл или вставь содержимое в переменную `GOOGLE_CREDENTIALS_JSON` (см. tts.js комментарий).

## Запуск локально

```bash
npm install
cp .env.example .env
# заполни .env своими ключами
node server.js
```

## Деплой на Railway

1. Создай новый проект на railway.app
2. Подключи этот репозиторий (или загрузи файлы)
3. Добавь переменные окружения в Railway Variables
4. Railway автоматически запустит `npm start`
5. Скопируй публичный URL → вставь в `PUBLIC_URL`

## WebSocket протокол

### ESP32 → Сервер
| Тип | Содержимое |
|-----|-----------|
| text | `{"type":"start"}` — кнопка нажата |
| binary | PCM16 LE, 16kHz, моно, чанки 1280 байт |
| text | `{"type":"end"}` — кнопка отпущена |
| text | `{"type":"ping"}` — keepalive |
| text | `{"type":"reset"}` — сброс диалога |

### Сервер → ESP32
| Тип | Содержимое |
|-----|-----------|
| text | `{"type":"ready","assistant":{...}}` |
| text | `{"type":"status","state":"listening\|processing\|responding"}` |
| text | `{"type":"audio","url":"...","duration_ms":N,"sample_rate":16000,"channels":1,"bits":16}` |
| text | `{"type":"error","message":"..."}` |
| text | `{"type":"pong"}` |

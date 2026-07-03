# Empik API App

Приложение для работы с маркетплейсом **Empik** (платформа Mirakl):

- **Автоприём заказов** — по расписанию проверяет новые заказы (`WAITING_ACCEPTANCE`) и автоматически принимает их, чтобы они попадали в базу Empik. Журнал всех принятых заказов доступен в веб-интерфейсе.
- **Массовое редактирование оферт** — таблица всех оферт с выбором строк и групповым изменением цены (абсолютно или в %), количества и срока отправки.
- **Импорт из Allegro** — загрузка выгрузки оферт Allegro (`.xlsm`, лист «Szablon»), сопоставление с офертами Empik по SKU, предпросмотр и отправка изменений через API либо скачивание готового файла `offers-import.xlsx` для ручной загрузки в панель продавца.

## Требования

- Windows / macOS / Linux, [Node.js](https://nodejs.org) 20+
- Ключ API Empik Marketplace

## Установка и запуск

```bash
npm install
npm run build
npm start
```

Приложение откроется на `http://localhost:3000`.

### Настройка

Скопируйте `.env.example` в `.env` и заполните:

| Переменная | Описание |
|---|---|
| `EMPIK_API_KEY` | Ключ API: Панель продавца → имя пользователя → **Klucz API** → *Wygeneruj nowy klucz* |
| `EMPIK_BASE_URL` | `https://marketplace.empik.com` (боевой) или `https://stg1.marketplace.empik.com` (тестовый) |
| `POLL_MINUTES` | Интервал проверки новых заказов в минутах (по умолчанию 60) |
| `APP_PASSWORD` | Пароль входа в веб-интерфейс — **обязательно смените**, если открываете доступ из интернета |
| `PORT` | Порт сервера (по умолчанию 3000) |

Без `EMPIK_API_KEY` приложение работает в **демо-режиме** с фиктивными данными — удобно для проверки интерфейса.

### Режим разработки

```bash
npm run dev       # сервер с автоперезапуском (tsx watch)
npm run dev:web   # фронтенд Vite с hot-reload на http://localhost:5173
```

## Публичный доступ через Cloudflare Tunnel

Пока ваш ПК включён и туннель запущен, приложение доступно из интернета:

1. Установите [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`winget install Cloudflare.cloudflared`).
2. Быстрый вариант (временный случайный URL):
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Постоянный вариант (свой поддомен, нужен домен в Cloudflare):
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create empik-app
   cloudflared tunnel route dns empik-app empik.ваш-домен.com
   cloudflared tunnel run --url http://localhost:3000 empik-app
   ```

> ⚠️ Интерфейс защищён паролем (`APP_PASSWORD`), но при публичном доступе используйте длинный уникальный пароль. Дополнительно можно закрыть туннель через Cloudflare Access.

## Автозапуск на Windows

Планировщик заданий (Task Scheduler) → «Создать задачу»:

- Триггер: «При входе в систему».
- Действие: программа `cmd`, аргументы `/c cd /d "C:\путь\к\Empik API APP" && npm start`.
- Аналогично можно добавить задачу для `cloudflared tunnel run ...`.

## Как работает автоприём заказов

1. Раз в `POLL_MINUTES` минут запрос **OR11** `GET /api/orders?order_state_codes=WAITING_ACCEPTANCE`.
2. Каждый найденный заказ принимается через **OR21** `PUT /api/orders/{id}/accept` (все позиции).
3. Результат пишется в `data/orders-log.json` и отображается на вкладке «Заказы».
4. Кнопка «Проверить сейчас» запускает проверку немедленно.

## Импорт из Allegro: важно про EAN

В выгрузке Allegro в колонке «ID продукта» — внутренние идентификаторы Allegro, а не EAN. Поэтому:

- оферты, которые **уже есть на Empik** (совпадение по SKU), обновляются без ограничений;
- **новые** оферты создаются только при наличии EAN (8–14 цифр) в выгрузке; строки без EAN помечаются «Нельзя создать» — такие товары нужно завести через панель Empik (мастер сопоставления категорий) один раз, дальше они будут обновляться по SKU.

## Ветки

- `main` — стабильная версия;
- `dev` — разработка.

## Структура проекта

```
server/src/
  index.ts    — Express-сервер, REST API, статика
  config.ts   — конфигурация из .env
  empik.ts    — клиент Mirakl API (OR11, OR21, OF21, OF24, OF02/03)
  orders.ts   — автоприём заказов, журнал
  offers.ts   — оферты: кэш, массовое обновление, сессии импорта
  allegro.ts  — парсер .xlsm Allegro и генератор offers-import.xlsx
  auth.ts     — вход по паролю (cookie-сессия)
web/          — фронтенд (React + Vite), вкладки: Заказы / Оферты / Импорт из Allegro
```

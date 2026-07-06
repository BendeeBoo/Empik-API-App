import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loginHandler, requireAuth } from './auth.js';
import { checkAndAcceptOrders, getPollerState, readOrderLog, startOrderPoller } from './orders.js';
import {
  buildAllegroGroups,
  bulkDeleteOffers,
  bulkUpdateOffers,
  getOffers,
  importResult,
  readEanDictionary,
  rowsToXlsxRows,
  saveEanDictionary,
  sendImportRows,
  type BulkChange,
  type ImportRowInput,
} from './offers.js';
import { buildEmpikImportXlsx } from './allegro.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---------- Аутентификация ----------
app.post('/api/login', loginHandler);
app.use('/api', requireAuth);

// Оборачивает async-обработчики, чтобы ошибки уходили в JSON-ответ
const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[api] ${req.method} ${req.path}: ${msg}`);
      res.status(500).json({ error: msg });
    });
  };

// ---------- Заказы ----------
app.get('/api/orders/status', (_req, res) => {
  res.json(getPollerState());
});

app.get('/api/orders/log', (_req, res) => {
  res.json(readOrderLog());
});

app.post(
  '/api/orders/check-now',
  wrap(async (_req, res) => {
    res.json(await checkAndAcceptOrders());
  }),
);

// ---------- Оферты ----------
app.get(
  '/api/offers',
  wrap(async (req, res) => {
    res.json(await getOffers(req.query.refresh === '1'));
  }),
);

app.post(
  '/api/offers/bulk-update',
  wrap(async (req, res) => {
    const changes = (req.body?.changes ?? []) as BulkChange[];
    if (!Array.isArray(changes) || !changes.length) {
      res.status(400).json({ error: 'Не переданы изменения' });
      return;
    }
    const importId = await bulkUpdateOffers(changes);
    res.json({ importId });
  }),
);

app.post(
  '/api/offers/bulk-delete',
  wrap(async (req, res) => {
    const skus = (req.body?.skus ?? []) as string[];
    if (!Array.isArray(skus) || !skus.length) {
      res.status(400).json({ error: 'Не переданы SKU для удаления' });
      return;
    }
    const importId = await bulkDeleteOffers(skus);
    res.json({ importId });
  }),
);

app.get(
  '/api/imports/:id',
  wrap(async (req, res) => {
    res.json(await importResult(Number(req.params.id)));
  }),
);

// ---------- Справочник EAN ----------
app.get('/api/ean-dictionary', (_req, res) => {
  const { updatedAt, entries } = readEanDictionary();
  res.json({ updatedAt, entries: entries.length });
});

app.post(
  '/api/ean-dictionary',
  express.raw({ type: '*/*', limit: '20mb' }),
  wrap(async (req, res) => {
    const { updatedAt, entries } = saveEanDictionary(req.body as Buffer);
    res.json({ updatedAt, entries: entries.length });
  }),
);

// ---------- Импорт из Allegro ----------
app.post(
  '/api/allegro/upload',
  express.raw({ type: '*/*', limit: '100mb' }),
  wrap(async (req, res) => {
    const fileName = String(req.query.filename ?? 'offers.xlsm');
    const result = await buildAllegroGroups(req.body as Buffer);
    res.json({ fileName, ...result });
  }),
);

app.post(
  '/api/allegro/send',
  wrap(async (req, res) => {
    const rows = (req.body?.rows ?? []) as ImportRowInput[];
    if (!Array.isArray(rows) || !rows.length) {
      res.status(400).json({ error: 'Не выбрано ни одной строки для отправки' });
      return;
    }
    const importId = await sendImportRows(rows);
    res.json({ importId, sent: rows.length });
  }),
);

app.post(
  '/api/allegro/download',
  wrap(async (req, res) => {
    const rows = (req.body?.rows ?? []) as ImportRowInput[];
    if (!Array.isArray(rows) || !rows.length) {
      res.status(400).json({ error: 'Не выбрано ни одной строки для скачивания' });
      return;
    }
    const xlsx = buildEmpikImportXlsx(await rowsToXlsxRows(rows));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="empik-offers-import.xlsx"');
    res.send(xlsx);
  }),
);

// ---------- Статика (собранный фронтенд) ----------
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .send('Фронтенд не собран. Выполните: npm run build -w web (или используйте npm run dev:web для разработки).');
  });
}

app.listen(config.port, () => {
  console.log(`Empik API App: http://localhost:${config.port}${config.mockMode ? ' — ДЕМО-РЕЖИМ (EMPIK_API_KEY не задан)' : ''}`);
  startOrderPoller();
});

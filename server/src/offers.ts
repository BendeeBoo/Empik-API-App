/**
 * Работа с офертами: кэш списка, массовое обновление, сессии импорта из Allegro.
 */
import crypto from 'node:crypto';
import {
  getImportErrorReport,
  getImportStatus,
  importOffers,
  listOffers,
  type EmpikOffer,
  type OfferUpdate,
} from './empik.js';
import { parseAllegroXlsm, type AllegroOffer, type EmpikImportRow } from './allegro.js';

// ---------- Кэш оферт ----------

let cache: { offers: EmpikOffer[]; fetchedAt: string } | null = null;

export async function getOffers(refresh = false): Promise<{ offers: EmpikOffer[]; fetchedAt: string }> {
  if (!cache || refresh) {
    cache = { offers: await listOffers(), fetchedAt: new Date().toISOString() };
  }
  return cache;
}

export function invalidateOffersCache() {
  cache = null;
}

// ---------- Массовое обновление ----------

export interface BulkChange {
  sku: string;
  price?: number;
  quantity?: number;
  leadtime_to_ship?: number;
  state_code?: string;
}

export async function bulkUpdateOffers(changes: BulkChange[]): Promise<number> {
  const updates: OfferUpdate[] = changes.map((c) => ({
    sku: c.sku,
    price: c.price,
    quantity: c.quantity,
    leadtime_to_ship: c.leadtime_to_ship,
    state_code: c.state_code,
    update_delete: 'update',
  }));
  const importId = await importOffers(updates);
  invalidateOffersCache();
  return importId;
}

export async function importResult(importId: number) {
  const status = await getImportStatus(importId);
  const errorReport = status.has_error_report ? await getImportErrorReport(importId) : '';
  return { ...status, errorReport };
}

// ---------- Импорт из Allegro ----------

export interface AllegroPreviewRow extends AllegroOffer {
  action: 'new' | 'update' | 'blocked';
  reason?: string;
  empikPrice?: number;
  empikQuantity?: number;
}

export interface AllegroSession {
  id: string;
  fileName: string;
  createdAt: string;
  rows: AllegroPreviewRow[];
}

const sessions = new Map<string, AllegroSession>();

export async function createAllegroSession(fileName: string, buffer: Buffer): Promise<AllegroSession> {
  const allegroOffers = parseAllegroXlsm(buffer);
  const { offers: empikOffers } = await getOffers();
  const empikBySku = new Map(empikOffers.map((o) => [(o.shop_sku ?? o.sku ?? '').trim(), o]));

  const rows: AllegroPreviewRow[] = allegroOffers.map((a) => {
    const existing = empikBySku.get(a.sku);
    if (existing) {
      return {
        ...a,
        action: 'update',
        empikPrice: existing.price,
        empikQuantity: existing.quantity,
      };
    }
    if (a.ean) {
      return { ...a, action: 'new' };
    }
    return {
      ...a,
      action: 'blocked',
      reason: 'Нет EAN в выгрузке Allegro и нет оферты с таким SKU на Empik — товар нужно завести через панель Empik',
    };
  });

  const session: AllegroSession = {
    id: crypto.randomUUID(),
    fileName,
    createdAt: new Date().toISOString(),
    rows,
  };
  sessions.set(session.id, session);
  // держим не больше 10 сессий в памяти
  if (sessions.size > 10) {
    const oldest = [...sessions.keys()][0];
    sessions.delete(oldest);
  }
  return session;
}

export function getAllegroSession(id: string): AllegroSession | undefined {
  return sessions.get(id);
}

/** Применить корректировку цены и собрать строки для отправки/скачивания. */
export function buildImportRows(
  session: AllegroSession,
  opts: { includeNew: boolean; includeUpdates: boolean; priceAdjustPercent: number; skus?: string[] },
): EmpikImportRow[] {
  const skuFilter = opts.skus?.length ? new Set(opts.skus) : null;
  const factor = 1 + (opts.priceAdjustPercent || 0) / 100;
  return session.rows
    .filter((r) => r.action !== 'blocked')
    .filter((r) => (r.action === 'new' ? opts.includeNew : opts.includeUpdates))
    .filter((r) => !skuFilter || skuFilter.has(r.sku))
    .map((r) => ({
      sku: r.sku,
      productId: r.action === 'new' ? r.ean! : r.sku,
      productIdType: r.action === 'new' ? 'EAN' : 'SKU',
      description: r.title,
      price: r.pricePln !== undefined ? Math.round(r.pricePln * factor * 100) / 100 : undefined,
      quantity: r.quantity,
      leadtimeDays: r.leadtimeDays,
      updateDelete: r.action === 'update' ? 'update' : '',
    }));
}

export async function sendImportRows(rows: EmpikImportRow[]): Promise<number> {
  const updates: OfferUpdate[] = rows.map((r) => ({
    sku: r.sku,
    product_id: r.productId,
    product_id_type: r.productIdType,
    description: r.description,
    price: r.price,
    quantity: r.quantity,
    state_code: '11',
    leadtime_to_ship: r.leadtimeDays,
    update_delete: r.updateDelete,
  }));
  const importId = await importOffers(updates);
  invalidateOffersCache();
  return importId;
}

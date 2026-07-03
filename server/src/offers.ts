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

/**
 * Mirakl при JSON-обновлении СБРАСЫВАЕТ все поля, не переданные в запросе
 * (описание, срок отправки, логистический класс и т.д.). Поэтому каждое
 * обновление дополняется текущими значениями оферты из кэша.
 */
function fillFromOffer(update: OfferUpdate, offer: EmpikOffer | undefined): OfferUpdate {
  if (!offer) return { ...update, state_code: update.state_code ?? '11' };
  const logisticClass =
    typeof offer.logistic_class === 'object' ? offer.logistic_class?.code : offer.logistic_class;
  return {
    ...update,
    price: update.price ?? offer.price,
    quantity: update.quantity ?? offer.quantity,
    leadtime_to_ship: update.leadtime_to_ship ?? offer.leadtime_to_ship,
    state_code: update.state_code ?? offer.state_code ?? '11',
    description: update.description ?? offer.description ?? undefined,
    internal_description: update.internal_description ?? offer.internal_description ?? undefined,
    logistic_class: update.logistic_class ?? logisticClass ?? undefined,
    price_additional_info: update.price_additional_info ?? offer.price_additional_info ?? undefined,
    min_quantity_alert: update.min_quantity_alert ?? offer.min_quantity_alert ?? undefined,
    available_start_date: update.available_start_date ?? offer.available_start_date ?? undefined,
    available_end_date: update.available_end_date ?? offer.available_end_date ?? undefined,
    discount:
      update.discount ??
      (offer.discount?.price != null
        ? {
            price: offer.discount.price,
            start_date: offer.discount.start_date,
            end_date: offer.discount.end_date,
          }
        : undefined),
  };
}

async function offersBySku(): Promise<Map<string, EmpikOffer>> {
  const { offers } = await getOffers();
  return new Map(offers.map((o) => [(o.shop_sku ?? o.sku ?? '').trim(), o]));
}

export async function bulkUpdateOffers(changes: BulkChange[]): Promise<number> {
  const bySku = await offersBySku();
  const updates: OfferUpdate[] = changes.map((c) =>
    fillFromOffer(
      {
        shop_sku: c.sku,
        price: c.price,
        quantity: c.quantity,
        leadtime_to_ship: c.leadtime_to_ship,
        state_code: c.state_code,
        update_delete: 'update',
      },
      bySku.get(c.sku),
    ),
  );
  const importId = await importOffers(updates);
  invalidateOffersCache();
  return importId;
}

/** Удаление оферт по SKU (update-delete = delete). */
export async function bulkDeleteOffers(skus: string[]): Promise<number> {
  const updates: OfferUpdate[] = skus.map((sku) => ({
    shop_sku: sku,
    update_delete: 'delete',
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
  const bySku = await offersBySku();
  const updates: OfferUpdate[] = rows.map((r) =>
    fillFromOffer(
      {
        shop_sku: r.sku,
        product_id: r.productId,
        product_id_type: r.productIdType,
        // при обновлении описание Empik сохраняется (fillFromOffer), задаётся только для новых
        description: r.updateDelete === 'update' ? undefined : r.description,
        price: r.price,
        quantity: r.quantity,
        state_code: '11',
        leadtime_to_ship: r.leadtimeDays,
        update_delete: r.updateDelete,
      },
      bySku.get(r.sku),
    ),
  );
  const importId = await importOffers(updates);
  invalidateOffersCache();
  return importId;
}

/**
 * Работа с офертами: кэш списка, массовое обновление/удаление,
 * импорт из Allegro со справочником EAN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  getImportErrorReport,
  getImportStatus,
  importOffers,
  listOffers,
  type EmpikOffer,
  type OfferUpdate,
} from './empik.js';
import {
  findEanByName,
  parseAllegroXlsm,
  parseEanDictionary,
  type AllegroOffer,
  type EanEntry,
  type EmpikImportRow,
} from './allegro.js';

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

async function offersBySku(): Promise<Map<string, EmpikOffer>> {
  const { offers } = await getOffers();
  return new Map(offers.map((o) => [(o.shop_sku ?? o.sku ?? '').trim(), o]));
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

// ---------- Справочник EAN ----------

const EAN_DICT_FILE = () => path.join(config.dataDir, 'ean-dictionary.json');

export function readEanDictionary(): { updatedAt: string | null; entries: EanEntry[] } {
  try {
    return JSON.parse(fs.readFileSync(EAN_DICT_FILE(), 'utf8'));
  } catch {
    return { updatedAt: null, entries: [] };
  }
}

/** Сохранение загруженного справочника EAN (перезаписывает предыдущий). */
export function saveEanDictionary(buffer: Buffer): { updatedAt: string; entries: EanEntry[] } {
  const entries = parseEanDictionary(buffer);
  const data = { updatedAt: new Date().toISOString(), entries };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(EAN_DICT_FILE(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// ---------- Импорт из Allegro ----------

export interface AllegroVariant {
  offerId: string;
  title: string;
  pricePln?: number;
  quantity?: number;
  leadtimeDays?: number;
}

/** Группа активных оферт Allegro с одним SKU. */
export interface AllegroGroup {
  sku: string;
  action: 'new' | 'update' | 'blocked';
  ean?: string;
  eanSource?: 'allegro' | 'dictionary';
  reason?: string;
  variants: AllegroVariant[];
  empikPrice?: number;
  empikQuantity?: number;
  empikLeadtime?: number;
}

export async function buildAllegroGroups(buffer: Buffer): Promise<{
  groups: AllegroGroup[];
  totalRows: number;
  activeRows: number;
  dictionaryEntries: number;
}> {
  const all = parseAllegroXlsm(buffer);
  const active = all.filter((o) => o.status === 'Aktywna' && o.sku);
  const { entries } = readEanDictionary();
  const empikBySku = await offersBySku();

  const bySku = new Map<string, AllegroOffer[]>();
  for (const o of active) {
    const list = bySku.get(o.sku) ?? [];
    list.push(o);
    bySku.set(o.sku, list);
  }

  const groups: AllegroGroup[] = [];
  for (const [sku, list] of bySku) {
    const existing = empikBySku.get(sku);
    let ean = list.find((o) => o.ean)?.ean;
    let eanSource: 'allegro' | 'dictionary' | undefined = ean ? 'allegro' : undefined;
    if (!ean) {
      ean = findEanByName(sku, entries);
      if (ean) eanSource = 'dictionary';
    }
    groups.push({
      sku,
      action: existing ? 'update' : ean ? 'new' : 'blocked',
      ean,
      eanSource,
      reason:
        existing || ean
          ? undefined
          : 'Нет EAN (ни в выгрузке, ни в справочнике) — впишите EAN вручную в таблице или пополните справочник',
      variants: list.map((o) => ({
        offerId: o.offerId,
        title: o.title,
        pricePln: o.pricePln,
        quantity: o.quantity,
        leadtimeDays: o.leadtimeDays,
      })),
      empikPrice: existing?.price,
      empikQuantity: existing?.quantity,
      empikLeadtime: existing?.leadtime_to_ship,
    });
  }
  return {
    groups,
    totalRows: all.length,
    activeRows: active.length,
    dictionaryEntries: entries.length,
  };
}

// ---------- Отправка выбранных строк ----------

/** Строка, отредактированная пользователем в предпросмотре импорта. */
export interface ImportRowInput {
  sku: string;
  ean?: string;
  description?: string;
  price?: number;
  quantity?: number;
  leadtimeDays?: number;
}

function validateRows(rows: ImportRowInput[], bySku: Map<string, EmpikOffer>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.sku?.trim()) {
      errors.push('Строка без SKU');
      continue;
    }
    if (seen.has(r.sku)) errors.push(`${r.sku}: SKU повторяется в отправляемых строках`);
    seen.add(r.sku);
    if (r.price !== undefined && !(r.price > 0)) errors.push(`${r.sku}: цена должна быть больше нуля`);
    if (r.quantity !== undefined && r.quantity < 0) errors.push(`${r.sku}: количество не может быть отрицательным`);
    const isNew = !bySku.has(r.sku);
    if (isNew) {
      if (!r.ean || !/^\d{8,14}$/.test(r.ean)) errors.push(`${r.sku}: для создания новой оферты нужен EAN (8–14 цифр)`);
      if (!r.description?.trim()) errors.push(`${r.sku}: для новой оферты нужно описание`);
      if (r.price === undefined) errors.push(`${r.sku}: для новой оферты нужна цена`);
      if (r.quantity === undefined) errors.push(`${r.sku}: для новой оферты нужно количество`);
    }
  }
  return errors;
}

export async function sendImportRows(rows: ImportRowInput[]): Promise<number> {
  const bySku = await offersBySku();
  const errors = validateRows(rows, bySku);
  if (errors.length) throw new Error(`Проверьте строки: ${errors.join('; ')}`);
  const updates: OfferUpdate[] = rows.map((r) => {
    const existing = bySku.get(r.sku);
    return fillFromOffer(
      {
        shop_sku: r.sku,
        product_id: existing ? undefined : r.ean,
        product_id_type: existing ? undefined : 'EAN',
        description: existing ? undefined : r.description, // описание Empik при обновлении сохраняется
        price: r.price,
        quantity: r.quantity,
        state_code: '11',
        leadtime_to_ship: r.leadtimeDays,
        update_delete: existing ? 'update' : '',
      },
      existing,
    );
  });
  const importId = await importOffers(updates);
  invalidateOffersCache();
  return importId;
}

/** Строки для скачивания xlsx в формате импорта Empik. */
export async function rowsToXlsxRows(rows: ImportRowInput[]): Promise<EmpikImportRow[]> {
  const bySku = await offersBySku();
  return rows.map((r) => {
    const existing = bySku.get(r.sku);
    return {
      sku: r.sku,
      productId: existing ? r.sku : (r.ean ?? ''),
      productIdType: existing ? 'SKU' : 'EAN',
      description: r.description ?? existing?.description ?? '',
      price: r.price,
      quantity: r.quantity,
      leadtimeDays: r.leadtimeDays,
      updateDelete: existing ? 'update' : '',
    };
  });
}

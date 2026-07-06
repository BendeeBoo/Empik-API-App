/**
 * Парсер выгрузки оферт Allegro (.xlsm, лист "Szablon").
 * Структура листа: строка 3 — технические заголовки, строка 4 — человекочитаемые,
 * данные начинаются со строки 5.
 */
import * as XLSX from 'xlsx';

export interface AllegroOffer {
  offerId: string;
  status: string;
  sku: string;
  ean?: string;
  title: string;
  pricePln?: number;
  quantity?: number;
  leadtimeDays?: number;
  category: string;
}

function findColumn(headers: string[], prefix: string): number {
  return headers.findIndex((h) => h?.toString().trim().toLowerCase().startsWith(prefix));
}

/** «96h (4 dni)» → 4; «24h» → 1 */
function parseLeadtime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const days = /(\d+)\s*dni/i.exec(value);
  if (days) return Number(days[1]);
  const hours = /(\d+)\s*h/i.exec(value);
  if (hours) return Math.max(1, Math.ceil(Number(hours[1]) / 24));
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(String(value).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function parseAllegroXlsm(buffer: Buffer): AllegroOffer[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => n.trim() === 'Szablon');
  if (!sheetName) {
    throw new Error(`Лист "Szablon" не найден. Доступные листы: ${wb.SheetNames.join(', ')}`);
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    defval: '',
    raw: true,
  });
  if (rows.length < 5) throw new Error('Файл не содержит данных (ожидались данные со строки 5)');

  const headers = (rows[2] ?? []).map((h) => String(h ?? ''));
  const col = {
    offerId: 2, // колонка C — «ID oferty» (в строке 3 у служебных колонок нет тех. имён)
    status: findColumn(headers, 'status_oferty'),
    productId: findColumn(headers, 'id_produktu'),
    sku: findColumn(headers, 'sygnatura'),
    quantity: findColumn(headers, 'liczba_sztuk'),
    pricePln: findColumn(headers, 'cena_pl'),
    title: findColumn(headers, 'tytuł_oferty'),
    leadtime: findColumn(headers, 'czas_wysyłki'),
    category: findColumn(headers, 'podkategoria'),
  };
  for (const [name, idx] of Object.entries(col)) {
    if (idx < 0) throw new Error(`Не найдена колонка "${name}" в строке заголовков листа Szablon`);
  }

  const offers: AllegroOffer[] = [];
  for (const row of rows.slice(4)) {
    const sku = String(row[col.sku] ?? '').trim();
    const title = String(row[col.title] ?? '').trim();
    if (!sku && !title) continue; // пустая строка
    const productId = String(row[col.productId] ?? '').trim();
    offers.push({
      offerId: String(row[col.offerId] ?? '').trim(),
      status: String(row[col.status] ?? '').trim(),
      sku,
      // EAN — только если id_produktu состоит из 8–14 цифр (иначе это внутренний UUID Allegro)
      ean: /^\d{8,14}$/.test(productId) ? productId : undefined,
      title,
      pricePln: parseNumber(row[col.pricePln]),
      quantity: parseNumber(row[col.quantity]),
      leadtimeDays: parseLeadtime(String(row[col.leadtime] ?? '')),
      category: String(row[col.category] ?? '').trim(),
    });
  }
  return offers;
}

// ---------- Справочник EAN ----------

export interface EanEntry {
  name: string;
  ean: string;
}

/**
 * Парсер справочника EAN: xlsx, первая колонка — название товара,
 * вторая — EAN (числа вида «5907184952512.0» нормализуются).
 */
export function parseEanDictionary(buffer: Buffer): EanEntry[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: true,
  });
  const entries: EanEntry[] = [];
  for (const row of rows) {
    const name = String(row[0] ?? '').trim();
    const ean = String(row[1] ?? '').replace(/\.0+$/, '').replace(/\D/g, '');
    if (!name || !/^\d{8,14}$/.test(ean)) continue; // заголовок и мусор пропускаются
    entries.push({ name, ean });
  }
  if (!entries.length) {
    throw new Error('В файле не найдено ни одной строки вида «Название | EAN (8–14 цифр)»');
  }
  return entries;
}

/** Нормализация для сопоставления: регистр, знак ×, лишние пробелы. */
function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/×/g, 'x')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Поиск EAN по названию: все слова SKU должны входить в название из справочника
 * (или наоборот). При нескольких кандидатах — совпадение считается неоднозначным.
 */
export function findEanByName(sku: string, entries: EanEntry[]): string | undefined {
  const skuTokens = normalizeTokens(sku);
  if (!skuTokens.length) return undefined;
  const matches = entries.filter((e) => {
    const nameTokens = normalizeTokens(e.name);
    const nameSet = new Set(nameTokens);
    const skuSet = new Set(skuTokens);
    return skuTokens.every((t) => nameSet.has(t)) || nameTokens.every((t) => skuSet.has(t));
  });
  return matches.length === 1 ? matches[0].ean : undefined;
}

/** Колонки шаблона импорта оферт Empik (формат Mirakl OF01). */
export const EMPIK_IMPORT_HEADERS = [
  'sku', 'product-id', 'product-id-type', 'description', 'internal-description',
  'price', 'price-additional-info', 'quantity', 'min-quantity-alert', 'state',
  'available-start-date', 'available-end-date', 'logistic-class', 'favorite-rank',
  'discount-start-date', 'discount-end-date', 'discount-price', 'update-delete',
  'leadtime-to-ship', 'vatmargin', 'price-calibration-enabled',
  'gpsr-entity-name', 'gpsr-address', 'gpsr-country', 'gpsr-city', 'gpsr-zip-code',
  'gpsr-email', 'gpsr-phone',
] as const;

export interface EmpikImportRow {
  sku: string;
  productId: string;
  productIdType: string; // 'EAN' | 'SKU'
  description: string;
  price?: number;
  quantity?: number;
  leadtimeDays?: number;
  updateDelete: 'update' | '';
}

/** Генерация xlsx в формате импорта Empik (для ручной загрузки в панель продавца). */
export function buildEmpikImportXlsx(rows: EmpikImportRow[]): Buffer {
  const data: (string | number)[][] = [Array.from(EMPIK_IMPORT_HEADERS)];
  for (const r of rows) {
    const row: (string | number)[] = new Array(EMPIK_IMPORT_HEADERS.length).fill('');
    row[0] = r.sku;
    row[1] = r.productId;
    row[2] = r.productIdType;
    row[3] = r.description;
    row[4] = r.description;
    row[5] = r.price ?? '';
    row[7] = r.quantity ?? '';
    row[9] = '11'; // state: 11 = новый товар
    row[17] = r.updateDelete;
    row[18] = r.leadtimeDays ?? '';
    data.push(row);
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'offers-import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

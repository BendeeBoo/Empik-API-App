/**
 * Клиент Mirakl Seller API (Empik Marketplace).
 * Документация: https://developer.mirakl.com/content/product/mmp/rest/seller
 * Аутентификация: заголовок Authorization с API-ключом продавца.
 */
import { config } from './config.js';

export interface EmpikOrderLine {
  order_line_id?: string;
  id?: string;
  offer_sku?: string;
  product_title?: string;
  quantity?: number;
  total_price?: number;
  order_line_state?: string;
}

export interface EmpikOrder {
  order_id: string;
  commercial_id?: string;
  created_date?: string;
  order_state?: string;
  total_price?: number;
  currency_iso_code?: string;
  customer?: { firstname?: string; lastname?: string };
  order_lines?: EmpikOrderLine[];
}

export interface EmpikOffer {
  offer_id?: number | string;
  shop_sku?: string;
  sku?: string;
  product_title?: string;
  product_references?: { reference?: string; reference_type?: string }[];
  price?: number;
  quantity?: number;
  state_code?: string;
  active?: boolean;
  leadtime_to_ship?: number;
}

export interface OfferUpdate {
  sku: string;
  product_id?: string;
  product_id_type?: string;
  description?: string;
  price?: number;
  quantity?: number;
  state_code?: string;
  leadtime_to_ship?: number;
  update_delete?: 'update' | 'delete' | '';
}

class EmpikApiError extends Error {
  constructor(public status: number, message: string) {
    super(`Empik API ${status}: ${message}`);
  }
}

async function request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const url = `${config.empikBaseUrl}/api${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: config.empikApiKey,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new EmpikApiError(res.status, text.slice(0, 500));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** OR11 — список заказов. По умолчанию только ожидающие принятия. */
export async function listOrders(states: string[] = ['WAITING_ACCEPTANCE']): Promise<EmpikOrder[]> {
  if (config.mockMode) return mockOrders();
  const orders: EmpikOrder[] = [];
  const max = 50;
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({ max: String(max), offset: String(offset) });
    if (states.length) params.set('order_state_codes', states.join(','));
    const page = await request<{ orders?: EmpikOrder[]; total_count?: number }>(
      'GET',
      `/orders?${params}`,
    );
    orders.push(...(page.orders ?? []));
    offset += max;
    if (!page.orders?.length || orders.length >= (page.total_count ?? 0)) break;
  }
  return orders;
}

/** OR21 — принять заказ (все строки). */
export async function acceptOrder(order: EmpikOrder): Promise<void> {
  if (config.mockMode) return;
  const lines = (order.order_lines ?? [])
    .map((l) => l.order_line_id ?? l.id)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ accepted: true, id }));
  if (!lines.length) throw new Error(`Заказ ${order.order_id}: не найдены строки заказа`);
  await request('PUT', `/orders/${encodeURIComponent(order.order_id)}/accept`, {
    order_lines: lines,
  });
}

/** OF21 — все оферты магазина (с пагинацией). */
export async function listOffers(): Promise<EmpikOffer[]> {
  if (config.mockMode) return mockOffers();
  const offers: EmpikOffer[] = [];
  const max = 100;
  let offset = 0;
  for (;;) {
    const page = await request<{ offers?: EmpikOffer[]; total_count?: number }>(
      'GET',
      `/offers?max=${max}&offset=${offset}`,
    );
    offers.push(...(page.offers ?? []));
    offset += max;
    if (!page.offers?.length || offers.length >= (page.total_count ?? 0)) break;
  }
  return offers;
}

/** OF24 — массовое создание/обновление оферт (асинхронный импорт). Возвращает import_id. */
export async function importOffers(updates: OfferUpdate[]): Promise<number> {
  if (config.mockMode) return Math.floor(Math.random() * 100000);
  const res = await request<{ import_id: number }>('POST', '/offers', { offers: updates });
  return res.import_id;
}

/** OF02 — статус импорта оферт. */
export async function getImportStatus(importId: number): Promise<{ status?: string; has_error_report?: boolean; lines_in_error?: number; lines_read?: number }> {
  if (config.mockMode) return { status: 'COMPLETE', has_error_report: false, lines_in_error: 0 };
  return request('GET', `/offers/imports/${importId}`);
}

/** OF03 — отчёт об ошибках импорта (CSV-текст). */
export async function getImportErrorReport(importId: number): Promise<string> {
  if (config.mockMode) return '';
  const url = `${config.empikBaseUrl}/api/offers/imports/${importId}/error_report`;
  const res = await fetch(url, { headers: { Authorization: config.empikApiKey } });
  if (!res.ok) return '';
  return res.text();
}

// ---------- Демо-данные (работают без ключа API) ----------

function mockOrders(): EmpikOrder[] {
  return [
    {
      order_id: 'DEMO-ORDER-001-A',
      created_date: new Date().toISOString(),
      order_state: 'WAITING_ACCEPTANCE',
      total_price: 1849,
      currency_iso_code: 'PLN',
      customer: { firstname: 'Jan', lastname: 'Kowalski' },
      order_lines: [
        {
          order_line_id: 'DEMO-ORDER-001-A-1',
          offer_sku: 'Tunel 2x6m / 20x20mm',
          product_title: 'SZKLARNIA z POLIWĘGLANU 2x6m z OCYNK TUNEL',
          quantity: 1,
          total_price: 1849,
        },
      ],
    },
  ];
}

function mockOffers(): EmpikOffer[] {
  return [
    {
      offer_id: 1,
      shop_sku: 'Tunel 2x6m / 20x20mm',
      product_title: 'SZKLARNIA z POLIWĘGLANU 2x6m z OCYNK TUNEL (демо)',
      price: 1849,
      quantity: 622,
      state_code: '11',
      active: true,
      leadtime_to_ship: 7,
    },
    {
      offer_id: 2,
      shop_sku: 'Taśma naprawcza 50mmx25m',
      product_title: 'Taśma naprawcza do folii i poliwęglanu (демо)',
      price: 23,
      quantity: 153,
      state_code: '11',
      active: true,
      leadtime_to_ship: 2,
    },
  ];
}

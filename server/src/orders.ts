/**
 * Автоприём заказов: периодический опрос OR11 и принятие через OR21.
 * Журнал принятых заказов хранится в data/orders-log.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { acceptOrder, listOrders, type EmpikOrder } from './empik.js';

export interface OrderLogEntry {
  orderId: string;
  commercialId?: string;
  checkedAt: string;
  createdDate?: string;
  customer: string;
  items: { sku: string; title: string; quantity: number }[];
  totalPrice?: number;
  currency?: string;
  accepted: boolean;
  error?: string;
}

interface PollerState {
  lastCheckAt: string | null;
  lastCheckError: string | null;
  nextCheckAt: string | null;
  running: boolean;
}

const LOG_FILE = () => path.join(config.dataDir, 'orders-log.json');

const state: PollerState = {
  lastCheckAt: null,
  lastCheckError: null,
  nextCheckAt: null,
  running: false,
};

export function getPollerState(): PollerState & { pollMinutes: number; mockMode: boolean } {
  return { ...state, pollMinutes: config.pollMinutes, mockMode: config.mockMode };
}

export function readOrderLog(): OrderLogEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE(), 'utf8')) as OrderLogEntry[];
  } catch {
    return [];
  }
}

function appendToLog(entries: OrderLogEntry[]) {
  if (!entries.length) return;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const log = [...entries, ...readOrderLog()].slice(0, 2000);
  fs.writeFileSync(LOG_FILE(), JSON.stringify(log, null, 2), 'utf8');
}

function toLogEntry(order: EmpikOrder, accepted: boolean, error?: string): OrderLogEntry {
  return {
    orderId: order.order_id,
    commercialId: order.commercial_id,
    checkedAt: new Date().toISOString(),
    createdDate: order.created_date,
    customer: [order.customer?.firstname, order.customer?.lastname].filter(Boolean).join(' ') || '—',
    items: (order.order_lines ?? []).map((l) => ({
      sku: l.offer_sku ?? '',
      title: l.product_title ?? '',
      quantity: l.quantity ?? 1,
    })),
    totalPrice: order.total_price,
    currency: order.currency_iso_code,
    accepted,
    error,
  };
}

/** Одна итерация: найти заказы WAITING_ACCEPTANCE и принять каждый. */
export async function checkAndAcceptOrders(): Promise<{ found: number; accepted: number; errors: string[] }> {
  if (state.running) return { found: 0, accepted: 0, errors: ['Проверка уже выполняется'] };
  state.running = true;
  const result = { found: 0, accepted: 0, errors: [] as string[] };
  try {
    const orders = await listOrders(['WAITING_ACCEPTANCE']);
    result.found = orders.length;
    const entries: OrderLogEntry[] = [];
    for (const order of orders) {
      try {
        await acceptOrder(order);
        entries.push(toLogEntry(order, true));
        result.accepted++;
        console.log(`[orders] Принят заказ ${order.order_id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        entries.push(toLogEntry(order, false, msg));
        result.errors.push(`${order.order_id}: ${msg}`);
        console.error(`[orders] Ошибка принятия ${order.order_id}: ${msg}`);
      }
    }
    appendToLog(entries);
    state.lastCheckError = null;
  } catch (e) {
    state.lastCheckError = e instanceof Error ? e.message : String(e);
    result.errors.push(state.lastCheckError);
    console.error(`[orders] Ошибка проверки заказов: ${state.lastCheckError}`);
  } finally {
    state.lastCheckAt = new Date().toISOString();
    state.running = false;
  }
  return result;
}

/** Запуск планировщика: первая проверка сразу, далее раз в POLL_MINUTES. */
export function startOrderPoller() {
  const intervalMs = config.pollMinutes * 60_000;
  const tick = async () => {
    await checkAndAcceptOrders();
    state.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  };
  void tick();
  setInterval(() => void tick(), intervalMs);
  console.log(`[orders] Автоприём заказов запущен, интервал ${config.pollMinutes} мин${config.mockMode ? ' (демо-режим, ключ API не задан)' : ''}`);
}

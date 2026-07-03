import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, postJson } from '../api';

interface PollerStatus {
  lastCheckAt: string | null;
  lastCheckError: string | null;
  nextCheckAt: string | null;
  running: boolean;
  pollMinutes: number;
  mockMode: boolean;
}

interface OrderLogEntry {
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

export default function Orders() {
  const [status, setStatus] = useState<PollerStatus | null>(null);
  const [log, setLog] = useState<OrderLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([
      api<PollerStatus>('/api/orders/status'),
      api<OrderLogEntry[]>('/api/orders/log'),
    ]);
    setStatus(s);
    setLog(l);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
    const t = setInterval(() => load().catch(() => undefined), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const checkNow = async () => {
    setBusy(true);
    setMessage('');
    try {
      const r = await postJson<{ found: number; accepted: number; errors: string[] }>(
        '/api/orders/check-now',
        {},
      );
      setMessage(
        `Найдено заказов, ожидающих принятия: ${r.found}, принято: ${r.accepted}` +
          (r.errors.length ? `, ошибки: ${r.errors.join('; ')}` : ''),
      );
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card row">
        <div>
          <div className="stat-label">Последняя проверка</div>
          <div className="stat-value">{fmtDate(status?.lastCheckAt)}</div>
          {status?.lastCheckError && <div className="error">Ошибка: {status.lastCheckError}</div>}
        </div>
        <div>
          <div className="stat-label">Следующая проверка</div>
          <div className="stat-value">{fmtDate(status?.nextCheckAt)}</div>
        </div>
        <div>
          <div className="stat-label">Интервал</div>
          <div className="stat-value">{status ? `${status.pollMinutes} мин` : '—'}</div>
        </div>
        <div className="grow" />
        <button onClick={checkNow} disabled={busy || status?.running}>
          {busy || status?.running ? 'Проверяю…' : 'Проверить сейчас'}
        </button>
      </div>
      {message && <div className="card info">{message}</div>}

      <h2>Журнал заказов</h2>
      {log.length === 0 ? (
        <p className="muted">Пока нет обработанных заказов. Новые заказы будут приниматься автоматически и появляться здесь.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Заказ</th>
              <th>Дата заказа</th>
              <th>Покупатель</th>
              <th>Товары</th>
              <th>Сумма</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e, i) => (
              <tr key={`${e.orderId}-${i}`}>
                <td>{e.commercialId ?? e.orderId}</td>
                <td>{fmtDate(e.createdDate)}</td>
                <td>{e.customer}</td>
                <td>
                  {e.items.map((it, j) => (
                    <div key={j}>
                      {it.quantity} × {it.title || it.sku}
                    </div>
                  ))}
                </td>
                <td>
                  {e.totalPrice ?? '—'} {e.currency ?? ''}
                </td>
                <td>
                  {e.accepted ? (
                    <span className="badge ok">Принят</span>
                  ) : (
                    <span className="badge err" title={e.error}>
                      Ошибка
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

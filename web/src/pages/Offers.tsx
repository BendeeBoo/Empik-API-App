import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDate, postJson } from '../api';

interface Offer {
  offer_id?: number | string;
  shop_sku?: string;
  sku?: string;
  product_title?: string;
  price?: number;
  quantity?: number;
  state_code?: string;
  active?: boolean;
  leadtime_to_ship?: number;
}

interface ImportStatus {
  status?: string;
  lines_in_error?: number;
  errorReport?: string;
}

type PriceMode = 'none' | 'set' | 'percent';

export default function Offers() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [fetchedAt, setFetchedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);

  // Панель массового редактирования
  const [priceMode, setPriceMode] = useState<PriceMode>('none');
  const [priceValue, setPriceValue] = useState('');
  const [quantityValue, setQuantityValue] = useState('');
  const [leadtimeValue, setLeadtimeValue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const r = await api<{ offers: Offer[]; fetchedAt: string }>(
        `/api/offers${refresh ? '?refresh=1' : ''}`,
      );
      setOffers(r.offers);
      setFetchedAt(r.fetchedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки оферт');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const skuOf = (o: Offer) => o.shop_sku ?? o.sku ?? '';

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return offers;
    return offers.filter(
      (o) => skuOf(o).toLowerCase().includes(q) || (o.product_title ?? '').toLowerCase().includes(q),
    );
  }, [offers, filter]);

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(visible.map(skuOf)) : new Set());
  };

  const toggle = (sku: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(sku) ? next.delete(sku) : next.add(sku);
      return next;
    });
  };

  const pollImport = async (importId: number) => {
    for (let i = 0; i < 30; i++) {
      const st = await api<ImportStatus>(`/api/imports/${importId}`);
      setImportStatus(st);
      if (st.status === 'COMPLETE' || st.status === 'FAILED') return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  const applyBulk = async () => {
    const changes = offers
      .filter((o) => selected.has(skuOf(o)))
      .map((o) => {
        const change: Record<string, unknown> = { sku: skuOf(o) };
        if (priceMode === 'set' && priceValue) change.price = Number(priceValue.replace(',', '.'));
        if (priceMode === 'percent' && priceValue && o.price !== undefined) {
          change.price = Math.round(o.price * (1 + Number(priceValue.replace(',', '.')) / 100) * 100) / 100;
        }
        if (quantityValue !== '') change.quantity = Number(quantityValue);
        if (leadtimeValue !== '') change.leadtime_to_ship = Number(leadtimeValue);
        return change;
      })
      .filter((c) => Object.keys(c).length > 1);
    if (!changes.length) {
      setError('Выберите оферты и укажите хотя бы одно изменение (цена / количество / срок отправки)');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    setImportStatus(null);
    try {
      const r = await postJson<{ importId: number }>('/api/offers/bulk-update', { changes });
      setMessage(`Отправлено изменений: ${changes.length}. Импорт №${r.importId}, ожидаю результат…`);
      await pollImport(r.importId);
      setMessage(`Импорт №${r.importId} завершён. Обновляю список оферт…`);
      await load(true);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка обновления');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card row">
        <input
          className="grow"
          placeholder="Поиск по SKU или названию…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted">
          Всего: {offers.length}, выбрано: {selected.size}
          {fetchedAt && ` · обновлено ${fmtDate(fetchedAt)}`}
        </span>
        <button onClick={() => load(true)} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить из Empik'}
        </button>
      </div>

      <div className="card">
        <h3>Массовое редактирование выбранных ({selected.size})</h3>
        <div className="row wrap">
          <label>
            Цена:
            <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)}>
              <option value="none">не менять</option>
              <option value="set">установить (PLN)</option>
              <option value="percent">изменить на %</option>
            </select>
          </label>
          {priceMode !== 'none' && (
            <input
              type="text"
              placeholder={priceMode === 'set' ? 'напр. 1849.00' : 'напр. -5 или 10'}
              value={priceValue}
              onChange={(e) => setPriceValue(e.target.value)}
            />
          )}
          <label>
            Количество:
            <input
              type="number"
              min="0"
              placeholder="не менять"
              value={quantityValue}
              onChange={(e) => setQuantityValue(e.target.value)}
            />
          </label>
          <label>
            Срок отправки (дней):
            <input
              type="number"
              min="0"
              placeholder="не менять"
              value={leadtimeValue}
              onChange={(e) => setLeadtimeValue(e.target.value)}
            />
          </label>
          <button onClick={applyBulk} disabled={busy || selected.size === 0}>
            {busy ? 'Применяю…' : 'Применить к выбранным'}
          </button>
        </div>
      </div>

      {message && <div className="card info">{message}</div>}
      {error && <div className="card error">{error}</div>}
      {importStatus && (
        <div className="card">
          Статус импорта: <b>{importStatus.status ?? '—'}</b>
          {importStatus.lines_in_error ? `, строк с ошибками: ${importStatus.lines_in_error}` : ''}
          {importStatus.errorReport && (
            <pre className="report">{importStatus.errorReport}</pre>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={visible.length > 0 && visible.every((o) => selected.has(skuOf(o)))}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </th>
            <th>SKU</th>
            <th>Название</th>
            <th>Цена</th>
            <th>Кол-во</th>
            <th>Срок отправки</th>
            <th>Активна</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((o) => (
            <tr key={skuOf(o)}>
              <td>
                <input type="checkbox" checked={selected.has(skuOf(o))} onChange={() => toggle(skuOf(o))} />
              </td>
              <td>{skuOf(o)}</td>
              <td>{o.product_title ?? '—'}</td>
              <td>{o.price ?? '—'}</td>
              <td>{o.quantity ?? '—'}</td>
              <td>{o.leadtime_to_ship ?? '—'}</td>
              <td>{o.active === false ? 'нет' : 'да'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  inactivity_reasons?: { code?: string; label?: string }[];
}

interface ImportStatus {
  status?: string;
  lines_in_error?: number;
  errorReport?: string;
}

type PriceMode = 'none' | 'set' | 'percent' | 'amount';

type SortKey = 'sku' | 'title' | 'price' | 'quantity' | 'leadtime' | 'status';

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'title', label: 'Название' },
  { key: 'price', label: 'Цена' },
  { key: 'quantity', label: 'Кол-во' },
  { key: 'leadtime', label: 'Срок отправки' },
  { key: 'status', label: 'Статус' },
];

export default function Offers() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [fetchedAt, setFetchedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
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
    let list = q
      ? offers.filter(
          (o) => skuOf(o).toLowerCase().includes(q) || (o.product_title ?? '').toLowerCase().includes(q),
        )
      : [...offers];
    if (sortKey) {
      const value = (o: Offer): string | number | undefined => {
        switch (sortKey) {
          case 'sku':
            return skuOf(o);
          case 'title':
            return o.product_title ?? '';
          case 'price':
            return o.price;
          case 'quantity':
            return o.quantity;
          case 'leadtime':
            return o.leadtime_to_ship;
          case 'status':
            return o.active === false ? 0 : 1;
        }
      };
      list = list.sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (va === undefined && vb === undefined) return 0;
        if (va === undefined) return 1; // пустые значения всегда внизу
        if (vb === undefined) return -1;
        const cmp =
          typeof va === 'string' || typeof vb === 'string'
            ? String(va).localeCompare(String(vb), ['pl', 'ru'], { numeric: true, sensitivity: 'base' })
            : Number(va) - Number(vb);
        return cmp * sortDir;
      });
    }
    return list;
  }, [offers, filter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  };

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
    const priceNum = Number(priceValue.replace(',', '.'));
    const changes = offers
      .filter((o) => selected.has(skuOf(o)))
      .map((o) => {
        const change: Record<string, unknown> = { sku: skuOf(o) };
        if (priceMode === 'set' && priceValue) change.price = priceNum;
        if (priceMode === 'percent' && priceValue && o.price !== undefined) {
          change.price = Math.round(o.price * (1 + priceNum / 100) * 100) / 100;
        }
        if (priceMode === 'amount' && priceValue && o.price !== undefined) {
          change.price = Math.round((o.price + priceNum) * 100) / 100;
        }
        if (quantityValue !== '') change.quantity = Number(quantityValue);
        if (leadtimeValue !== '') change.leadtime_to_ship = Number(leadtimeValue);
        return change;
      })
      .filter((c) => Object.keys(c).length > 1);
    const badPrice = changes.find((c) => typeof c.price === 'number' && c.price <= 0);
    if (badPrice) {
      setError(`У оферты ${badPrice.sku} цена после изменения получилась ${badPrice.price} PLN — уменьшите скидку`);
      return;
    }
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

  const deleteSelected = async () => {
    const skus = [...selected];
    if (!skus.length) return;
    const ok = window.confirm(
      `Удалить ${skus.length} оферт с Empik?\n\n${skus.slice(0, 10).join('\n')}${skus.length > 10 ? `\n…и ещё ${skus.length - 10}` : ''}\n\nОтменить это действие будет нельзя — оферты придётся создавать заново.`,
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    setMessage('');
    setImportStatus(null);
    try {
      const r = await postJson<{ importId: number }>('/api/offers/bulk-delete', { skus });
      setMessage(`Удаление ${skus.length} оферт отправлено. Импорт №${r.importId}, ожидаю результат…`);
      await pollImport(r.importId);
      setMessage(`Импорт №${r.importId} завершён. Обновляю список оферт…`);
      await load(true);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления');
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
        <div className="bulk-grid">
          <label className="field">
            <span>Цена</span>
            <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)}>
              <option value="none">не менять</option>
              <option value="set">установить (PLN)</option>
              <option value="percent">изменить на %</option>
              <option value="amount">изменить на сумму (±PLN)</option>
            </select>
          </label>
          <label className="field">
            <span>Значение цены</span>
            <input
              type="text"
              disabled={priceMode === 'none'}
              placeholder={
                priceMode === 'none'
                  ? '—'
                  : priceMode === 'set'
                    ? 'напр. 1849.00'
                    : priceMode === 'percent'
                      ? 'напр. -5 или 10'
                      : 'напр. -50 или 100'
              }
              title={priceMode === 'amount' ? 'Сумма прибавляется к текущей цене каждой оферты: -50 понизит все цены на 50 PLN' : undefined}
              value={priceMode === 'none' ? '' : priceValue}
              onChange={(e) => setPriceValue(e.target.value)}
            />
          </label>
          <button onClick={applyBulk} disabled={busy || selected.size === 0}>
            {busy ? 'Применяю…' : 'Применить к выбранным'}
          </button>
          <label className="field">
            <span>Количество</span>
            <input
              type="number"
              min="0"
              placeholder="не менять"
              value={quantityValue}
              onChange={(e) => setQuantityValue(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Срок отправки (дней)</span>
            <input
              type="number"
              min="0"
              placeholder="не менять"
              value={leadtimeValue}
              onChange={(e) => setLeadtimeValue(e.target.value)}
            />
          </label>
          <button className="danger" onClick={deleteSelected} disabled={busy || selected.size === 0}>
            Удалить выбранные
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
            {SORT_COLUMNS.map((c) => (
              <th key={c.key} className="sortable" onClick={() => toggleSort(c.key)} title="Сортировать">
                {c.label}
                <span className="sort-arrow">{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</span>
              </th>
            ))}
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
              <td>
                {o.active === false ? (
                  <span
                    className="badge err"
                    title={(o.inactivity_reasons ?? []).map((r) => r.label ?? r.code).join('; ') || undefined}
                  >
                    Неактивна
                  </span>
                ) : (
                  <span className="badge ok">Активна</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

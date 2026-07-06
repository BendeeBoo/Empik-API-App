import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, postJson } from '../api';

interface Variant {
  offerId: string;
  title: string;
  pricePln?: number;
  quantity?: number;
  leadtimeDays?: number;
}

interface Group {
  sku: string;
  action: 'new' | 'update' | 'blocked';
  ean?: string;
  eanSource?: 'allegro' | 'dictionary';
  reason?: string;
  variants: Variant[];
  empikPrice?: number;
  empikQuantity?: number;
  empikLeadtime?: number;
}

interface UploadResult {
  fileName: string;
  groups: Group[];
  totalRows: number;
  activeRows: number;
  dictionaryEntries: number;
}

interface RowEdit {
  include: boolean;
  variantIdx: number;
  ean: string;
  price: string;
  quantity: string;
  leadtime: string;
}

interface ImportStatus {
  status?: string;
  offer_inserted?: number;
  offer_updated?: number;
  lines_in_error?: number;
  errorReport?: string;
}

function editFromVariant(g: Group, idx: number, prev?: RowEdit): RowEdit {
  const v = g.variants[idx];
  return {
    include: prev?.include ?? false,
    variantIdx: idx,
    ean: prev?.ean ?? g.ean ?? '',
    price: v.pricePln !== undefined ? String(v.pricePln) : '',
    quantity: v.quantity !== undefined ? String(v.quantity) : '',
    leadtime: v.leadtimeDays !== undefined ? String(v.leadtimeDays) : '',
  };
}

export default function ImportPage() {
  const [data, setData] = useState<UploadResult | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [dict, setDict] = useState<{ updatedAt: string | null; entries: number } | null>(null);

  useEffect(() => {
    api<{ updatedAt: string | null; entries: number }>('/api/ean-dictionary')
      .then(setDict)
      .catch(() => undefined);
  }, []);

  const uploadDictionary = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const d = await api<{ updatedAt: string; entries: number }>('/api/ean-dictionary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      setDict(d);
      setMessage(`Справочник EAN загружен: ${d.entries} записей. Он сохранён и будет применяться ко всем импортам.`);
      // если выгрузка уже загружена — предложим перезагрузить её, чтобы применить справочник
      if (data) setMessage((m) => m + ' Загрузите файл выгрузки Allegro заново, чтобы применить справочник.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки справочника');
    } finally {
      setBusy(false);
    }
  };

  const uploadAllegro = async (file: File) => {
    setBusy(true);
    setError('');
    setMessage('');
    setImportStatus(null);
    setData(null);
    try {
      const r = await api<UploadResult>(`/api/allegro/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      setData(r);
      const initial: Record<string, RowEdit> = {};
      for (const g of r.groups) initial[g.sku] = editFromVariant(g, 0);
      setEdits(initial);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки файла');
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    const c = { new: 0, update: 0, blocked: 0 };
    for (const g of data?.groups ?? []) c[actionOf(g, edits[g.sku])]++;
    return c;
  }, [data, edits]);

  function actionOf(g: Group, e?: RowEdit): 'new' | 'update' | 'blocked' {
    if (g.action === 'update') return 'update';
    return (e?.ean ?? g.ean ?? '').trim() ? 'new' : 'blocked';
  }

  const visibleGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!data) return [];
    if (!q) return data.groups;
    return data.groups.filter(
      (g) =>
        g.sku.toLowerCase().includes(q) ||
        g.variants.some((v) => v.title.toLowerCase().includes(q)),
    );
  }, [data, filter]);

  const setEdit = (sku: string, patch: Partial<RowEdit>) => {
    setEdits((prev) => ({ ...prev, [sku]: { ...prev[sku], ...patch } }));
  };

  const selectVariant = (g: Group, idx: number) => {
    setEdits((prev) => ({ ...prev, [g.sku]: editFromVariant(g, idx, prev[g.sku]) }));
  };

  const setAllIncluded = (pred: (g: Group) => boolean, include: boolean) => {
    setEdits((prev) => {
      const next = { ...prev };
      for (const g of data?.groups ?? []) {
        if (pred(g) && actionOf(g, next[g.sku]) !== 'blocked') {
          next[g.sku] = { ...next[g.sku], include };
        }
      }
      return next;
    });
  };

  const buildRows = () => {
    if (!data) return [];
    return data.groups
      .filter((g) => edits[g.sku]?.include && actionOf(g, edits[g.sku]) !== 'blocked')
      .map((g) => {
        const e = edits[g.sku];
        const v = g.variants[e.variantIdx];
        const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
        return {
          sku: g.sku,
          ean: e.ean.trim() || undefined,
          description: v.title,
          price: num(e.price),
          quantity: num(e.quantity),
          leadtimeDays: num(e.leadtime),
        };
      });
  };

  const pollImport = async (importId: number) => {
    for (let i = 0; i < 40; i++) {
      const st = await api<ImportStatus>(`/api/imports/${importId}`);
      setImportStatus(st);
      if (st.status === 'COMPLETE' || st.status === 'FAILED') return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  const send = async () => {
    const rows = buildRows();
    if (!rows.length) {
      setError('Отметьте галочками строки, которые нужно отправить');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    setImportStatus(null);
    try {
      const r = await postJson<{ importId: number; sent: number }>('/api/allegro/send', { rows });
      setMessage(`Отправлено строк: ${r.sent}. Импорт Empik №${r.importId}, ожидаю результат…`);
      await pollImport(r.importId);
      setMessage(`Импорт №${r.importId} завершён — результат ниже. Обновлённые оферты смотрите на вкладке «Оферты».`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка отправки');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    const rows = buildRows();
    if (!rows.length) {
      setError('Отметьте галочками строки для скачивания');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/allegro/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `Ошибка ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'empik-offers-import.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка скачивания');
    } finally {
      setBusy(false);
    }
  };

  const includedCount = data ? data.groups.filter((g) => edits[g.sku]?.include && actionOf(g, edits[g.sku]) !== 'blocked').length : 0;

  return (
    <div>
      <div className="card row wrap">
        <div className="field">
          <span className="muted">1. Выгрузка оферт Allegro (.xlsm)</span>
          <input type="file" accept=".xlsm,.xlsx" disabled={busy} onChange={(e) => e.target.files?.[0] && uploadAllegro(e.target.files[0])} />
        </div>
        <div className="field">
          <span className="muted">
            2. Справочник EAN (xlsx: Название | EAN){' '}
            {dict?.entries ? `— загружен: ${dict.entries} записей от ${fmtDate(dict.updatedAt)}` : '— ещё не загружен'}
          </span>
          <input type="file" accept=".xlsx" disabled={busy} onChange={(e) => e.target.files?.[0] && uploadDictionary(e.target.files[0])} />
        </div>
      </div>

      {busy && !data && <div className="card info">Обрабатываю…</div>}
      {error && <div className="card error">{error}</div>}
      {message && <div className="card info">{message}</div>}
      {importStatus && (
        <div className="card">
          Статус импорта: <b>{importStatus.status ?? '—'}</b>
          {importStatus.offer_inserted ? `, создано: ${importStatus.offer_inserted}` : ''}
          {importStatus.offer_updated ? `, обновлено: ${importStatus.offer_updated}` : ''}
          {importStatus.lines_in_error ? `, строк с ошибками: ${importStatus.lines_in_error}` : ''}
          {importStatus.errorReport && <pre className="report">{importStatus.errorReport}</pre>}
        </div>
      )}

      {data && (
        <>
          <div className="card row wrap">
            <span>
              <b>{data.fileName}</b>: {data.activeRows} активных оферт → {data.groups.length} SKU ·{' '}
              <span className="badge ok">новых: {counts.new}</span>{' '}
              <span className="badge">обновлений: {counts.update}</span>{' '}
              <span className="badge err">без EAN: {counts.blocked}</span>
            </span>
            <div className="grow" />
            <button className="secondary" onClick={() => setAllIncluded((g) => actionOf(g, edits[g.sku]) === 'update', true)} disabled={busy}>
              Отметить обновления
            </button>
            <button className="secondary" onClick={() => setAllIncluded((g) => actionOf(g, edits[g.sku]) === 'new', true)} disabled={busy}>
              Отметить новые
            </button>
            <button className="secondary" onClick={() => setAllIncluded(() => true, false)} disabled={busy}>
              Снять выбор
            </button>
          </div>

          <div className="card row">
            <input className="grow" placeholder="Поиск по SKU или названию…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="muted">Отмечено: {includedCount}</span>
            <button onClick={send} disabled={busy || includedCount === 0}>
              {busy ? 'Работаю…' : `Отправить в Empik (${includedCount})`}
            </button>
            <button className="secondary" onClick={download} disabled={busy || includedCount === 0}>
              Скачать XLSX
            </button>
          </div>

          <table>
            <thead>
              <tr>
                <th></th>
                <th>Действие</th>
                <th>SKU</th>
                <th>Оферта-источник (из дублей Allegro)</th>
                <th>EAN</th>
                <th>Цена</th>
                <th>Кол-во</th>
                <th>Срок, дн.</th>
                <th>Сейчас на Empik</th>
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((g) => {
                const e = edits[g.sku];
                if (!e) return null;
                const action = actionOf(g, e);
                return (
                  <tr key={g.sku} className={action === 'blocked' ? 'dim' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={action === 'blocked'}
                        checked={e.include}
                        onChange={(ev) => setEdit(g.sku, { include: ev.target.checked })}
                      />
                    </td>
                    <td>
                      <span
                        className={`badge ${action === 'new' ? 'ok' : action === 'blocked' ? 'err' : ''}`}
                        title={action === 'blocked' ? g.reason : undefined}
                      >
                        {action === 'new' ? 'Новая' : action === 'update' ? 'Обновление' : 'Нет EAN'}
                      </span>
                    </td>
                    <td>{g.sku}</td>
                    <td>
                      {g.variants.length === 1 ? (
                        <span title={g.variants[0].title}>{g.variants[0].title.slice(0, 45)}</span>
                      ) : (
                        <select value={e.variantIdx} onChange={(ev) => selectVariant(g, Number(ev.target.value))} title="У этого SKU несколько оферт на Allegro — выберите, чьи данные взять">
                          {g.variants.map((v, i) => (
                            <option key={v.offerId} value={i}>
                              {`${v.pricePln ?? '?'} PLN · ${v.quantity ?? '?'} шт · ${v.title.slice(0, 40)}`}
                            </option>
                          ))}
                        </select>
                      )}
                      {g.variants.length > 1 && <div className="muted" style={{ fontSize: 11 }}>дублей: {g.variants.length}</div>}
                    </td>
                    <td>
                      <input
                        type="text"
                        style={{ width: 130 }}
                        placeholder="нет"
                        value={e.ean}
                        onChange={(ev) => setEdit(g.sku, { ean: ev.target.value })}
                        title={g.eanSource === 'dictionary' ? 'EAN найден в справочнике' : g.eanSource === 'allegro' ? 'EAN из выгрузки Allegro' : 'Впишите EAN вручную'}
                      />
                      {g.eanSource === 'dictionary' && <div className="muted" style={{ fontSize: 11 }}>из справочника</div>}
                    </td>
                    <td>
                      <input type="text" style={{ width: 80 }} value={e.price} onChange={(ev) => setEdit(g.sku, { price: ev.target.value })} />
                    </td>
                    <td>
                      <input type="text" style={{ width: 60 }} value={e.quantity} onChange={(ev) => setEdit(g.sku, { quantity: ev.target.value })} />
                    </td>
                    <td>
                      <input type="text" style={{ width: 45 }} value={e.leadtime} onChange={(ev) => setEdit(g.sku, { leadtime: ev.target.value })} />
                    </td>
                    <td className="muted">
                      {g.action === 'update'
                        ? `${g.empikPrice ?? '—'} PLN · ${g.empikQuantity ?? '—'} шт · ${g.empikLeadtime ?? '—'} дн.`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {!data && !busy && (
        <div className="card">
          <h3>Как это работает</h3>
          <p className="muted">
            1. Загрузите выгрузку оферт Allegro — приложение возьмёт только <b>активные</b> оферты и сгруппирует их по SKU
            (дубли одного товара объединяются, оферту-источник данных вы выбираете сами).
            <br />
            2. Для товаров, которых ещё нет на Empik, нужен EAN: он берётся из выгрузки, из справочника EAN или вписывается вручную прямо в таблице.
            <br />
            3. Перед отправкой цену, количество и срок отправки каждой строки можно править. Отправляются только отмеченные галочкой строки.
          </p>
        </div>
      )}
    </div>
  );
}

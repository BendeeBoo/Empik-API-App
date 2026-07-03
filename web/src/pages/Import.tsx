import { useMemo, useState } from 'react';
import { api, postJson } from '../api';

interface PreviewRow {
  offerId: string;
  status: string;
  sku: string;
  ean?: string;
  title: string;
  pricePln?: number;
  quantity?: number;
  leadtimeDays?: number;
  category: string;
  action: 'new' | 'update' | 'blocked';
  reason?: string;
  empikPrice?: number;
  empikQuantity?: number;
}

interface Session {
  id: string;
  fileName: string;
  rows: PreviewRow[];
}

const ACTION_LABEL: Record<PreviewRow['action'], string> = {
  new: 'Новая',
  update: 'Обновление',
  blocked: 'Нельзя создать',
};

export default function ImportPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [includeNew, setIncludeNew] = useState(true);
  const [includeUpdates, setIncludeUpdates] = useState(true);
  const [priceAdjust, setPriceAdjust] = useState('0');

  const counts = useMemo(() => {
    const c = { new: 0, update: 0, blocked: 0 };
    for (const r of session?.rows ?? []) c[r.action]++;
    return c;
  }, [session]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    setMessage('');
    setSession(null);
    try {
      const s = await api<Session>(`/api/allegro/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      setSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки файла');
    } finally {
      setBusy(false);
    }
  };

  const opts = () => ({
    includeNew,
    includeUpdates,
    priceAdjustPercent: Number(priceAdjust.replace(',', '.')) || 0,
  });

  const send = async () => {
    if (!session) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await postJson<{ importId: number; sent: number }>(`/api/allegro/${session.id}/send`, opts());
      setMessage(`Отправлено оферт: ${r.sent}. Импорт Empik №${r.importId} — результат смотрите на вкладке «Оферты» после завершения обработки.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка отправки');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/allegro/${session.id}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts()),
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

  return (
    <div>
      <div className="card">
        <h3>Импорт оферт из выгрузки Allegro (.xlsm)</h3>
        <p className="muted">
          Загрузите файл выгрузки оферт Allegro (лист «Szablon»). Приложение сопоставит оферты с Empik по SKU:
          существующие будут обновлены (цена, количество, срок отправки), новые — созданы по EAN.
        </p>
        <input
          type="file"
          accept=".xlsm,.xlsx"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
      </div>

      {busy && !session && <div className="card info">Обрабатываю файл…</div>}
      {error && <div className="card error">{error}</div>}
      {message && <div className="card info">{message}</div>}

      {session && (
        <>
          <div className="card row wrap">
            <span>
              <b>{session.fileName}</b>: всего {session.rows.length} ·{' '}
              <span className="badge ok">новых: {counts.new}</span>{' '}
              <span className="badge">обновлений: {counts.update}</span>{' '}
              <span className="badge err">нельзя создать: {counts.blocked}</span>
            </span>
            <div className="grow" />
            <label>
              <input type="checkbox" checked={includeNew} onChange={(e) => setIncludeNew(e.target.checked)} />
              создавать новые
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeUpdates}
                onChange={(e) => setIncludeUpdates(e.target.checked)}
              />
              обновлять существующие
            </label>
            <label>
              Корректировка цены, %:
              <input
                type="text"
                style={{ width: 70 }}
                value={priceAdjust}
                onChange={(e) => setPriceAdjust(e.target.value)}
                title="Например 5 — цена Allegro +5%, -3 — цена Allegro минус 3%"
              />
            </label>
            <button onClick={send} disabled={busy}>
              Отправить в Empik
            </button>
            <button onClick={download} disabled={busy} className="secondary">
              Скачать XLSX для панели
            </button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Действие</th>
                <th>SKU</th>
                <th>Название (Allegro)</th>
                <th>EAN</th>
                <th>Цена Allegro</th>
                <th>Цена Empik</th>
                <th>Кол-во</th>
                <th>Срок, дн.</th>
              </tr>
            </thead>
            <tbody>
              {session.rows.map((r, i) => (
                <tr key={`${r.sku}-${i}`} className={r.action === 'blocked' ? 'dim' : ''}>
                  <td>
                    <span
                      className={`badge ${r.action === 'new' ? 'ok' : r.action === 'blocked' ? 'err' : ''}`}
                      title={r.reason}
                    >
                      {ACTION_LABEL[r.action]}
                    </span>
                  </td>
                  <td>{r.sku}</td>
                  <td>{r.title}</td>
                  <td>{r.ean ?? '—'}</td>
                  <td>{r.pricePln ?? '—'}</td>
                  <td>{r.empikPrice ?? '—'}</td>
                  <td>{r.quantity ?? '—'}</td>
                  <td>{r.leadtimeDays ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

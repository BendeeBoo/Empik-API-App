import { useEffect, useState } from 'react';
import { api, ApiError, postJson } from './api';
import Orders from './pages/Orders';
import Offers from './pages/Offers';
import ImportPage from './pages/Import';

type Tab = 'orders' | 'offers' | 'import';

const TABS: { id: Tab; label: string }[] = [
  { id: 'orders', label: 'Заказы' },
  { id: 'offers', label: 'Оферты' },
  { id: 'import', label: 'Импорт из Allegro' },
];

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await postJson('/api/login', { password });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Empik API App</h1>
        <p className="muted">Введите пароль (задаётся в файле .env, переменная APP_PASSWORD)</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
          autoFocus
        />
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('orders');
  const [authState, setAuthState] = useState<'checking' | 'anon' | 'authed'>('checking');
  const [mockMode, setMockMode] = useState(false);

  useEffect(() => {
    api<{ mockMode: boolean }>('/api/orders/status')
      .then((s) => {
        setMockMode(s.mockMode);
        setAuthState('authed');
      })
      .catch((e) => {
        setAuthState(e instanceof ApiError && e.status === 401 ? 'anon' : 'anon');
      });
  }, []);

  if (authState === 'checking') return <div className="login-wrap muted">Загрузка…</div>;
  if (authState === 'anon') return <Login onSuccess={() => window.location.reload()} />;

  return (
    <div className="layout">
      <header>
        <span className="logo">Empik API App</span>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {mockMode && <span className="badge warn">Демо-режим: ключ API не задан</span>}
      </header>
      <main>
        {tab === 'orders' && <Orders />}
        {tab === 'offers' && <Offers />}
        {tab === 'import' && <ImportPage />}
      </main>
    </div>
  );
}

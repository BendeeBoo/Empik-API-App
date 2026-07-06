/** Обёртка над fetch: JSON, единая обработка ошибок и 401. */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    // сеть недоступна — сервер приложения не запущен или перезапускается
    throw new ApiError(0, 'Нет соединения с сервером приложения. Проверьте, что оно запущено (npm start), и обновите страницу.');
  }
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof body === 'object' && body?.error ? body.error : `Ошибка ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export function postJson<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

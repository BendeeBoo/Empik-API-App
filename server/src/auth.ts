/**
 * Простая защита паролем: интерфейс доступен из интернета через Cloudflare Tunnel,
 * поэтому все /api/* (кроме /api/login) требуют cookie с токеном сессии.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const COOKIE_NAME = 'empik_session';

function sessionToken(): string {
  return crypto.createHmac('sha256', config.appPassword || 'no-password').update('empik-app-session-v1').digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function loginHandler(req: Request, res: Response) {
  const { password } = (req.body ?? {}) as { password?: string };
  if (!config.appPassword) {
    res.status(500).json({ error: 'APP_PASSWORD не задан в .env — задайте пароль и перезапустите сервер' });
    return;
  }
  if (typeof password !== 'string' || !timingSafeEqual(password, config.appPassword)) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${sessionToken()}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`,
  );
  res.json({ ok: true });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token && timingSafeEqual(token, sessionToken())) {
    next();
    return;
  }
  res.status(401).json({ error: 'Требуется вход' });
}

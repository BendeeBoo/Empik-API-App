import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env лежит в корне репозитория (на уровень выше server/)
export const ROOT_DIR = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

export const config = {
  empikApiKey: process.env.EMPIK_API_KEY ?? '',
  empikBaseUrl: (process.env.EMPIK_BASE_URL ?? 'https://marketplace.empik.com').replace(/\/+$/, ''),
  pollMinutes: Math.max(5, Number(process.env.POLL_MINUTES) || 60),
  appPassword: process.env.APP_PASSWORD ?? '',
  port: Number(process.env.PORT) || 3000,
  dataDir: path.join(ROOT_DIR, 'data'),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  // Без ключа API приложение работает в демо-режиме с фиктивными данными
  get mockMode() {
    return !this.empikApiKey;
  },
};

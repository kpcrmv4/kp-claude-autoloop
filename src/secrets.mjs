import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Default location: <repo-root>/autoloop.secrets.json (gitignored). */
export const defaultSecretsPath = resolve(repoRoot, 'autoloop.secrets.json');

/**
 * Load notify secrets. Never throws; missing/broken file → {}.
 * Shape: { "telegram": { "token": "...", "chatId": "..." }, "webhookUrl": "https://..." }
 * Values are never logged anywhere.
 */
export function loadSecrets(path) {
  const file = path ? resolve(path) : defaultSecretsPath;
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

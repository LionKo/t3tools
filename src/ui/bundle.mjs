import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(uiDir, '..', '..');

export function loadSelectorsConfig() {
  return JSON.parse(readFileSync(join(rootDir, 'config', 'selectors.json'), 'utf8'));
}

/**
 * Assemble the self-contained client IIFE injected into T3 Code via CDP (or loaded over HTTP).
 * Uses function replacement so '$' patterns inside user-edited selectors are preserved literally (fixes P3).
 */
export function buildClientBundle({
  version = '0.1.0',
  bootId = '',
  transport = 'cdp',
  apiBase = 'http://127.0.0.1:17373',
  authToken = ''
} = {}) {
  const selectors = loadSelectorsConfig();
  const themeSyncSrc = readFileSync(join(uiDir, 'theme-sync.js'), 'utf8');
  const sharedViewsSrc = readFileSync(join(uiDir, 'shared-views.js'), 'utf8');
  const clientSrc = readFileSync(join(uiDir, 'injected-client.js'), 'utf8');

  const configJson = JSON.stringify({ version, bootId, transport, apiBase, authToken, selectors });
  const bootSrc = clientSrc.replace('__T3TOOLS_CONFIG__', () => configJson);

  return `(() => {\n${themeSyncSrc}\n${sharedViewsSrc}\n${bootSrc}\n})();\n`;
}

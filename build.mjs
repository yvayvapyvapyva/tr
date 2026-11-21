#!/usr/bin/env node
/* ============================================================
   СБОРКА БИЛДА для хостинга (build/index.html + build/version.txt)

   Собирает исходники из корня репозитория в один минифицированный
   файл, как описано в build/AGENTS.md:
     carConfig.js + transmission.js + тело <script type="module">
     из scep3d.html + report.js → один ES-модуль;
   CSS и служебные скрипты минифицируются отдельно.

   Запуск:  node build.mjs
   Требуется esbuild (берётся через npx, ставить в проект не нужно).

   ВАЖНО: перед деплоем обновите version.txt в корне — скрипт
   скопирует его в build/version.txt. Без смены версии Telegram
   WebView продолжит показывать старый закэшированный билд.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, 'build');
const ENTRY = path.join(ROOT, '.build-entry.js');
const TMP = path.join(ROOT, '.build-tmp');

function fail(msg) {
  console.error('\n✖ ' + msg + '\n');
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ENTRY, { force: true }); } catch {}
}

/* запуск esbuild через npx */
function esbuild(args, stdin) {
  const r = spawnSync('npx', ['--yes', 'esbuild', ...args], {
    cwd: ROOT,
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) fail('esbuild не запустился: ' + r.error.message);
  if (r.status !== 0) fail('esbuild завершился с ошибкой:\n' + (r.stderr || r.stdout));
  return r.stdout;
}

/* ---------- 1. Разбор исходного scep3d.html ---------- */
const src = fs.readFileSync(path.join(ROOT, 'scep3d.html'), 'utf8');

const headSrc = (src.match(/<head>([\s\S]*?)<\/head>/) || [])[1];
if (!headSrc) fail('в scep3d.html не найден <head>');

const styleSrc = (headSrc.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
if (!styleSrc) fail('в scep3d.html не найден <style>');

const versionScriptSrc = (headSrc.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!versionScriptSrc) fail('в scep3d.html не найден скрипт версионирования');

const metas = [...headSrc.matchAll(/<meta\b[^>]*>/g)].map(m => m[0]);
const title = ((headSrc.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '3D симулятор').trim();

const importmap = (src.match(/<script type="importmap">([\s\S]*?)<\/script>/) || [])[1];
if (!importmap) fail('в scep3d.html не найден importmap');

const moduleBody = (src.match(/<script type="module">([\s\S]*?)<\/script>/) || [])[1];
if (!moduleBody) fail('в scep3d.html не найден <script type="module">');

let bodyHtml = (src.match(/<body>([\s\S]*?)<script type="importmap">/) || [])[1];
if (!bodyHtml) fail('не удалось извлечь разметку <body>');
bodyHtml = bodyHtml
  .replace(/<!--[\s\S]*?-->/g, '')     // HTML-комментарии в билд не нужны
  .replace(/[ \t]+\n/g, '\n')
  .trim();

/* ---------- 2. Сборка модуля приложения ---------- */
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(ENTRY, moduleBody, 'utf8');

esbuild([
  ENTRY,
  '--bundle',
  '--minify',
  '--format=esm',
  '--target=es2020',
  '--legal-comments=none',
  '--external:three',
  '--external:three/addons/controls/OrbitControls.js',
  '--outfile=' + path.join(TMP, 'app.js'),
]);
const appJs = fs.readFileSync(path.join(TMP, 'app.js'), 'utf8').trim();

/* ---------- 3. Минификация CSS, скрипта версии и report.js ---------- */
const css = esbuild(['--loader=css', '--minify', '--target=es2020'], styleSrc).trim();

const versionScript = esbuild(
  ['--loader=js', '--minify', '--target=es2020'],
  versionScriptSrc
).trim();

const reportSrc = fs.readFileSync(path.join(ROOT, 'report.js'), 'utf8');
const reportJs = esbuild(
  ['--loader=js', '--minify', '--target=es2020'],
  reportSrc
).trim();

/* ---------- 4. Сборка итогового HTML ---------- */
const html = `<!DOCTYPE html>
<html lang="ru">
<head>
${metas.join('\n')}
<script>${versionScript}</script>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${bodyHtml}
<script type="importmap">
${importmap.trim()}
</script>
<script type="module">
${appJs}
${reportJs}
</script>
</body>
</html>
`;

/* ---------- 5. Запись результата ---------- */
const versionSrcFile = path.join(ROOT, 'version.txt');
if (!fs.existsSync(versionSrcFile)) fail('в корне нет version.txt');
const version = fs.readFileSync(versionSrcFile, 'utf8').trim();
if (!version) fail('version.txt пуст');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'version.txt'), version, 'utf8');

cleanup();

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('✔ build/index.html  ' + kb(Buffer.byteLength(html)));
console.log('✔ build/version.txt ' + version);

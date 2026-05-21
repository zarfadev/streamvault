#!/usr/bin/env node
/**
 * Extracts inline <script> blocks from HTML files to external .js files.
 * Replaces <script>...</script> with <script src="..." defer></script>
 * This enables strict CSP without 'unsafe-inline'.
 */
const fs   = require('fs');
const path = require('path');

const PAIRS = [
  ['public/index.html',           'public/js/app-landing.js'],
  ['public/login/index.html',     'public/js/app-login.js'],
  ['public/dashboard/index.html', 'public/js/app-dashboard.js'],
  ['public/admin/index.html',     'public/js/app-admin.js'],
  ['public/player/index.html',    'public/js/app-player.js'],
  ['public/watch/index.html',     'public/js/app-watch.js'],
  ['public/embed/index.html',     'public/js/app-embed.js'],
];

let ok = 0, skip = 0;

for (const [htmlPath, jsPath] of PAIRS) {
  const content = fs.readFileSync(htmlPath, 'utf8');

  // Match first bare <script> (no src attr) block
  const RE = /<script(?!\s+src)>([\s\S]*?)<\/script>/;
  const m  = RE.exec(content);
  if (!m) {
    console.log('SKIP (already external or not found):', htmlPath);
    skip++;
    continue;
  }

  const jsContent = m[1].replace(/^\n/, '');

  // Write JS file
  fs.mkdirSync(path.dirname(jsPath), { recursive: true });
  fs.writeFileSync(jsPath, jsContent, 'utf8');

  // Relative path from HTML dir to JS file
  const relJs = path.relative(path.dirname(htmlPath), jsPath).replace(/\\/g, '/');

  // Replace inline block with external reference
  const newHtml = content.replace(RE, `<script src="${relJs}" defer></script>`);
  fs.writeFileSync(htmlPath, newHtml, 'utf8');

  console.log(`✅  ${jsPath}  (${jsContent.split('\n').length} lines)`);
  console.log(`    Updated: ${htmlPath}`);
  ok++;
}

console.log(`\nDone: ${ok} extracted, ${skip} skipped.`);

#!/usr/bin/env node
/**
 * extension-server.mjs
 *
 * Local HTTP server that receives page captures from the Mycloneweb browser extension.
 * Saves screenshots, HTML, and metadata to docs/design-references/ so Claude Code
 * can read them and run /clone-website.
 *
 * Usage:
 *   npm run extension-server
 *   node scripts/extension-server.mjs
 *
 * Endpoints:
 *   GET  /health   — ping (extension checks this to show green dot)
 *   POST /capture  — receive a captured page
 *   POST /clear    — delete all files in docs/design-references/
 */

import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'design-references');
const PORT = 3001;

// ─── helpers ─────────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
};

function log(msg, color = c.reset) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${c.dim}[${ts}]${c.reset} ${color}${msg}${c.reset}`);
}

function slugify(url) {
  return url
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// ─── handlers ─────────────────────────────────────────────────────────────────

async function handleCapture(req, res) {
  let data;
  try {
    data = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { url, screenshot, html, links = [], title = '', styles = [], meta = {} } = data;
  if (!url) return json(res, 400, { error: 'Missing url' });

  const slug = slugify(url);
  const files = [];

  // Save screenshot
  if (screenshot) {
    const base64 = screenshot.replace(/^data:image\/\w+;base64,/, '');
    const imgPath = path.join(SCREENSHOTS_DIR, `${slug}-screenshot.png`);
    await fs.writeFile(imgPath, Buffer.from(base64, 'base64'));
    files.push(`${slug}-screenshot.png`);
    log(`  📸 Screenshot saved`, c.green);
  }

  // Save HTML
  if (html) {
    const htmlPath = path.join(SCREENSHOTS_DIR, `${slug}.html`);
    await fs.writeFile(htmlPath, html);
    files.push(`${slug}.html`);
    log(`  📄 HTML saved (${Math.round(html.length / 1024)}KB)`, c.green);
  }

  // Save metadata (links, title, styles, meta tags)
  const metaPath = path.join(SCREENSHOTS_DIR, `${slug}.json`);
  await fs.writeFile(metaPath, JSON.stringify({
    url,
    title,
    capturedAt: new Date().toISOString(),
    links,
    stylesheets: styles,
    meta,
  }, null, 2));
  files.push(`${slug}.json`);

  // Update/append to SCRAPE_INDEX.md
  const indexPath = path.join(SCREENSHOTS_DIR, 'SCRAPE_INDEX.md');
  let index = '';
  try { index = await fs.readFile(indexPath, 'utf8'); } catch { index = `# Captured Pages\n\n`; }

  if (!index.includes(url)) {
    index += `## ${title || url}\n- URL: ${url}\n- Slug: ${slug}\n- Captured: ${new Date().toISOString()}\n- Links found: ${links.length}\n\n`;
    await fs.writeFile(indexPath, index);
  }

  log(`✓ Captured: ${url}`, c.green);
  log(`  ${links.length} links found on this page`, c.dim);

  return json(res, 200, { slug, files, links, url });
}

async function handleClear(res) {
  try {
    const entries = await fs.readdir(SCREENSHOTS_DIR);
    let count = 0;
    for (const entry of entries) {
      if (entry === '.gitkeep') continue;
      await fs.rm(path.join(SCREENSHOTS_DIR, entry), { recursive: true, force: true });
      count++;
    }
    log(`Cleared ${count} files from docs/design-references/`, c.yellow);
    return json(res, 200, { cleared: count });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ─── server ───────────────────────────────────────────────────────────────────

await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = req.url?.split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, { ok: true, dir: SCREENSHOTS_DIR });
  }

  if (req.method === 'POST' && url === '/capture') {
    return handleCapture(req, res);
  }

  if (req.method === 'POST' && url === '/clear') {
    return handleClear(res);
  }

  return json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`${c.bold}${c.blue}  Mycloneweb Extension Server${c.reset}`);
  console.log(`${c.dim}  ──────────────────────────────────────${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Listening on ${c.bold}http://localhost:${PORT}${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Saving to ${c.dim}docs/design-references/${c.reset}`);
  console.log('');
  console.log(`  Install the extension in Edge, then click ${c.bold}Capture This Page${c.reset}`);
  console.log(`  When done, open Claude Code and run ${c.bold}/clone-website${c.reset}`);
  console.log('');
  console.log(`${c.dim}  Waiting for captures...${c.reset}`);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`${c.red}  Port ${PORT} is already in use.${c.reset}`);
    console.error(`  Kill the other process: ${c.dim}npx kill-port 3001${c.reset}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

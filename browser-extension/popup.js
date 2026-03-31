const SERVER = 'http://localhost:3001';
let crawling = false;
let stopCrawl = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot   = document.getElementById('status-dot');
const statusText  = document.getElementById('status-text');
const pageUrl     = document.getElementById('page-url');
const btnCapture  = document.getElementById('btn-capture');
const btnCrawl    = document.getElementById('btn-crawl');
const btnStop     = document.getElementById('btn-stop');
const btnClear    = document.getElementById('btn-clear');
const logArea     = document.getElementById('log-area');
const progressBar = document.getElementById('progress-bar');
const progressFill= document.getElementById('progress-fill');

// ─── logging ──────────────────────────────────────────────────────────────────
function log(msg, type = '') {
  logArea.classList.add('visible');
  const line = document.createElement('div');
  line.className = 'log-line ' + type;
  line.textContent = msg;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

// ─── server health ────────────────────────────────────────────────────────────
async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      statusDot.className = 'dot green pulse';
      statusText.textContent = 'Server connected — ready to capture';
      btnCapture.disabled = false;
      btnCrawl.disabled = false;
      return true;
    }
  } catch {
    // fall through
  }
  statusDot.className = 'dot red';
  statusText.textContent = 'Server offline — run: npm run extension-server';
  btnCapture.disabled = true;
  btnCrawl.disabled = true;
  return false;
}

// ─── get current tab ──────────────────────────────────────────────────────────
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── capture single page ──────────────────────────────────────────────────────
async function capturePage(tabId, url) {
  // 1. Screenshot (visible viewport)
  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  } catch (e) {
    log(`Screenshot failed: ${e.message}`, 'err');
  }

  // 2. Extract page data via content script
  let pageData = {};
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageData,
    });
    pageData = results[0]?.result || {};
  } catch (e) {
    log(`Content extraction failed: ${e.message}`, 'err');
  }

  // 3. Send to local server
  const payload = {
    url,
    screenshot,          // base64 data URL
    html:    pageData.html    || '',
    links:   pageData.links   || [],
    title:   pageData.title   || '',
    styles:  pageData.styles  || [],
    meta:    pageData.meta    || {},
  };

  const res = await fetch(`${SERVER}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return await res.json();
}

// ─── content script function (runs IN the page) ───────────────────────────────
function extractPageData() {
  // Collect all internal links
  const origin = location.origin;
  const links = [...new Set(
    [...document.querySelectorAll('a[href]')]
      .map(a => {
        try {
          const u = new URL(a.href);
          return u.origin === origin && u.protocol.startsWith('http') ? u.href : null;
        } catch { return null; }
      })
      .filter(Boolean)
  )];

  // Collect stylesheet hrefs
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map(l => l.href)
    .filter(Boolean);

  // Collect meta tags
  const meta = {};
  document.querySelectorAll('meta').forEach(m => {
    const name = m.getAttribute('name') || m.getAttribute('property');
    const content = m.getAttribute('content');
    if (name && content) meta[name] = content;
  });

  return {
    html:  document.documentElement.outerHTML,
    title: document.title,
    links,
    styles,
    meta,
  };
}

// ─── capture current page ─────────────────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  const ok = await checkServer();
  if (!ok) return;

  const tab = await getCurrentTab();
  btnCapture.disabled = true;
  btnCapture.textContent = '⏳ Capturing...';
  log(`Capturing: ${tab.url}`, 'inf');

  try {
    const result = await capturePage(tab.id, tab.url);
    log(`✓ Saved: ${result.slug}`, 'ok');
    log(`  → ${result.files.join(', ')}`, 'ok');
    statusText.textContent = `Captured! Open Claude Code and run /clone-website`;
  } catch (e) {
    log(`Error: ${e.message}`, 'err');
  } finally {
    btnCapture.disabled = false;
    btnCapture.innerHTML = `<span class="icon">📸</span><span class="btn-text">Capture This Page<div class="btn-sub">Screenshot + HTML + CSS + links → Claude Code</div></span>`;
  }
});

// ─── crawl entire site ────────────────────────────────────────────────────────
btnCrawl.addEventListener('click', async () => {
  const ok = await checkServer();
  if (!ok) return;

  const tab = await getCurrentTab();
  const origin = new URL(tab.url).origin;

  crawling = true;
  stopCrawl = false;
  btnCrawl.style.display = 'none';
  btnStop.style.display = '';
  btnCapture.disabled = true;
  progressBar.classList.add('visible');

  const visited = new Set();
  const queue = [tab.url];
  let captured = 0;

  log(`Starting crawl of ${origin}`, 'inf');

  while (queue.length > 0 && !stopCrawl) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    log(`[${captured + 1}] ${url}`, '');

    try {
      // Navigate the current tab to this URL
      await chrome.tabs.update(tab.id, { url });

      // Wait for page to load
      await waitForTabLoad(tab.id);
      await sleep(3000); // 3s delay to avoid hammering the server

      const result = await capturePage(tab.id, url);
      captured++;
      log(`  ✓ ${result.slug}`, 'ok');

      // Add newly discovered links to queue
      for (const link of (result.links || [])) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }

      // Update progress bar (rough estimate)
      const total = visited.size + queue.length;
      progressFill.style.width = `${Math.min(100, (captured / total) * 100)}%`;

    } catch (e) {
      log(`  ✗ ${e.message}`, 'err');
    }
  }

  crawling = false;
  btnCrawl.style.display = '';
  btnStop.style.display = 'none';
  btnCapture.disabled = false;
  progressFill.style.width = '100%';
  log(`Done! ${captured} pages captured.`, 'ok');
  statusText.textContent = `Crawl complete — ${captured} pages. Run /clone-website in Claude Code.`;
});

btnStop.addEventListener('click', () => {
  stopCrawl = true;
  log('Stopping after current page...', 'inf');
});

// ─── clear all files ──────────────────────────────────────────────────────────
btnClear.addEventListener('click', async () => {
  if (!confirm('Delete all captured files in docs/design-references/?')) return;
  try {
    const res = await fetch(`${SERVER}/clear`, { method: 'POST' });
    if (res.ok) log('Cleared all captured files.', 'ok');
    else log('Clear failed.', 'err');
  } catch (e) {
    log(`Clear error: ${e.message}`, 'err');
  }
});

// ─── utilities ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout fallback
    setTimeout(resolve, 15000);
  });
}

// ─── init ─────────────────────────────────────────────────────────────────────
(async () => {
  const tab = await getCurrentTab();
  pageUrl.textContent = tab?.url || '—';
  await checkServer();

  // Re-check server every 5s
  setInterval(checkServer, 5000);
})();

#!/usr/bin/env node
/**
 * auth-scrape.mjs
 *
 * Interactive authenticated website scraper.
 * Handles email/password login + email OTP (6-digit code) flows.
 * Saves session cookies so you can re-use the session without logging in again.
 * After login, auto-crawls every page on the site OR screenshots specific pages.
 *
 * Usage:
 *   node scripts/auth-scrape.mjs
 *   node scripts/auth-scrape.mjs --session    (skip login, reuse saved session)
 *   node scripts/auth-scrape.mjs --crawl      (auto-crawl mode, no prompts for URLs)
 *
 * Output:
 *   docs/design-references/     screenshots + HTML of every page
 *   public/images/              downloaded images
 *   scripts/session.json        saved cookies (reuse to skip login next time)
 */

import { chromium } from 'playwright';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SESSION_FILE = path.join(__dirname, 'session.json');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'design-references');
const IMAGES_DIR = path.join(ROOT, 'public', 'images');

// ─── helpers ────────────────────────────────────────────────────────────────

function banner(msg) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + msg);
  console.log('─'.repeat(60));
}

async function ask(rl, question) {
  return (await rl.question(question)).trim();
}

async function askSecret(rl, question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const handler = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit();
      } else if (ch === '\u007f') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        value += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', handler);
  });
}

async function ensureDirs() {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
}

function slugify(url) {
  return url
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ─── session ─────────────────────────────────────────────────────────────────

async function saveSession(context) {
  const storage = await context.storageState();
  await fs.writeFile(SESSION_FILE, JSON.stringify(storage, null, 2));
  console.log(`\n  ✓ Session saved to ${SESSION_FILE}`);
}

async function loadSession() {
  try {
    return JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ─── crawler ─────────────────────────────────────────────────────────────────

/**
 * Discover all internal links reachable from startUrl on the same origin.
 * Returns an array of absolute URLs, deduped and sorted.
 */
async function crawlAllPages(page, startUrl, maxPages = 200) {
  const origin = new URL(startUrl).origin;
  const visited = new Set();
  const queue = [startUrl];
  const found = [];

  banner(`Auto-Crawling ${origin}`);
  console.log(`  Max pages: ${maxPages}. Press Ctrl+C to stop early.\n`);

  while (queue.length > 0 && found.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      process.stdout.write(`  [${found.length + 1}] ${url}\n`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      found.push(url);

      // Collect all <a href> links on this page
      const links = await page.$$eval('a[href]', (anchors) =>
        anchors.map((a) => a.href).filter(Boolean)
      );

      for (const link of links) {
        try {
          const parsed = new URL(link);
          // Same origin only, no anchors, no mailto/tel, not already seen
          if (
            parsed.origin === origin &&
            !parsed.hash &&
            parsed.protocol.startsWith('http') &&
            !visited.has(parsed.href) &&
            !queue.includes(parsed.href)
          ) {
            queue.push(parsed.href);
          }
        } catch {
          // ignore invalid URLs
        }
      }
    } catch (err) {
      console.log(`  ! Failed: ${url} — ${err.message}`);
    }
  }

  if (found.length >= maxPages) {
    console.log(`\n  Reached max page limit (${maxPages}). Use --max N to increase.`);
  }

  console.log(`\n  ✓ Found ${found.length} pages.`);
  return found;
}

// ─── OTP detection ───────────────────────────────────────────────────────────

async function isOTPPage(page) {
  const url = page.url();
  const text = (await page.innerText('body').catch(() => '')).toLowerCase();

  const urlHints = ['otp', 'verify', 'verification', 'code', 'token', 'magic', 'check'];
  const textHints = [
    'check your email',
    'verification code',
    '6-digit',
    'login code',
    'sent a code',
    'sent you a code',
    'enter the code',
    'enter code',
    'one-time',
  ];

  if (urlHints.some((h) => url.includes(h))) return true;
  if (textHints.some((h) => text.includes(h))) return true;

  const singleInputs = await page.$$('input[maxlength="1"]');
  if (singleInputs.length >= 4) return true;

  const codeInput = await page.$('input[maxlength="6"]');
  if (codeInput) return true;

  return false;
}

// ─── OTP entry ───────────────────────────────────────────────────────────────

async function enterOTP(page, rl, code) {
  const singleInputs = await page.$$('input[maxlength="1"]');
  if (singleInputs.length >= 6) {
    const digits = code.replace(/\D/g, '').split('');
    for (let i = 0; i < Math.min(singleInputs.length, digits.length); i++) {
      await singleInputs[i].click();
      await singleInputs[i].fill(digits[i]);
      await page.waitForTimeout(50);
    }
    return;
  }

  const selectors = [
    'input[maxlength="6"]',
    'input[name*="code"]',
    'input[name*="otp"]',
    'input[name*="token"]',
    'input[placeholder*="code" i]',
    'input[placeholder*="digit" i]',
    'input[autocomplete="one-time-code"]',
    'input[type="number"]',
  ];

  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(code.replace(/\D/g, ''));
      return;
    }
  }

  const sel = await ask(rl, '\n  Could not find OTP input. Enter CSS selector: ');
  const el = await page.$(sel);
  if (el) await el.fill(code.replace(/\D/g, ''));
  else throw new Error(`No element found for: ${sel}`);
}

// ─── submit ───────────────────────────────────────────────────────────────────

async function submitForm(page) {
  const candidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Confirm")',
  ];

  for (const sel of candidates) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click();
      return sel;
    }
  }

  await page.keyboard.press('Enter');
  return 'Enter key';
}

// ─── page scraper ────────────────────────────────────────────────────────────

async function scrapePage(page, targetUrl, label) {
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);

  const slug = label || slugify(targetUrl);

  // Desktop
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopPath = path.join(SCREENSHOTS_DIR, `${slug}-desktop.png`);
  await page.screenshot({ path: desktopPath, fullPage: true });

  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePath = path.join(SCREENSHOTS_DIR, `${slug}-mobile.png`);
  await page.screenshot({ path: mobilePath, fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });

  // HTML
  const htmlPath = path.join(SCREENSHOTS_DIR, `${slug}.html`);
  await fs.writeFile(htmlPath, await page.content());

  console.log(`  ✓ ${slug}`);
  return { desktopPath, mobilePath, htmlPath };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const reuseSession = args.includes('--session') || args.includes('-s');
  const forceCrawl = args.includes('--crawl');
  const maxIdx = args.indexOf('--max');
  const maxPages = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) || 200 : 200;

  await ensureDirs();

  const rl = readline.createInterface({ input, output, terminal: true });

  banner('Authenticated Website Scraper');
  console.log('  Logs in, handles email OTP, then scrapes every page.');

  // ── Target URL ──────────────────────────────────────────────────────────
  const targetUrl = await ask(rl, '\n  Target website URL (e.g. https://app.example.com): ');
  if (!targetUrl.startsWith('http')) {
    console.error('  Error: URL must start with http:// or https://');
    process.exit(1);
  }
  const origin = new URL(targetUrl).origin;

  // ── Scrape mode ─────────────────────────────────────────────────────────
  let scrapeMode = 'crawl'; // 'crawl' | 'list' | 'landing'
  const manualUrls = [];

  if (!forceCrawl) {
    console.log('\n  How do you want to scrape after login?');
    console.log('  1) Auto-crawl entire site (every page, recommended)');
    console.log('  2) Enter specific URLs manually');
    console.log('  3) Just the landing page after login');
    const choice = await ask(rl, '  Choice [1]: ');

    if (choice === '2') {
      scrapeMode = 'list';
      console.log('\n  Enter URLs one per line. Press Enter twice when done.');
      while (true) {
        const line = await ask(rl, '  URL: ');
        if (!line) break;
        manualUrls.push(line);
      }
    } else if (choice === '3') {
      scrapeMode = 'landing';
    }
    // default (Enter or '1') = crawl
  }

  // ── Launch browser ──────────────────────────────────────────────────────
  banner('Launching browser...');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });

  let context;
  if (reuseSession) {
    const saved = await loadSession();
    if (saved) {
      console.log(`  Loading saved session from ${SESSION_FILE}`);
      context = await browser.newContext({ storageState: saved });
    } else {
      console.log('  No saved session found — logging in fresh.');
      context = await browser.newContext();
    }
  } else {
    context = await browser.newContext();
  }

  const page = await context.newPage();

  // ── Navigate ────────────────────────────────────────────────────────────
  console.log(`\n  Opening ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── Login ───────────────────────────────────────────────────────────────
  if (!reuseSession) {
    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    const currentUrl = page.url();
    const looksLikeLogin =
      bodyText.includes('log in') ||
      bodyText.includes('login') ||
      bodyText.includes('sign in') ||
      currentUrl.includes('login') ||
      currentUrl.includes('signin');

    if (!looksLikeLogin) {
      const loginUrl = await ask(
        rl,
        '  Page does not look like a login form. Enter login URL (or Enter to try anyway): '
      );
      if (loginUrl) {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);
      }
    }

    banner('Login');
    const email = await ask(rl, '  Email / Username: ');

    // Fill email
    const emailSelectors = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[placeholder*="email" i]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
    ];
    let filled = false;
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) { await el.fill(email); filled = true; break; }
    }
    if (!filled) {
      const sel = await ask(rl, '  Could not find email field. Enter CSS selector: ');
      await page.fill(sel, email);
    }

    // Check if a password field exists — many sites are email-only (magic link / OTP)
    const passwordSelectors = [
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[placeholder*="password" i]',
      'input[autocomplete="current-password"]',
    ];
    let passwordFieldExists = false;
    for (const sel of passwordSelectors) {
      if (await page.$(sel)) { passwordFieldExists = true; break; }
    }

    let pwFilled = false;
    if (passwordFieldExists) {
      const password = await askSecret(rl, '  Password: ');
      for (const sel of passwordSelectors) {
        const el = await page.$(sel);
        if (el) { await el.fill(password); pwFilled = true; break; }
      }
    } else {
      // Submit email and check if password field appears on next step
      console.log('  No password field detected — submitting email only.');
      await submitForm(page);
      await page.waitForTimeout(2000);

      // If step-2 reveals a password field, ask for it then
      for (const sel of passwordSelectors) {
        const el = await page.$(sel);
        if (el) {
          const password = await askSecret(rl, '  Password: ');
          await el.fill(password);
          pwFilled = true;
          break;
        }
      }
      // If no password appeared either, OTP handler takes over
    }

    // Only do a final submit if we filled a password (email-only flow already submitted above)
    if (pwFilled) {
      console.log('  Submitting...');
      await submitForm(page);
      await page.waitForTimeout(3000);
    }
  }

  // ── OTP ─────────────────────────────────────────────────────────────────
  let otpAttempts = 0;
  while (await isOTPPage(page) && otpAttempts < 3) {
    otpAttempts++;
    banner('Email Verification Required');
    console.log(`  Page: ${page.url()}`);

    const pageText = await page.innerText('body').catch(() => '');
    const emailMatch = pageText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) console.log(`  Code sent to: ${emailMatch[0]}`);

    const code = await ask(rl, '\n  Check your email — enter the code here: ');
    await enterOTP(page, rl, code.trim());
    await page.waitForTimeout(500);
    await submitForm(page);
    await page.waitForTimeout(3000);

    if (!(await isOTPPage(page))) {
      console.log('\n  ✓ OTP accepted — logged in!');
      break;
    }
  }

  // ── Verify login ─────────────────────────────────────────────────────────
  const finalUrl = page.url();
  banner('Login Status');
  console.log(`  Current URL: ${finalUrl}`);
  const stillOnLogin =
    finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('otp');
  if (stillOnLogin) {
    const proceed = await ask(rl, '  Still on login page. Continue anyway? (y/n): ');
    if (proceed.toLowerCase() !== 'y') {
      await browser.close();
      rl.close();
      process.exit(1);
    }
  } else {
    console.log('  ✓ Authenticated!');
  }

  await saveSession(context);

  // ── Determine pages to scrape ────────────────────────────────────────────
  let pagesToScrape = [];

  if (scrapeMode === 'crawl') {
    pagesToScrape = await crawlAllPages(page, finalUrl, maxPages);
  } else if (scrapeMode === 'list') {
    pagesToScrape = manualUrls.length > 0 ? manualUrls : [finalUrl];
  } else {
    pagesToScrape = [finalUrl];
  }

  // ── Screenshot all pages ─────────────────────────────────────────────────
  banner(`Screenshotting ${pagesToScrape.length} page(s)`);
  console.log(`  Saving to: ${SCREENSHOTS_DIR}\n`);

  // Write an index file so Claude knows what was scraped
  const indexLines = [`# Scraped Pages — ${origin}`, `Date: ${new Date().toISOString()}`, ''];

  for (let i = 0; i < pagesToScrape.length; i++) {
    const url = pagesToScrape[i];
    const label = `p${String(i + 1).padStart(3, '0')}-${slugify(url)}`;
    try {
      process.stdout.write(`  [${i + 1}/${pagesToScrape.length}] `);
      const result = await scrapePage(page, url, label);
      indexLines.push(`## ${url}`);
      indexLines.push(`- Desktop: ${path.basename(result.desktopPath)}`);
      indexLines.push(`- Mobile:  ${path.basename(result.mobilePath)}`);
      indexLines.push(`- HTML:    ${path.basename(result.htmlPath)}`);
      indexLines.push('');
    } catch (err) {
      console.log(`  ! Error on ${url}: ${err.message}`);
      indexLines.push(`## ${url}`);
      indexLines.push(`- ERROR: ${err.message}`);
      indexLines.push('');
    }
  }

  // Save index
  const indexPath = path.join(SCREENSHOTS_DIR, 'SCRAPE_INDEX.md');
  await fs.writeFile(indexPath, indexLines.join('\n'));
  console.log(`\n  ✓ Index saved: ${indexPath}`);

  // ── Interactive mode ─────────────────────────────────────────────────────
  banner('Interactive Mode');
  console.log('  Commands:');
  console.log('    scrape <url>   — screenshot a specific URL');
  console.log('    current        — screenshot current page');
  console.log('    crawl          — crawl more pages from current URL');
  console.log('    save           — save session cookies');
  console.log('    quit           — exit\n');

  while (true) {
    const cmd = await ask(rl, '  > ');
    if (!cmd || cmd === 'quit' || cmd === 'exit' || cmd === 'q') break;
    else if (cmd === 'current') {
      const u = page.url();
      await scrapePage(page, u, `manual-${slugify(u)}`);
    } else if (cmd === 'save') {
      await saveSession(context);
    } else if (cmd === 'crawl') {
      const more = await crawlAllPages(page, page.url(), maxPages);
      for (let i = 0; i < more.length; i++) {
        const label = `crawl-${String(i + 1).padStart(3, '0')}-${slugify(more[i])}`;
        await scrapePage(page, more[i], label).catch((e) => console.log(`  ! ${e.message}`));
      }
    } else if (cmd.startsWith('scrape ')) {
      const u = cmd.slice(7).trim();
      await scrapePage(page, u, `manual-${slugify(u)}`);
    } else {
      console.log('  Unknown command.');
    }
  }

  banner('Done');
  console.log(`  ${pagesToScrape.length} pages scraped.`);
  console.log(`  Screenshots: ${SCREENSHOTS_DIR}`);
  console.log(`  Session:     ${SESSION_FILE}`);
  console.log('\n  Next: open Claude Code and run /clone-website\n');

  await browser.close();
  rl.close();
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * auth-scrape.mjs
 *
 * Interactive authenticated website scraper.
 * Handles email/password login + email OTP (6-digit code) flows.
 * Saves session cookies so you can re-use the session without logging in again.
 * After login, screenshots every page you provide and dumps assets for cloning.
 *
 * Usage:
 *   node scripts/auth-scrape.mjs
 *   node scripts/auth-scrape.mjs --session saved-session.json   (skip login, reuse session)
 *
 * Output:
 *   docs/design-references/     screenshots of authenticated pages
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

// Where to save/load the session
const SESSION_FILE = path.join(__dirname, 'session.json');

// Directories for output
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
  // readline doesn't hide input natively; we just label it clearly
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
  return url.replace(/https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

// ─── session management ──────────────────────────────────────────────────────

async function saveSession(context) {
  const cookies = await context.cookies();
  const storage = await context.storageState();
  await fs.writeFile(SESSION_FILE, JSON.stringify({ cookies, storage }, null, 2));
  console.log(`\n✓ Session saved to ${SESSION_FILE}`);
  console.log('  Re-run with --session to skip login next time.');
}

async function loadSession() {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── OTP detection ───────────────────────────────────────────────────────────

/**
 * Heuristic: are we on an OTP / email-verification page?
 * Looks for 6-digit input boxes, "check your email" text, or verification code labels.
 */
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

  // Look for 6 single-character inputs (classic OTP box pattern)
  const singleInputs = await page.$$('input[maxlength="1"]');
  if (singleInputs.length >= 4) return true;

  // Look for one input with maxlength="6"
  const codeInput = await page.$('input[maxlength="6"]');
  if (codeInput) return true;

  return false;
}

// ─── OTP entry ───────────────────────────────────────────────────────────────

async function enterOTP(page, rl, code) {
  // Try 6 separate single-character boxes first
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

  // Try a single input[maxlength="6"] or input[type="text/number"]
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
      console.log(`  Entered OTP into: ${sel}`);
      return;
    }
  }

  // Fallback: ask the user to identify the selector
  const sel = await ask(rl, '\n  Could not find OTP input automatically.\n  Enter a CSS selector for the OTP input field: ');
  const el = await page.$(sel);
  if (el) {
    await el.fill(code.replace(/\D/g, ''));
  } else {
    throw new Error(`No element found for selector: ${sel}`);
  }
}

// ─── submit form ─────────────────────────────────────────────────────────────

async function submitForm(page) {
  // Try common submit selectors
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

  // Try pressing Enter
  await page.keyboard.press('Enter');
  return 'Enter key';
}

// ─── page scraper ────────────────────────────────────────────────────────────

async function scrapePage(page, targetUrl, label) {
  console.log(`\n  Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);

  const slug = label || slugify(targetUrl);
  const screenshotPath = path.join(SCREENSHOTS_DIR, `${slug}-desktop.png`);
  const mobilePath = path.join(SCREENSHOTS_DIR, `${slug}-mobile.png`);

  // Desktop screenshot
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`  ✓ Desktop screenshot: ${screenshotPath}`);

  // Mobile screenshot
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: mobilePath, fullPage: true });
  console.log(`  ✓ Mobile screenshot:  ${mobilePath}`);

  // Reset viewport
  await page.setViewportSize({ width: 1440, height: 900 });

  // Save page HTML
  const htmlPath = path.join(SCREENSHOTS_DIR, `${slug}.html`);
  const html = await page.content();
  await fs.writeFile(htmlPath, html);
  console.log(`  ✓ HTML saved:         ${htmlPath}`);

  return { screenshotPath, mobilePath, htmlPath };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const reuseSession = args.includes('--session') || args.includes('-s');

  await ensureDirs();

  const rl = readline.createInterface({ input, output, terminal: true });

  banner('Authenticated Website Scraper');
  console.log('  Clones websites that require login + email OTP.');
  console.log('  Screenshots and HTML are saved for the /clone-website workflow.');

  // ── Step 1: Target URL ──────────────────────────────────────────────────
  const targetUrl = await ask(rl, '\n  Target website URL (e.g. https://app.example.com): ');
  if (!targetUrl.startsWith('http')) {
    console.error('  Error: URL must start with http:// or https://');
    process.exit(1);
  }

  // ── Step 2: Pages to scrape (asked upfront) ─────────────────────────────
  console.log('\n  Which pages do you want to scrape after login?');
  console.log('  Enter one URL per line. Press Enter twice when done.');
  console.log('  (Leave blank and press Enter twice to just scrape the landing page after login.)');

  const pagesToScrape = [];
  while (true) {
    const line = await ask(rl, '  URL: ');
    if (!line) break;
    pagesToScrape.push(line);
  }

  // ── Step 3: Launch browser ──────────────────────────────────────────────
  banner('Launching browser...');

  // Use the system-installed chromium if the local one isn't downloaded yet
  const SYSTEM_CHROMIUM = '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';
  let launchOpts = { headless: false, slowMo: 50 };
  try {
    await fs.access(SYSTEM_CHROMIUM);
    launchOpts.executablePath = SYSTEM_CHROMIUM;
    console.log('  Using system Chromium.');
  } catch {
    console.log('  Using Playwright default Chromium.');
  }

  const browser = await chromium.launch(launchOpts);

  let context;
  let sessionLoaded = false;

  if (reuseSession) {
    const saved = await loadSession();
    if (saved) {
      console.log(`\n  Loading saved session from ${SESSION_FILE}`);
      context = await browser.newContext({ storageState: saved.storage });
      sessionLoaded = true;
    } else {
      console.log(`\n  No saved session found at ${SESSION_FILE}. Will log in fresh.`);
      context = await browser.newContext();
    }
  } else {
    context = await browser.newContext();
  }

  const page = await context.newPage();

  // ── Step 4: Navigate to site ────────────────────────────────────────────
  console.log(`\n  Opening ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── Step 5: Login (skip if session loaded and already authenticated) ─────
  if (!sessionLoaded) {
    // Check if we're already on a login page or need to navigate there
    const currentUrl = page.url();
    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    const looksLikeLogin =
      bodyText.includes('log in') ||
      bodyText.includes('login') ||
      bodyText.includes('sign in') ||
      bodyText.includes('email') ||
      currentUrl.includes('login') ||
      currentUrl.includes('signin');

    if (!looksLikeLogin) {
      console.log('\n  The page does not appear to have a login form.');
      const loginUrl = await ask(rl, '  Enter the login page URL (or press Enter to try the current page): ');
      if (loginUrl) {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);
      }
    }

    banner('Login');

    const email = await ask(rl, '  Email / Username: ');
    const password = await askSecret(rl, '  Password: ');

    // Fill email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[placeholder*="email" i]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
    ];

    let emailFilled = false;
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(email);
        console.log(`\n  ✓ Filled email into: ${sel}`);
        emailFilled = true;
        break;
      }
    }

    if (!emailFilled) {
      const sel = await ask(rl, '  Could not find email field. Enter CSS selector: ');
      await page.fill(sel, email);
    }

    // Fill password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[placeholder*="password" i]',
      'input[autocomplete="current-password"]',
    ];

    let passwordFilled = false;
    for (const sel of passwordSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.fill(password);
        console.log(`  ✓ Filled password into: ${sel}`);
        passwordFilled = true;
        break;
      }
    }

    if (!passwordFilled) {
      // Some sites show password on step 2 — wait a moment and check
      const continueBtn = await page.$('button[type="submit"], button:has-text("Continue")');
      if (continueBtn) {
        console.log('  Clicking Continue to reveal password field...');
        await continueBtn.click();
        await page.waitForTimeout(1500);

        for (const sel of passwordSelectors) {
          const el = await page.$(sel);
          if (el) {
            await el.fill(password);
            console.log(`  ✓ Filled password into: ${sel}`);
            passwordFilled = true;
            break;
          }
        }
      }
    }

    if (!passwordFilled) {
      const sel = await ask(rl, '  Could not find password field. Enter CSS selector (or press Enter to skip): ');
      if (sel) await page.fill(sel, password);
    }

    // Submit login
    console.log('  Submitting login form...');
    const submitResult = await submitForm(page);
    console.log(`  Clicked: ${submitResult}`);

    // Wait for navigation
    await page.waitForTimeout(2500);
  }

  // ── Step 6: Handle OTP if needed ────────────────────────────────────────
  let otpHandled = false;
  let otpAttempts = 0;

  while (await isOTPPage(page) && otpAttempts < 3) {
    otpAttempts++;
    banner('Email Verification Required');
    console.log(`  Page: ${page.url()}`);

    // Show the email address mentioned on the page if detectable
    const pageText = await page.innerText('body').catch(() => '');
    const emailMatch = pageText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      console.log(`  Code was sent to: ${emailMatch[0]}`);
    }

    console.log('\n  Check your email and enter the 6-digit code below.');
    const code = await ask(rl, '  OTP Code: ');

    if (!/^\d{4,8}$/.test(code.trim())) {
      console.log('  Warning: Code should be 4-8 digits. Proceeding anyway...');
    }

    await enterOTP(page, rl, code.trim());
    await page.waitForTimeout(500);

    // Submit OTP
    const submitResult = await submitForm(page);
    console.log(`\n  Submitted OTP (${submitResult}). Waiting for navigation...`);
    await page.waitForTimeout(3000);

    if (!(await isOTPPage(page))) {
      otpHandled = true;
      console.log('\n  ✓ OTP accepted! Logged in successfully.');
      break;
    } else {
      console.log('\n  OTP page still showing. Let\'s try again.');
    }
  }

  // ── Step 7: Verify login ─────────────────────────────────────────────────
  banner('Login Status');
  const finalUrl = page.url();
  console.log(`  Current URL: ${finalUrl}`);

  const stillOnLogin = finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('otp');
  if (stillOnLogin) {
    console.log('\n  Warning: Still appears to be on login/OTP page.');
    const proceed = await ask(rl, '  Continue anyway? (y/n): ');
    if (proceed.toLowerCase() !== 'y') {
      await browser.close();
      rl.close();
      process.exit(1);
    }
  } else {
    console.log('  ✓ Successfully authenticated!');
  }

  // Save session for re-use
  await saveSession(context);

  // ── Step 8: Scrape pages ─────────────────────────────────────────────────
  banner('Scraping Authenticated Pages');

  const pagesToScrapeList =
    pagesToScrape.length > 0
      ? pagesToScrape
      : [finalUrl];

  // Also always screenshot the current landing page after login
  if (!pagesToScrapeList.includes(finalUrl) && pagesToScrapeList.length === 0) {
    pagesToScrapeList.unshift(finalUrl);
  }

  console.log(`\n  Scraping ${pagesToScrapeList.length} page(s)...\n`);

  for (let i = 0; i < pagesToScrapeList.length; i++) {
    const url = pagesToScrapeList[i];
    const label = `page-${i + 1}-${slugify(url)}`.slice(0, 80);
    try {
      await scrapePage(page, url, label);
    } catch (err) {
      console.error(`  Error scraping ${url}: ${err.message}`);
    }
  }

  // Also screenshot whatever is currently visible (the post-login landing page)
  if (pagesToScrapeList.length === 0 || !pagesToScrapeList.includes(finalUrl)) {
    const label = `post-login-${slugify(finalUrl)}`.slice(0, 80);
    await scrapePage(page, finalUrl, label);
  }

  // ── Step 9: Interactive mode ─────────────────────────────────────────────
  banner('Interactive Mode');
  console.log('  You can now navigate the authenticated site and take more screenshots.');
  console.log('  Commands:');
  console.log('    scrape <url>   — screenshot a URL');
  console.log('    current        — screenshot the current page');
  console.log('    save           — save session cookies');
  console.log('    quit           — exit\n');

  while (true) {
    const cmd = await ask(rl, '  > ');
    if (!cmd || cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
      break;
    } else if (cmd === 'current') {
      const cu = page.url();
      await scrapePage(page, cu, `manual-${slugify(cu)}`.slice(0, 80));
    } else if (cmd === 'save') {
      await saveSession(context);
    } else if (cmd.startsWith('scrape ')) {
      const u = cmd.slice(7).trim();
      await scrapePage(page, u, `manual-${slugify(u)}`.slice(0, 80));
    } else {
      console.log('  Unknown command. Type "quit" to exit.');
    }
  }

  banner('Done');
  console.log(`  Screenshots saved to: ${SCREENSHOTS_DIR}`);
  console.log(`  Session saved to:     ${SESSION_FILE}`);
  console.log('\n  Next step: run /clone-website with the screenshots as reference.\n');

  await browser.close();
  rl.close();
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

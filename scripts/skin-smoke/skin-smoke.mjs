#!/usr/bin/env node
/**
 * Smoke test for the Gmail skin, run against a live instance.
 *
 * The integration suite (integration/) needs Docker for its Stalwart stack;
 * this one only needs a running webmail and one mailbox with some mail in it:
 *
 *   SKIN_URL=http://127.0.0.1:3000 SKIN_USER=me@example.com SKIN_PASS=... \
 *     node scripts/skin-smoke/skin-smoke.mjs
 *
 * SKIN_SERVER optionally picks the login form's server entry by id. The
 * password is read from the environment only and never printed. It checks
 * the skin's own structure - not the mail in the box - on a desktop and a
 * phone viewport, and exits non-zero on the first failed check.
 */
/* global document */
import { chromium } from 'playwright';

const url = (process.env.SKIN_URL || '').replace(/\/+$/, '');
const user = process.env.SKIN_USER;
const pass = process.env.SKIN_PASS;
if (!url || !user || !pass) {
  console.error('Set SKIN_URL, SKIN_USER and SKIN_PASS.');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

async function signIn(context) {
  // The skin is a device setting: set it before the app reads its storage.
  await context.addInitScript(() => {
    if (!localStorage.getItem('settings-storage')) {
      localStorage.setItem('settings-storage', JSON.stringify({ state: { uiSkin: 'gmail' }, version: 0 }));
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}/en/login`, { waitUntil: 'networkidle' });
  if (process.env.SKIN_SERVER && await page.locator('#jmap-server-select').count()) {
    await page.selectOption('#jmap-server-select', process.env.SKIN_SERVER);
  }
  await page.fill('input[type=email], input[name=username], #username', user);
  await page.fill('input[type=password]', pass);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/mail/, { timeout: 60_000 });
  await page.locator('[data-email-id]').first().waitFor({ timeout: 60_000 });
  return { page, errors };
}

async function desktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await signIn(context);

  check('desktop: skin is applied', await page.evaluate(() => document.documentElement.dataset.skin === 'gmail'));
  check('desktop: Starred sits right under the Inbox', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-folder-name], [data-folder-role]')]
      .map((r) => r.getAttribute('data-folder-name') || r.getAttribute('data-folder-role'));
    const inbox = rows.indexOf('inbox') >= 0 ? rows.indexOf('inbox') : rows.findIndex((r) => /inbox/i.test(r || ''));
    return inbox >= 0 && rows[inbox + 1] === 'skin-starred';
  }));
  const range = await page.getByText(/^\s*1–\d/).first().textContent().catch(() => null);
  check('desktop: list toolbar shows a 1–N range', !!range && /1–\d/.test(range), range?.trim() ?? '');
  check('desktop: search options button sits inside the field', await page.evaluate(() => {
    const field = document.querySelector('.gm-topbar input[data-search-input]');
    const btn = document.querySelector('.gm-topbar-search > button');
    if (!field || !btn) return false;
    const f = field.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return b.left >= f.left && b.right <= f.right + 1;
  }));

  await page.locator('[data-email-id]').first().click();
  await page.locator('[data-skin-sender-date]').first().waitFor({ timeout: 30_000 }).catch(() => {});
  check('desktop: message date sits on the sender line', await page.locator('[data-skin-sender-date]').count() > 0);
  await page.locator('[data-skin-reply-row]').waitFor({ timeout: 30_000 }).catch(() => {});
  check('desktop: Reply / Reply all / Forward under the message', await page.locator('[data-skin-reply-row] button').count() === 3);
  await page.keyboard.press('Escape');

  await page.locator('[data-skin-compose]').first().click();
  const win = page.locator('[data-skin-compose-window]');
  await win.waitFor({ timeout: 20_000 }).catch(() => {});
  check('desktop: compose opens a docked window', await win.count() === 1);
  if (await win.count()) {
    const box = await win.boundingBox();
    check('desktop: compose window is docked bottom-right', !!box && box.x > 600 && box.y + box.height >= 899 - 2);
    await win.locator('button[aria-label]').first().click();
    await page.waitForTimeout(400);
    check('desktop: compose window folds to its title bar', (await win.getAttribute('data-state')) === 'minimized');
  }
  check('desktop: no page errors', errors.length === 0, errors[0] ?? '');
  await context.close();
}

async function phone(browser) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
  });
  const { page, errors } = await signIn(context);
  check('phone: rows are Gmail mobile rows', await page.locator('[data-gmail-mobile-row]').count() > 0);
  check('phone: one star per row, on the preview line', await page.evaluate(() => {
    const row = document.querySelector('[data-gmail-mobile-row]');
    if (!row) return false;
    const stars = row.querySelectorAll('button[aria-pressed]');
    return stars.length === 1 && !!stars[0].parentElement?.querySelector('p');
  }));
  check('phone: no page errors', errors.length === 0, errors[0] ?? '');
  await context.close();
}

const browser = await chromium.launch();
try {
  await desktop(browser);
  await phone(browser);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

'use strict';

/**
 * Мониторинг доступности абонемента 24h в паркинге InterParking (Торрент).
 *
 * Логинится в личный кабинет P-web, открывает страницу абонементов и определяет,
 * доступен ли для оформления абонемент 24h в паркинге Торрент. При появлении
 * доступности (переход «недоступен -> доступен») шлёт письмо на email.
 *
 * Конфигурация через переменные окружения (см. README.md):
 *   IPK_USER, IPK_PASS                  — учётка InterParking
 *   SMTP_HOST, SMTP_PORT, SMTP_USER,
 *   SMTP_PASS, EMAIL_TO, EMAIL_FROM     — отправка email
 *   STATE_FILE                          — путь к файлу состояния (по умолчанию state.json)
 *   HEADLESS                            — "false" чтобы видеть браузер (локальная отладка)
 *   PARKING_MATCH                       — подстрока названия паркинга (по умолч. "torrent")
 *   ABONO_MATCH                         — подстрока продукта (по умолч. "24")
 *
 * Коды выхода: 0 — проверка прошла; 2 — ошибка (логин/навигация).
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { chromium } = require('playwright');

const BASE = 'https://p-web.interparking.es';
const LOGIN_URL = `${BASE}/login`;
const ABONO_URL = `${BASE}/Contracts/AbonoList`;

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PARKING_MATCH = (process.env.PARKING_MATCH || 'torrent').toLowerCase();
const ABONO_MATCH = (process.env.ABONO_MATCH || '24').toLowerCase();
const HEADLESS = process.env.HEADLESS !== 'false';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Не задана переменная окружения ${name}`);
    process.exit(2);
  }
  return v;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { available: false, lastNotifiedAt: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function dismissCookieBanner(page) {
  // Лучшая попытка закрыть баннер согласия cookie (не критично, если его нет).
  const btn = page
    .locator('button:has-text("Aceptar"), button:has-text("Acepto"), button:has-text("Accept"), #onetrust-accept-btn-handler, button:has-text("De acuerdo")')
    .first();
  if (await btn.count().catch(() => 0)) {
    await btn.click({ timeout: 3000 }).catch(() => {});
  }
}

async function detectCaptcha(page) {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML.toLowerCase();
    return (
      html.includes('recaptcha') ||
      html.includes('hcaptcha') ||
      html.includes('turnstile') ||
      html.includes('cf-challenge')
    );
  });
}

async function dumpDiagnostics(page, tag) {
  // Печатает структуру текущей страницы в лог — для подбора селекторов в Actions.
  try {
    log(`=== ДИАГНОСТИКА (${tag}) ===`);
    log('URL:', page.url());
    log('Title:', await page.title());

    const inputs = await page.$$eval('input', (els) =>
      els.map((e) => ({
        type: e.type, name: e.name, id: e.id,
        ph: e.placeholder, ac: e.autocomplete,
        visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
      }))
    );
    log('INPUTS:', JSON.stringify(inputs));

    const buttons = await page.$$eval('button, input[type=submit], a[role=button]', (els) =>
      els.map((e) => (e.innerText || e.value || '').trim().slice(0, 40)).filter(Boolean)
    );
    log('BUTTONS:', JSON.stringify(buttons));

    const frames = page.frames().map((f) => f.url());
    log('FRAMES:', JSON.stringify(frames));

    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800);
    log('BODY:', body);
    log('=== /ДИАГНОСТИКА ===');
  } catch (e) {
    log('Не удалось собрать диагностику:', e.message);
  }
}

async function login(page) {
  log('Открываю страницу входа…');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 45000 });
  await dismissCookieBanner(page);
  await page.waitForTimeout(2500); // дать SPA дорисовать форму

  if (await detectCaptcha(page)) {
    log('ВНИМАНИЕ: на странице входа обнаружена captcha — автоматический вход может не пройти.');
  }

  // Форма входа P-web: поля id="Login" (E-mail) и id="Password".
  // На странице есть дублирующиеся (скрытые) копии полей для адаптивной вёрстки,
  // поэтому берём именно ВИДИМОЕ поле.
  const email = page.locator('input#Login:visible, input[name="Login"]:visible').first();
  const pass = page.locator('input#Password:visible, input[name="Password"]:visible').first();

  if (!(await email.count().catch(() => 0)) ||
      !(await email.isVisible().catch(() => false))) {
    await dumpDiagnostics(page, 'login');
    throw new Error('Поле логина (#Login) не найдено — разметка входа изменилась (см. диагностику выше).');
  }

  await email.fill(requireEnv('IPK_USER'));
  await pass.fill(requireEnv('IPK_PASS'));

  // Отправка формы: кнопка «Acceso» в той же форме; на всякий случай — submit формы.
  const submit = page.locator('form:has(input#Password) button:has-text("Acceso"), form:has(input#Password) button[type="submit"], button:has-text("Acceso")').first();
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    submit.click().catch(() => pass.press('Enter')),
  ]);

  // Проверяем, что ушли со страницы логина.
  await page.waitForTimeout(2000);
  if (page.url().toLowerCase().includes('/login')) {
    const visibleErr = await page
      .locator('text=/incorrect|inv[aá]lid|error|contrase/i')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`Вход не удался (остались на /login). ${visibleErr || ''}`.trim());
  }
  log('Вход выполнен.');
}

/**
 * Определяет доступность абонемента 24h в Торренте.
 *
 * ВАЖНО: финальная логика селекторов уточняется после пробного входа
 * (см. scripts/probe.js / README). Базовая стратегия — текстовый поиск
 * признаков паркинга и продукта на странице абонементов.
 *
 * @returns {Promise<{available: boolean, detail: string}>}
 */
async function checkAvailability(page) {
  log('Открываю страницу абонементов…');
  await page.goto(ABONO_URL, { waitUntil: 'networkidle' });
  await dismissCookieBanner(page);
  await page.waitForTimeout(1500);

  // Всегда сохраняем артефакты для отладки/уточнения селекторов в Actions.
  try {
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync('artifacts/abono.html', await page.content());
    await page.screenshot({ path: 'artifacts/abono.png', fullPage: true });
  } catch (e) {
    log('Не удалось сохранить артефакты:', e.message);
  }

  log('ABONO URL:', page.url());
  log('ABONO TITLE:', await page.title());

  // 1) Диагностика всех <select> — ищем фильтр паркинга с опцией «Torrent».
  const selectsInfo = await page.$$eval('select', (els) =>
    els.map((s) => ({
      id: s.id, name: s.name,
      options: Array.from(s.options).map((o) => o.textContent.trim()).slice(0, 200),
    }))
  ).catch(() => []);
  for (const s of selectsInfo) {
    const hasTorrent = s.options.some((t) => /torrent/i.test(t));
    log(`SELECT id="${s.id}" name="${s.name}" опций=${s.options.length} torrent=${hasTorrent}`);
    if (hasTorrent) {
      const opt = s.options.find((t) => /torrent/i.test(t));
      log('  опция Torrent:', JSON.stringify(opt));
    }
  }

  // 2) Пытаемся отфильтровать список по Торренту.
  let filtered = false;
  try {
    const torrentSelect = selectsInfo.find((s) =>
      s.options.some((t) => new RegExp(PARKING_MATCH, 'i').test(t)));
    if (torrentSelect) {
      const sel = torrentSelect.id ? `#${torrentSelect.id}`
        : `select[name="${torrentSelect.name}"]`;
      const label = torrentSelect.options.find((t) => new RegExp(PARKING_MATCH, 'i').test(t));
      await page.selectOption(sel, { label });
      const applyBtn = page.locator(
        'button:has-text("Aplicar"), input[type=submit][value*="plicar" i], a:has-text("Aplicar")'
      ).first();
      if (await applyBtn.count().catch(() => 0)) {
        await Promise.all([
          page.waitForLoadState('networkidle').catch(() => {}),
          applyBtn.click().catch(() => {}),
        ]);
      }
      await page.waitForTimeout(2000);
      filtered = true;
      log('Фильтр по Торренту применён.');
    } else {
      log('Не найден select с опцией Torrent — фильтрация пропущена.');
    }
  } catch (e) {
    log('Ошибка фильтрации по Торренту:', e.message);
  }

  // Сохраняем артефакт отфильтрованного вида.
  try {
    fs.writeFileSync('artifacts/abono-torrent.html', await page.content());
    await page.screenshot({ path: 'artifacts/abono-torrent.png', fullPage: true });
  } catch (e) { log('Не удалось сохранить артефакт фильтра:', e.message); }

  // 3) Дамп строк-продуктов отфильтрованного вида: текст + кнопки/ссылки.
  const rows = await page.$$eval(
    '.card, .panel, [class*="abono" i], [class*="product" i], tr, li',
    (els) => els
      .map((e) => ({
        t: (e.innerText || '').replace(/\s+/g, ' ').trim(),
        btns: Array.from(e.querySelectorAll('a,button,input[type=submit]'))
          .map((b) => (b.innerText || b.value || '').trim()).filter(Boolean),
      }))
      .filter((r) => r.t && /24|abono|agotado|contratar|comprar|disponib/i.test(r.t))
      .slice(0, 30)
  ).catch(() => []);
  log('TORRENT ROWS:', JSON.stringify(rows));

  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  log('ABONO BODY (2500):', bodyText.replace(/\s+/g, ' ').slice(0, 2500));

  // 4) Детекция (эвристика, привязанная к отфильтрованному виду Торрента).
  const mentionsParking = bodyText.includes(PARKING_MATCH);
  const mentionsAbono = bodyText.includes(ABONO_MATCH);
  const soldOutSignals = [
    'no hay', 'agotado', 'sin disponibilidad', 'no disponible',
    'lista de espera', 'completo', 'no existen', 'no se han encontrado',
  ];
  const looksSoldOut = soldOutSignals.some((s) => bodyText.includes(s));
  const available = filtered && mentionsParking && mentionsAbono && !looksSoldOut;

  const detail = `filtered=${filtered}, parking("${PARKING_MATCH}")=${mentionsParking}, ` +
    `abono("${ABONO_MATCH}")=${mentionsAbono}, soldOut=${looksSoldOut}`;
  log('Результат детекции:', detail);
  return { available, detail };
}

async function sendEmail(subjectAvailable, detail) {
  const transporter = nodemailer.createTransport({
    host: requireEnv('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: requireEnv('SMTP_USER'),
      pass: requireEnv('SMTP_PASS'),
    },
  });

  const to = requireEnv('EMAIL_TO');
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from,
    to,
    subject: subjectAvailable
      ? '✅ Абонемент 24h в Торренте ДОСТУПЕН — оформляй!'
      : 'ℹ️ Абонемент 24h в Торренте — статус проверки',
    text:
      `Проверка ${ABONO_URL}\n\n` +
      (subjectAvailable
        ? 'Похоже, абонемент 24h в паркинге Торрент стал доступен для оформления.\n'
        : 'Текущий статус ниже.\n') +
      `\nДетали детекции: ${detail}\n` +
      `Время: ${new Date().toISOString()}\n`,
  });
  log('Email отправлен на', to);
}

(async () => {
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({
    locale: 'es-ES',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await login(page);
    const { available, detail } = await checkAvailability(page);

    const prev = readState();
    log('Прошлое состояние:', JSON.stringify(prev));

    // Письмо только при переходе «недоступен -> доступен».
    if (available && !prev.available) {
      await sendEmail(true, detail);
      writeState({ available: true, lastNotifiedAt: new Date().toISOString() });
    } else {
      writeState({ ...prev, available });
    }

    log(`Готово. Доступен=${available}`);
  } catch (err) {
    console.error('Ошибка проверки:', err.message);
    await page.screenshot({ path: 'artifacts/error.png', fullPage: true }).catch(() => {});
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();

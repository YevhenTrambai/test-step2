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

async function login(page) {
  log('Открываю страницу входа…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await dismissCookieBanner(page);

  if (await detectCaptcha(page)) {
    log('ВНИМАНИЕ: на странице входа обнаружена captcha — автоматический вход может не пройти.');
  }

  // Поля логина. Селекторы устойчивые: ищем по типу/имени/placeholder.
  const email = page
    .locator('input[type="email"], input[name*="mail" i], input[name*="user" i], input[id*="user" i]')
    .first();
  const pass = page
    .locator('input[type="password"], input[name*="pass" i], input[id*="pass" i]')
    .first();

  await email.waitFor({ state: 'visible', timeout: 30000 });
  await email.fill(requireEnv('IPK_USER'));
  await pass.fill(requireEnv('IPK_PASS'));

  // Кнопка отправки формы.
  const submit = page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Iniciar"), button:has-text("Acceder"), button:has-text("Entrar")')
    .first();
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    submit.click(),
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

  const bodyText = (await page.locator('body').innerText()).toLowerCase();

  const mentionsParking = bodyText.includes(PARKING_MATCH);
  const mentionsAbono = bodyText.includes(ABONO_MATCH);

  // Признаки «нет доступного абонемента» (sold out / лист ожидания / нет продуктов).
  const soldOutSignals = [
    'no hay', 'agotado', 'sin disponibilidad', 'no disponible',
    'lista de espera', 'completo', 'no existen', 'no se han encontrado',
  ];
  const looksSoldOut = soldOutSignals.some((s) => bodyText.includes(s));

  const available = mentionsParking && mentionsAbono && !looksSoldOut;

  const detail = `parking("${PARKING_MATCH}")=${mentionsParking}, ` +
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

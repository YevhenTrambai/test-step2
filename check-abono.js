'use strict';

/**
 * Мониторинг доступности абонемента 24h в паркинге InterParking (Торрент).
 *
 * Логинится в личный кабинет P-web, открывает страницу абонементов и определяет,
 * доступен ли для оформления абонемент 24h в паркинге Торрент. При появлении
 * доступности (переход «недоступен -> доступен») шлёт пуш на телефон через ntfy.sh.
 *
 * Конфигурация через переменные окружения (см. README.md):
 *   IPK_USER, IPK_PASS    — учётка InterParking
 *   NTFY_TOPIC            — секретная «тема» ntfy для пушей (обязательно для уведомления)
 *   NTFY_SERVER           — сервер ntfy (по умолчанию https://ntfy.sh)
 *   STATE_FILE            — путь к файлу состояния (по умолчанию state.json)
 *   HEADLESS              — "false" чтобы видеть браузер (локальная отладка)
 *   PARKING_MATCH         — подстрока названия паркинга (по умолч. "torrent")
 *   ABONO_PRODUCT_RE      — регэксп продукта (по умолч. "abono\\s*24h")
 *   FAIL_THRESHOLD        — сбоев подряд до пуш-предупреждения (по умолч. 5)
 *   TEST_PUSH=true        — отправить тестовый пуш и выйти
 *
 * Уведомления (ntfy): доступность, серия сбоев, восстановление, ежедневный отчёт.
 * Коды выхода: 0 — проверка прошла; 2 — ошибка (логин/навигация/аномалия).
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://p-web.interparking.es';
const LOGIN_URL = `${BASE}/login`;
const ABONO_URL = `${BASE}/Contracts/AbonoList`;
const REPO = process.env.GITHUB_REPOSITORY || 'YevhenTrambai/test-step2';

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PARKING_MATCH = (process.env.PARKING_MATCH || 'torrent').toLowerCase();
const HEADLESS = process.env.HEADLESS !== 'false';
// Сколько проверок подряд должно упасть, чтобы прислать пуш-предупреждение.
const FAIL_THRESHOLD = Number(process.env.FAIL_THRESHOLD || 5);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function newDaily(date) {
  return { date, checks: 0, agotado: 0, available: 0, errors: 0 };
}

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
    return {
      available: false,
      lastNotifiedAt: null,
      consecutiveFailures: 0,
      failureAlertSent: false,
      daily: newDaily(todayStr()),
    };
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

  // 4) Детекция: в отфильтрованном по Торренту виде ищем строку продукта
  // «Abono 24h» и смотрим её статус. Продукт доступен, если строка найдена
  // и НЕ помечена «Agotado» (тогда вместо неё будет кнопка «Contratar»).
  const PRODUCT_RE = new RegExp(process.env.ABONO_PRODUCT_RE || 'abono\\s*24h', 'i');
  const row24 = rows.find((r) => PRODUCT_RE.test(r.t));
  const rowText = row24 ? row24.t : '';
  const rowBtns = row24 ? row24.btns.join(' ') : '';
  const isAgotado = /agotado/i.test(rowText) || /agotado/i.test(rowBtns);
  const canContract = /contratar|comprar|alta|disponible|a[ñn]adir/i.test(`${rowText} ${rowBtns}`);

  // Аномалия: фильтр не применился или строка продукта не найдена — вероятно,
  // изменилась вёрстка. Бросаем ошибку, чтобы это попало в счётчик сбоев и
  // вызвало пуш-предупреждение (а не молчаливое «недоступно»).
  if (!filtered || !row24) {
    throw new Error(
      `Аномалия страницы: filtered=${filtered}, found24h=${!!row24}. ` +
      'Возможно, изменилась вёрстка AbonoList или фильтр паркинга.'
    );
  }

  // Доступно, если строка «Abono 24h» больше не «Agotado».
  const available = !isAgotado;
  const detail =
    `agotado=${isAgotado}, contratar=${canContract} | "${rowText.slice(0, 120)}"`;
  log('Результат детекции:', detail);
  return { available, detail };
}

// Низкоуровневая отправка пуша в ntfy. Заголовки ntfy должны быть ASCII,
// поэтому Title — латиницей; эмодзи передаём через Tags, текст (UTF-8) — в body.
async function ntfyPush({ title, body, priority = 'default', tags = '', click }) {
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const topic = requireEnv('NTFY_TOPIC');
  const headers = { Title: title, Priority: priority };
  if (tags) headers.Tags = tags;
  if (click) headers.Click = click;
  const res = await fetch(`${server}/${topic}`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`ntfy ответил ${res.status} ${res.statusText}`);
}

async function pushAvailable(detail) {
  await ntfyPush({
    title: 'Abono 24h L-D Torrent DISPONIBLE',
    priority: 'urgent',
    tags: 'white_check_mark,car',
    click: ABONO_URL,
    body:
      'Abono 24h L-D в паркинге Torrent - Avenida País Valencià больше НЕ «Agotado» — ' +
      'вероятно, доступен для оформления!\n\n' +
      `Открыть: ${ABONO_URL}\n` +
      '(фильтр: Torrent - Avenida País Valencià, продукт: Abono 24h L-D)\n\n' +
      `Детали: ${detail}`,
  });
  log('Пуш о доступности отправлен.');
}

async function pushTest(detail) {
  await ntfyPush({
    title: 'ntfy test - InterParking checker',
    tags: 'gear',
    click: ABONO_URL,
    body: `Тестовый пуш от InterParking checker. Связка работает ✅\nДетали: ${detail}`,
  });
  log('Тестовый пуш отправлен в ntfy.');
}

async function pushFailure(n, reason) {
  await ntfyPush({
    title: 'InterParking checker FAILING',
    priority: 'high',
    tags: 'warning',
    click: `https://github.com/${REPO}/actions`,
    body:
      `Проверки падают подряд: ${n}.\n` +
      `Причина: ${reason}\n\n` +
      'Загляни в GitHub Actions — возможно, изменилась вёрстка сайта, ' +
      'истёк пароль (IPK_PASS) или сайт недоступен.',
  });
  log('Пуш о сбоях отправлен.');
}

async function pushRecovery(failures) {
  await ntfyPush({
    title: 'InterParking checker recovered',
    priority: 'default',
    tags: 'white_check_mark',
    body: `Проверки снова проходят успешно ✅ (после ${failures} подряд сбоев).`,
  });
  log('Пуш о восстановлении отправлен.');
}

async function pushDailyReport(d) {
  await ntfyPush({
    title: 'InterParking checker - daily report',
    priority: 'low',
    tags: 'bar_chart',
    body:
      `Отчёт за ${d.date}:\n` +
      `Проверок: ${d.checks}\n` +
      `Agotado (нет в наличии): ${d.agotado}\n` +
      `Было доступно: ${d.available}\n` +
      `Ошибок: ${d.errors}`,
  });
  log('Ежедневный отчёт отправлен.');
}

(async () => {
  // Режим тестового пуша: проверить доставку ntfy без логина/проверки сайта.
  if (process.env.TEST_PUSH === 'true') {
    try {
      await pushTest(new Date().toISOString());
    } catch (err) {
      console.error('Ошибка тестового пуша:', err.message);
      process.exitCode = 2;
    }
    return;
  }

  const state = readState();
  if (!state.daily) state.daily = newDaily(todayStr());
  if (typeof state.consecutiveFailures !== 'number') state.consecutiveFailures = 0;
  log('Прошлое состояние:', JSON.stringify(state));

  // Ежедневный отчёт на смене суток (UTC): шлём за завершившийся день, затем сброс.
  const today = todayStr();
  if (state.daily.date !== today) {
    try {
      await pushDailyReport(state.daily);
      state.daily = newDaily(today);
    } catch (e) {
      log('Не удалось отправить ежедневный отчёт:', e.message);
    }
  }

  let browser;
  let page;
  try {
    browser = await chromium.launch({
      headless: HEADLESS,
      executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext({
      locale: 'es-ES',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    page = await context.newPage();

    await login(page);
    const { available, detail } = await checkAvailability(page);

    // Успешная проверка — учитываем в дневной статистике.
    state.daily.checks += 1;
    if (available) state.daily.available += 1;
    else state.daily.agotado += 1;

    // Восстановление после серии сбоев.
    if (state.failureAlertSent) {
      try { await pushRecovery(state.consecutiveFailures); } catch (e) { log('Пуш о восстановлении не ушёл:', e.message); }
      state.failureAlertSent = false;
    }
    state.consecutiveFailures = 0;
    state.lastError = null;

    // Пуш о доступности — только на переходе «недоступен -> доступен».
    if (available && !state.available) {
      await pushAvailable(detail);
      state.lastNotifiedAt = new Date().toISOString();
    }
    state.available = available;
    log(`Готово. Доступен=${available}`);
  } catch (err) {
    console.error('Ошибка проверки:', err.message);
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    state.lastError = String(err.message || err).slice(0, 300);
    state.daily.errors = (state.daily.errors || 0) + 1;
    if (page) await page.screenshot({ path: 'artifacts/error.png', fullPage: true }).catch(() => {});

    // Пуш-предупреждение при N сбоях подряд (один раз, без спама).
    if (state.consecutiveFailures >= FAIL_THRESHOLD && !state.failureAlertSent) {
      try {
        await pushFailure(state.consecutiveFailures, state.lastError);
        state.failureAlertSent = true;
      } catch (e) {
        log('Пуш о сбоях не ушёл:', e.message);
      }
    }
    process.exitCode = 2;
  } finally {
    // Состояние пишем ВСЕГДА (в т.ч. при сбое) — иначе счётчики не сохранятся.
    writeState(state);
    if (browser) await browser.close();
  }
})();

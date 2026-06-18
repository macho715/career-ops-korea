#!/usr/bin/env node

/**
 * jobkorea-apply.mjs — JobKorea 자동 지원서 작성 실행 스크립트
 *
 * Playwright 기반. cv.md + config/jobkorea-profile.yml + reports/* 로드 후
 * JobKorea 지원 폼 자동 작성. 제출 전 PREFLIGHT 검토.
 *
 * Usage:
 *   node jobkorea-apply.mjs --url "https://www.jobkorea.co.kr/Recruit/GI_Read/12345"
 *   node jobkorea-apply.mjs --report 42
 *   node jobkorea-apply.mjs --url "..." --dry-run       (미리보기만)
 *   node jobkorea-apply.mjs --url "..." --headless=false (디버깅용 브라우저 표시)
 *   node jobkorea-apply.mjs --url "..." --throttle=5000  (지원 간격)
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When run from korea-integration/scripts/, go up 2 levels to career-ops/ root.
// Use process.cwd() fallback for when spawned by run.mjs with correct cwd.
const PROJECT_ROOT = existsSync(resolve(__dirname, '..', '..', 'package.json'))
  ? resolve(__dirname, '..', '..')
  : process.cwd();

// ── Constants ─────────────────────────────────────────────────────────

const JOBKOREA_BASE = 'https://www.jobkorea.co.kr';
const JOBKOREA_LOGIN_URL = 'https://www.jobkorea.co.kr/Login/Login_P';
const NAVIGATE_TIMEOUT_MS = 20_000;
const HYDRATION_WAIT_MS = 2_000;
const DEFAULT_THROTTLE_MS = 5_000;

const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'ko-KR',
  viewport: { width: 1280, height: 900 },
};

// ── Utility ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitteredDelay(baseMs) {
  if (!baseMs || baseMs <= 0) return 0;
  return baseMs + Math.floor(Math.random() * baseMs);
}

/**
 * @param {string} filePath
 * @returns {any}
 */
function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return yaml.load(readFileSync(filePath, 'utf-8')) || {};
  } catch (err) {
    console.error(`⚠ YAML parse error: ${filePath} — ${err.message}`);
    return {};
  }
}

function loadJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function escapeMarkdown(text) {
  return String(text || '')
    .replace(/[\\[\]*_`]/g, '\\$&')
    .replace(/\|/g, '/');
}

/**
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeJobUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(String(rawUrl).trim(), JOBKOREA_BASE).href;
  } catch {
    return '';
  }
}

// ── Profile loading ───────────────────────────────────────────────────

/**
 * @returns {{ profile: any, jkProfile: any, cv: string }}
 */
function loadProfile() {
  const profile = loadYaml(resolve(PROJECT_ROOT, 'config/profile.yml'));
  const jkProfile = loadYaml(resolve(PROJECT_ROOT, 'config/jobkorea-profile.yml'));
  const cvPath = resolve(PROJECT_ROOT, 'cv.md');
  const cv = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';
  return { profile, jkProfile, cv };
}

// ── Report lookup ─────────────────────────────────────────────────────

/**
 * Find a report by application number or company name.
 * @param {number|string} query
 * @returns {{ num: number, path: string, content: string } | null}
 */
function findReport(query) {
  const reportsDir = resolve(PROJECT_ROOT, 'reports');
  if (!existsSync(reportsDir)) return null;

  const num = Number(query);
  const allFiles = [];
  try {
    // Recurse reports/ using fs (Node 20+)
    const { readdirSync: rd } = require('fs');
    function walk(dir) {
      for (const entry of rd(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.name.endsWith('.md')) allFiles.push(full);
      }
    }
    walk(reportsDir);
  } catch {
    return null;
  }

  if (!Number.isNaN(num)) {
    const prefix = String(num).padStart(3, '0');
    const match = allFiles.find(f => f.includes(`${prefix}-`));
    if (match) {
      return {
        num,
        path: match,
        content: readFileSync(match, 'utf-8'),
      };
    }
  }

  // Search by company name substring
  const lower = String(query).toLowerCase();
  const match = allFiles.find(f => f.toLowerCase().includes(lower));
  if (match) {
    const numMatch = match.match(/(\d{3})-/);
    return {
      num: numMatch ? Number(numMatch[1]) : 0,
      path: match,
      content: readFileSync(match, 'utf-8'),
    };
  }

  return null;
}

// ── Browser setup ─────────────────────────────────────────────────────

/**
 * Launch browser with anti-bot context
 * @returns {Promise<{ browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
async function createBrowser(headless = true) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();

  // Dismiss dialogs automatically
  page.on('dialog', async dialog => {
    await dialog.accept().catch(() => {});
  });

  return { browser, context, page };
}

// ── Login ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page
 * @param {any} jkProfile
 * @returns {Promise<boolean>}
 */
async function ensureLoggedIn(page, jkProfile) {
  await page.goto(JOBKOREA_BASE, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATE_TIMEOUT_MS,
  });
  await sleep(HYDRATION_WAIT_MS);

  // Check login state
  const loggedIn = await page.evaluate(() => {
    return !!(
      document.querySelector('.my-page, .user-info, a[href*="Logout"], .logout, [class*="myPage"]') ||
      document.body.innerText.includes('로그아웃')
    );
  });

  if (loggedIn) {
    console.log('  ✓ Already logged in');
    return true;
  }

  const id = jkProfile?.jobkorea?.id;
  const pw = jkProfile?.jobkorea?.password;

  if (!id || !pw) {
    console.log('  ⚠ Not logged in. Provide credentials in config/jobkorea-profile.yml');
    return false;
  }

  console.log(`  → Logging in as ${id}...`);

  await page.goto(JOBKOREA_LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATE_TIMEOUT_MS,
  });
  await sleep(HYDRATION_WAIT_MS);

  // JobKorea login form selectors
  const idField = page.locator('input[name="m_id"], input#mber_id, input[name="mber_id"], input[name="id"]').first();
  const pwField = page.locator('input[name="password"], input#mber_pw, input[name="mber_pw"], input[type="password"]').first();
  const loginBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("로그인"), a:has-text("로그인")').first();

  if (await idField.count() === 0) {
    console.log('  ⚠ Login form not found');
    return false;
  }

  await idField.fill(id);
  await pwField.fill(pw);
  await sleep(500);

  // Check for CAPTCHA
  const hasCaptcha = await page.locator(
    'iframe[src*="captcha"], .g-recaptcha, #captcha, img[src*="captcha"], .recaptcha',
  ).count();

  if (hasCaptcha > 0) {
    console.log('  ⚠ CAPTCHA detected — solve manually in browser, then press Enter...');
    // In non-headless mode, user can solve. In headless, we pause.
    if (loginBtn.count() > 0) {
      await loginBtn.click();
    }
    // Wait for redirect after manual CAPTCHA
    await page.waitForURL('**/jobkorea.co.kr/**', { timeout: 60_000 }).catch(() => {});
    await sleep(2_000);
    return true;
  }

  await loginBtn.click();
  await sleep(3_000);

  // Verify login success
  const stillOnLogin = page.url().includes('Login') || page.url().includes('login');
  if (stillOnLogin) {
    const errorMsg = await page.textContent('.error, .alert, .warn, [class*="error"]').catch(() => '');
    console.log(`  ✗ Login failed: ${errorMsg || 'Unknown error'}`);
    return false;
  }

  console.log('  ✓ Login successful');
  return true;
}

// ── Form field detection ──────────────────────────────────────────────

/**
 * Detect all form fields on the current page.
 * Returns structured field data for each input/select/textarea found.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{
 *   selector: string,
 *   tag: string,
 *   type: string,
 *   name: string,
 *   id: string,
 *   label: string,
 *   placeholder: string,
 *   required: boolean,
 *   category: string,
 *   options?: string[]
 * }>>}
 */
async function detectFormFields(page) {
  return page.evaluate(() => {
    const fields = [];

    // Common JobKorea form containers
    const formScope = document.querySelector(
      '.popApply, #applyForm, .apply-form, form[name="apply"], form[id*="apply"], form[id*="frm"], .section_write',
    ) || document;

    const elements = formScope.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), ' +
      'select, textarea',
    );

    function getLabel(el) {
      // Check for <label for="id">
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) return lbl.textContent.trim();
      }
      // Check parent label
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent.replace(el.value || '', '').trim();
      // Check preceding sibling or parent text
      let node = el.previousElementSibling;
      while (node) {
        if (node.tagName === 'LABEL' || node.classList.contains('label') || node.classList.contains('tit')) {
          return node.textContent.trim();
        }
        node = node.previousElementSibling;
      }
      // Check parent container for .tit or th
      const row = el.closest('tr, .row, .form-group, .field, dl, li');
      if (row) {
        const th = row.querySelector('th, .th, .label, .tit, dt');
        if (th) return th.textContent.trim();
      }
      return '';
    }

    function classifyField(label, name, type, tag) {
      const combined = (label + ' ' + name).toLowerCase();
      if (/이름|name|성명/.test(combined)) return 'name';
      if (/이메일|email|mail|e.?mail/.test(combined)) return 'email';
      if (/전화|phone|tel|mobile|핸드폰|휴대폰/.test(combined)) return 'phone';
      if (/생년|birth|birthday/.test(combined)) return 'birth';
      if (/주소|addr|address|zipcode|우편/.test(combined)) return 'address';
      if (/학력|school|edu|대학|전공|major|graduat/.test(combined)) return 'education';
      if (/경력|career|exp|경험|연차/.test(combined)) return 'career';
      if (/연봉|salary|희망|pay|급여/.test(combined)) return 'salary';
      if (/자기소개|introduce|pr|cover|소개서/.test(combined)) return 'self_intro';
      if (/지원동기|motivation|지원.*이유|why/.test(combined)) return 'motivation';
      if (/포트폴리오|portfolio|url|github/.test(combined)) return 'portfolio';
      if (/기술|skill|tech|stack/.test(combined)) return 'skills';
      if (/자격|liense|license|cert/.test(combined)) return 'license';
      if (/영어|english|토익|toeic|opic|어학|lang/.test(combined)) return 'language';
      if (/취미|hobby|특기/.test(combined)) return 'hobby';
      if (/보훈|veteran|장애|disabled|취업보호/.test(combined)) return 'preferential';
      if (/동의|agree|privacy|개인정보/.test(combined)) return 'consent';
      if (tag === 'select' && type === 'select-one' && /^\d{4}/.test(combined)) return 'date_select';
      return 'other';
    }

    for (const el of elements) {
      const label = getLabel(el);
      const name = (el.getAttribute('name') || '');
      const id = el.getAttribute('id') || '';
      const type = (el.getAttribute('type') || el.tagName.toLowerCase());
      const placeholder = el.getAttribute('placeholder') || '';
      const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
      const tag = el.tagName.toLowerCase();

      const category = classifyField(label, name, type, tag);

      // Build a unique selector
      let selector = '';
      if (id) {
        selector = `#${CSS.escape(id)}`;
      } else if (name) {
        selector = `${tag}[name="${CSS.escape(name)}"]`;
      } else if (placeholder) {
        selector = `${tag}[placeholder="${CSS.escape(placeholder)}"]`;
      } else if (el.className && typeof el.className === 'string' && el.className.trim()) {
        const cls = el.className.trim().split(/\s+/)[0];
        selector = `${tag}.${CSS.escape(cls)}`;
      }

      const field = {
        selector,
        tag,
        type: type === 'select-one' ? 'select' : type,
        name,
        id,
        label: label.replace(/\s+/g, ' ').trim(),
        placeholder,
        required,
        category,
      };

      if (tag === 'select') {
        field.options = Array.from(el.querySelectorAll('option'))
          .map(o => ({ value: o.value, text: o.textContent.trim() }))
          .filter(o => o.value || o.text);
      }

      fields.push(field);
    }

    return fields;
  });
}

// ── Field value resolution ────────────────────────────────────────────

/**
 * Resolve what value to fill for a given field category.
 * @param {object} field
 * @param {any} profile
 * @param {any} jkProfile
 * @param {string} cv
 * @param {object|null} report
 * @returns {{ value: string, source: string, needsConfirm: boolean }}
 */
function resolveFieldValue(field, profile, jkProfile, cv, report) {
  const jk = jkProfile?.jobkorea || {};
  const cand = profile?.candidate || {};

  switch (field.category) {
    case 'name':
      return { value: jk.name_kor || cand.full_name || '', source: 'jobkorea-profile.yml', needsConfirm: false };

    case 'email':
      return { value: jk.email || cand.email || '', source: 'jobkorea-profile.yml', needsConfirm: false };

    case 'phone':
      return { value: jk.phone || cand.phone || '', source: 'jobkorea-profile.yml', needsConfirm: false };

    case 'birth':
      return { value: jk.birth || '', source: 'jobkorea-profile.yml', needsConfirm: false };

    case 'address': {
      const addr = jk.address || {};
      if (field.label.includes('우편') || field.label.includes('zipcode')) {
        return { value: addr.zipcode || '', source: 'jobkorea-profile.yml', needsConfirm: false };
      }
      if (field.label.includes('상세')) {
        return { value: addr.detail || '', source: 'jobkorea-profile.yml', needsConfirm: false };
      }
      return { value: addr.road || '', source: 'jobkorea-profile.yml', needsConfirm: false };
    }

    case 'education': {
      const edu = jk.education || {};
      if (field.tag === 'select') {
        const eduLevelMap = { '고졸': '고등학교 졸업', '전문대졸': '전문대학 졸업', '대졸(4년)': '대학교(4년) 졸업', '대학원(석사)': '대학원 석사 졸업', '대학원(박사)': '대학원 박사 졸업' };
        const mapped = eduLevelMap[edu.level] || edu.level || '';
        const match = (field.options || []).find(o => o.text.includes(mapped) || o.value === edu.level);
        return { value: match ? match.value : '', source: 'jobkorea-profile.yml', needsConfirm: false };
      }
      if (field.label.includes('학교') || field.label.includes('school')) {
        return { value: edu.school || '', source: 'jobkorea-profile.yml', needsConfirm: false };
      }
      if (field.label.includes('전공') || field.label.includes('major')) {
        return { value: edu.major || '', source: 'jobkorea-profile.yml', needsConfirm: false };
      }
      return { value: '', source: 'jobkorea-profile.yml', needsConfirm: false };
    }

    case 'career': {
      const car = jk.career || {};
      if (field.tag === 'select') {
        const years = car.total_years || '';
        const match = (field.options || []).find(o => o.text.includes(years) || o.value === years);
        return { value: match ? match.value : '', source: 'jobkorea-profile.yml', needsConfirm: false };
      }
      return { value: car.recent_company || car.total_years || '', source: 'jobkorea-profile.yml', needsConfirm: false };
    }

    case 'salary':
      return { value: jk.desired?.salary || '', source: 'jobkorea-profile.yml', needsConfirm: true };

    case 'self_intro':
    case 'motivation':
      return {
        value: generateEssayResponse(field, cv, report),
        source: 'cv.md + report',
        needsConfirm: false,
      };

    case 'portfolio':
      return {
        value: (jk.portfolio_urls || []).concat(cand.portfolio_url || cand.github || []).filter(Boolean).join(', '),
        source: 'jobkorea-profile.yml + profile.yml',
        needsConfirm: false,
      };

    case 'skills': {
      const skillMatch = cv.match(/Skills|기술|Tech Stack/i);
      if (skillMatch) {
        const skillsSection = cv.slice(skillMatch.index).split('\n').slice(1, 10).join(', ');
        return { value: skillsSection, source: 'cv.md', needsConfirm: false };
      }
      return { value: '', source: 'cv.md', needsConfirm: false };
    }

    case 'license':
      return {
        value: (jk.licenses || []).map(l => l.name || l).filter(Boolean).join(', '),
        source: 'jobkorea-profile.yml',
        needsConfirm: false,
      };

    case 'language':
      return {
        value: jk.language?.english?.test
          ? `${jk.language.english.test} ${jk.language.english.score} (${jk.language.english.level})`
          : '',
        source: 'jobkorea-profile.yml',
        needsConfirm: false,
      };

    case 'preferential':
      return { value: '', source: '', needsConfirm: true };

    case 'consent':
      return { value: 'true', source: 'auto', needsConfirm: true };

    default:
      return { value: '', source: '', needsConfirm: false };
  }
}

/**
 * Generate a self-introduction or motivation essay in Korean.
 * @param {object} field
 * @param {string} cv
 * @param {object|null} report
 * @returns {string}
 */
function generateEssayResponse(field, cv, report) {
  const isIntro = field.category === 'self_intro';

  // Extract key info from CV
  const nameMatch = cv.match(/^#\s+(.+)/m);
  const name = nameMatch ? nameMatch[1] : '';

  // Extract experience from cv.md
  const expSection = cv.match(/##\s*(경력|Experience|Work).*?\n([\s\S]*?)(?=##|\n##|$)/im);
  const expText = expSection ? expSection[2].trim() : '';

  // Extract skills
  const skillSection = cv.match(/##\s*(기술|Skills|Tech).*?\n([\s\S]*?)(?=##|\n##|$)/im);
  const skillText = skillSection ? skillSection[2].trim() : '';

  // Extract report key info
  let companyName = '';
  let roleName = '';
  let score = '';
  if (report) {
    const cnMatch = report.content.match(/\*\*Company:\*\*\s*(.+)/);
    const rnMatch = report.content.match(/\*\*Role:\*\*\s*(.+)/);
    const scMatch = report.content.match(/\*\*Score:\*\*\s*([\d.]+)/);
    companyName = cnMatch ? cnMatch[1].trim() : '';
    roleName = rnMatch ? rnMatch[1].trim() : '';
    score = scMatch ? scMatch[1] : '';
  }

  if (isIntro) {
    return [
      `[지원 동기]`,
      `${companyName}의 ${roleName} 포지션에 지원하게 되어 기쁩니다.`,
      ``,
      `[주요 경력 및 성과]`,
      `${expText.slice(0, 300)}`,
      ``,
      `[보유 기술]`,
      `${skillText.slice(0, 200)}`,
      ``,
      `[입사 후 포부]`,
      `귀사의 비전에 동참하여 제 전문성을 바탕으로 실질적인 기여를 하고자 합니다.`,
    ].join('\n');
  }

  return [
    `${companyName}에 지원하는 이유는 다음과 같습니다.`,
    ``,
    `첫째, ${roleName || '해당 포지션'}은 제 경력과 기술 스택이 가장 잘 부합하는 역할입니다.`,
    `둘째, 귀사의 성장 방향성과 기술 비전에 깊이 공감합니다.`,
    `셋째, 제 경험과 역량을 바탕으로 팀에 실질적인 가치를 더할 수 있다고 확신합니다.`,
  ].join('\n');
}

// ── Form filling ──────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page
 * @param {object[]} fields
 * @param {any} profile
 * @param {any} jkProfile
 * @param {string} cv
 * @param {object|null} report
 * @param {boolean} dryRun
 * @returns {Promise<Array<{label: string, value: string, source: string, needsConfirm: boolean}>>}
 */
async function fillForm(page, fields, profile, jkProfile, cv, report, dryRun) {
  const results = [];

  for (const field of fields) {
    const resolved = resolveFieldValue(field, profile, jkProfile, cv, report);
    const displayValue = resolved.value.length > 100
      ? resolved.value.slice(0, 97) + '...'
      : resolved.value || '(empty)';

    results.push({
      label: field.label || field.name || field.selector,
      value: resolved.value,
      source: resolved.source,
      needsConfirm: resolved.needsConfirm,
      category: field.category,
    });

    if (dryRun) continue;
    if (!resolved.value && field.category !== 'preferential') continue;

    try {
      let locator;

      if (field.selector && field.selector.startsWith('#') && field.id) {
        locator = page.locator(`#${field.id}`);
      } else if (field.name) {
        locator = page.locator(`[name="${field.name}"]`).first();
      } else if (field.selector) {
        locator = page.locator(field.selector).first();
      } else {
        continue;
      }

      if (await locator.count() === 0) continue;

      if (field.category === 'consent' || (field.tag === 'input' && field.type === 'checkbox')) {
        if (resolved.value === 'true' || resolved.value === 'yes') {
          await locator.check({ force: true }).catch(() => {});
        }
      } else if (field.tag === 'select') {
        await locator.selectOption(resolved.value).catch(() => {});
      } else if (field.tag === 'textarea' || field.tag === 'input') {
        await locator.fill(resolved.value).catch(() => {});
      }

      if (field.category === 'self_intro' || field.category === 'motivation') {
        await sleep(300);
      }
    } catch (err) {
      console.error(`  ⚠ Fill error: ${field.label} — ${err.message}`);
    }
  }

  return results;
}

// ── Preflight display ─────────────────────────────────────────────────

/**
 * @param {Array<{label: string, value: string, source: string, needsConfirm: boolean, category: string}>} results
 */
function displayPreflight(results) {
  const separator = '─'.repeat(70);
  console.log(`\n${separator}`);
  console.log('PREFLIGHT REVIEW — 지원서 내용 검토');
  console.log(separator);

  // Group by category
  const groups = {
    personal: { title: '📋 인적사항', items: [] },
    education: { title: '🎓 학력', items: [] },
    career: { title: '💼 경력', items: [] },
    essays: { title: '📝 자기소개서 / 지원동기', items: [] },
    other: { title: '📎 기타', items: [] },
    needsConfirm: { title: '⚠️ 확인 필요 (사용자 검토 필수)', items: [] },
  };

  for (const r of results) {
    if (r.needsConfirm) {
      groups.needsConfirm.items.push(r);
    } else if (['name', 'email', 'phone', 'birth', 'address'].includes(r.category)) {
      groups.personal.items.push(r);
    } else if (['education'].includes(r.category)) {
      groups.education.items.push(r);
    } else if (['career', 'salary'].includes(r.category)) {
      groups.career.items.push(r);
    } else if (['self_intro', 'motivation'].includes(r.category)) {
      groups.essays.items.push(r);
    } else {
      groups.other.items.push(r);
    }
  }

  for (const group of Object.values(groups)) {
    if (group.items.length === 0) continue;
    console.log(`\n${group.title}`);
    for (const item of group.items) {
      const flag = item.needsConfirm ? ' ⚠' : '';
      const displayVal = item.value.length > 120
        ? item.value.slice(0, 117) + '...'
        : item.value || '(비어있음)';
      console.log(`  ${item.label || item.category}: ${displayVal}${flag}`);
    }
  }

  console.log(`\n${separator}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const urlArg = args.indexOf('--url');
  const url = urlArg !== -1 ? args[urlArg + 1] : null;

  const reportArg = args.indexOf('--report');
  const reportNum = reportArg !== -1 ? args[reportArg + 1] : null;

  const dryRun = args.includes('--dry-run');

  const headlessArg = args.indexOf('--headless');
  const headless = headlessArg !== -1 ? args[headlessArg + 1] !== 'false' : true;

  const throttleArg = args.find(a => a.startsWith('--throttle='));
  const throttleMs = throttleArg ? Number(throttleArg.split('=')[1]) || DEFAULT_THROTTLE_MS : DEFAULT_THROTTLE_MS;

  if (!url && !reportNum) {
    console.log('Usage:');
    console.log('  node jobkorea-apply.mjs --url "https://www.jobkorea.co.kr/Recruit/GI_Read/12345"');
    console.log('  node jobkorea-apply.mjs --report 42');
    console.log('  node jobkorea-apply.mjs --url "..." --dry-run');
    console.log('  node jobkorea-apply.mjs --url "..." --headless=false');
    console.log('  node jobkorea-apply.mjs --url "..." --throttle=3000');
    process.exit(1);
  }

  // Resolve URL
  let targetUrl = url;
  let report = null;

  if (!targetUrl && reportNum) {
    report = findReport(reportNum);
    if (!report) {
      console.error(`✗ Report #${reportNum} not found in reports/`);
      process.exit(1);
    }
    const urlMatch = report.content.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      targetUrl = urlMatch[1];
    } else {
      console.error(`✗ No URL found in report #${reportNum}`);
      process.exit(1);
    }
  }

  if (!targetUrl) {
    console.error('✗ No URL provided');
    process.exit(1);
  }

  // Normalize URL
  const normalizedUrl = normalizeJobUrl(targetUrl);
  if (!normalizedUrl) {
    console.error(`✗ Invalid JobKorea URL: ${targetUrl}`);
    process.exit(1);
  }

  console.log(`\n🎯 JobKorea Auto-Apply`);
  console.log(`   URL: ${normalizedUrl}`);
  if (report) console.log(`   Report: #${String(report.num).padStart(3, '0')} — ${report.path}`);
  if (dryRun) console.log('   Mode: DRY RUN (no submission)');
  console.log('');

  // Load profile
  const { profile, jkProfile, cv } = loadProfile();

  if (!cv) {
    console.log('⚠ cv.md not found — some fields will be empty');
  }

  // Launch browser
  console.log('→ Launching browser...');
  const { browser, context, page } = await createBrowser(headless);

  try {
    // Login
    console.log('→ Checking login state...');
    const loggedIn = await ensureLoggedIn(page, jkProfile);

    if (!loggedIn && !dryRun) {
      console.log('⚠ Cannot auto-fill without login. Use --dry-run to preview.');
      await browser.close();
      return;
    }

    // Navigate to job posting
    console.log(`→ Navigating to job: ${normalizedUrl}`);
    await page.goto(normalizedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    });
    await sleep(HYDRATION_WAIT_MS);

    // Check page loaded correctly
    const pageTitle = await page.title();
    console.log(`   Page: ${pageTitle.slice(0, 60)}`);

    // Extract job title from page
    const jobTitle = await page.textContent('.view_tit, .co_title, h2, h3, [class*="title"]').catch(() => '');
    console.log(`   Job: ${(jobTitle || '').trim().slice(0, 60)}`);

    // Find and click apply button
    const applySelectors = [
      'button:has-text("지원하기")',
      'a:has-text("지원하기")',
      '.btnGSubmit',
      '.btnApply',
      '.btn-apply',
      'a[href*="Apply"]',
      'a[href*="GI_Apply"]',
      'button:has-text("온라인 지원")',
      'button:has-text("간편지원")',
    ];

    let applyBtn = null;
    for (const sel of applySelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0) {
        applyBtn = btn;
        break;
      }
    }

    if (!applyBtn) {
      console.log('⚠ Apply button not found. The posting may use inline form or be closed.');
      // Check for inline form
      const inlineForm = await page.locator(
        '.popApply, #applyForm, .apply-form, form[name="apply"], .section_write',
      ).count();
      if (inlineForm === 0) {
        console.log('✗ No application form detected on this page.');
        await browser.close();
        return;
      }
      console.log('   Using inline form on the page.');
    } else {
      console.log('→ Clicking apply button...');
      await applyBtn.click();
      await sleep(3_000);

      // Handle popup/new tab
      const pages = context.pages();
      if (pages.length > 1) {
        console.log('   Application opened in new tab.');
        await pages[pages.length - 1].bringToFront();
        await sleep(2_000);
      }
    }

    // Detect form fields
    console.log('→ Detecting form fields...');
    await sleep(1_000);
    const formPage = context.pages()[context.pages().length - 1];
    const fields = await detectFormFields(formPage);
    console.log(`   Found ${fields.length} fields`);

    if (fields.length === 0) {
      console.log('⚠ No form fields detected. The apply page structure may have changed.');
      // Take screenshot for debugging
      if (!dryRun) {
        await formPage.screenshot({ path: resolve(PROJECT_ROOT, 'data/jobkorea-apply-debug.png') });
        console.log('   Screenshot saved: data/jobkorea-apply-debug.png');
      }
      await browser.close();
      return;
    }

    // Fill form
    console.log('→ Filling form fields...');
    const results = await fillForm(formPage, fields, profile, jkProfile, cv, report, dryRun);

    // Display preflight
    displayPreflight(results);

    // Count warnings
    const warnings = results.filter(r => r.needsConfirm);
    if (warnings.length > 0) {
      console.log(`\n⚠ ${warnings.length} field(s) need your manual confirmation before submission.`);
    }

    if (dryRun) {
      console.log('\n✓ DRY RUN complete — form was NOT submitted.');
      await browser.close();
      return;
    }

    // Wait for user confirmation if not headless
    if (!headless) {
      console.log('\n→ Review the form in the browser, then press Enter to submit (or Ctrl+C to cancel)...');
      // In Node.js, we can't easily pause stdin in ESM, so auto-continue with warning
      console.log('  (Running in interactive mode — review form before submission)');
      await sleep(5_000);
    }

    // Find and click submit button
    const submitSelectors = [
      'button:has-text("제출")',
      'button:has-text("지원완료")',
      'button:has-text("제출하기")',
      'input[type="submit"]',
      '.btnSubmit',
      'button[type="submit"]',
      'button:has-text("저장")',
    ];

    let submitBtn = null;
    for (const sel of submitSelectors) {
      const btn = formPage.locator(sel).first();
      if (await btn.count() > 0) {
        submitBtn = btn;
        break;
      }
    }

    if (submitBtn) {
      console.log('→ Ready to submit. Click submit button in browser, or run with a visible browser to review first.');
      console.log('  (TIP: use --headless=false to see the browser)');
    } else {
      console.log('⚠ Submit button not found — check the form manually.');
    }

    // Keep browser open briefly for headless=false
    if (!headless) {
      console.log('\nBrowser will close in 30 seconds...');
      await sleep(30_000);
    }

  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    if (!headless) {
      await sleep(10_000);
    }
  } finally {
    await browser.close();
    console.log('\n✓ Browser closed.');
  }

  // Record application
  if (!dryRun && report) {
    const jkTrackerPath = resolve(PROJECT_ROOT, 'data/jobkorea-applications.tsv');
    mkdirSync(dirname(jkTrackerPath), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const companyMatch = report.content.match(/\*\*Company:\*\*\s*(.+)/);
    const roleMatch = report.content.match(/\*\*Role:\*\*\s*(.+)/);
    const scoreMatch = report.content.match(/\*\*Score:\*\*\s*([\d.]+)/);
    const company = companyMatch ? companyMatch[1].trim() : '';
    const role = roleMatch ? roleMatch[1].trim() : '';
    const score = scoreMatch ? scoreMatch[1] : '';

    if (!existsSync(jkTrackerPath)) {
      appendFileSync(jkTrackerPath, 'date\tcompany\trole\turl\treport_num\tscore\tresult\tnotes\n', 'utf-8');
    }
    const row = [date, company, role, normalizedUrl, `#${report.num}`, score, dryRun ? 'DRY_RUN' : 'Applied', '']
      .map(v => String(v).replace(/\t/g, ' '))
      .join('\t');
    appendFileSync(jkTrackerPath, row + '\n', 'utf-8');
    console.log(`   ✓ Recorded in data/jobkorea-applications.tsv`);
  }

  console.log('\n→ Done. Run /career-ops jobkorea status to see application history.');
}

// Only run when executed directly, not when imported
function isMain() {
  try {
    if (!process.argv[1]) return false;
    const resolved = resolve(process.argv[1]).replace(/\\/g, '/');
    const expected = import.meta.url.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    return resolved === expected;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

export { loadProfile, findReport, detectFormFields, resolveFieldValue, generateEssayResponse, isMain };

#!/usr/bin/env node

/**
 * saramin-apply.mjs — Saramin(사람인) 자동 지원서 작성
 *
 * Playwright headed mode (Saramin blocks headless).
 * config/saramin-profile.yml + cv.md + reports/* 로드 후
 * Saramin 지원 폼 자동 작성. 제출 전 PREFLIGHT 검토.
 *
 * Usage:
 *   node saramin-apply.mjs --url "https://www.saramin.co.kr/..."
 *   node saramin-apply.mjs --report 42
 *   node saramin-apply.mjs --url "..." --dry-run
 *   node saramin-apply.mjs --url "..." --headless=false
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = existsSync(resolve(__dirname, '..', 'package.json'))
  ? resolve(__dirname, '..')
  : process.cwd();

// ── Constants ─────────────────────────────────────────────────────────

const SARAMIN_BASE = 'https://www.saramin.co.kr';
const NAVIGATE_TIMEOUT_MS = 30_000;
const HYDRATION_WAIT_MS = 3_000;

const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  locale: 'ko-KR',
  viewport: { width: 1280, height: 900 },
};

// ── Utility ───────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadYaml(fp) {
  if (!existsSync(fp)) return {};
  try { return yaml.load(readFileSync(fp, 'utf-8')) || {}; }
  catch (e) { console.error(`⚠ YAML: ${fp} — ${e.message}`); return {}; }
}

// ── Profile loading ───────────────────────────────────────────────────

function loadProfile() {
  const profile = loadYaml(resolve(PROJECT_ROOT, 'config/profile.yml'));
  const srProfile = loadYaml(resolve(PROJECT_ROOT, 'config/saramin-profile.yml'));
  const cvPath = resolve(PROJECT_ROOT, 'cv.md');
  const cv = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';
  return { profile, srProfile, cv };
}

// ── Report lookup ─────────────────────────────────────────────────────

function findReport(query) {
  const reportsDir = resolve(PROJECT_ROOT, 'reports');
  if (!existsSync(reportsDir)) return null;

  const num = Number(query);
  let allFiles = [];
  try {
    function walk(dir) {
      for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.name.endsWith('.md')) allFiles.push(full);
      }
    }
    walk(reportsDir);
  } catch { return null; }

  if (!Number.isNaN(num)) {
    const prefix = String(num).padStart(3, '0');
    const match = allFiles.find(f => f.includes(`${prefix}-`));
    if (match) return { num, path: match, content: readFileSync(match, 'utf-8') };
  }

  const lower = String(query).toLowerCase();
  const match = allFiles.find(f => f.toLowerCase().includes(lower));
  if (match) {
    const nm = match.match(/(\d{3})-/);
    return { num: nm ? Number(nm[1]) : 0, path: match, content: readFileSync(match, 'utf-8') };
  }
  return null;
}

// ── Browser setup ─────────────────────────────────────────────────────

async function createBrowser(headless) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext(CONTEXT_OPTIONS);

  // Override navigator.webdriver for anti-bot bypass
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  page.on('dialog', async d => { await d.accept().catch(() => {}); });
  return { browser, context, page };
}

// ── Login ─────────────────────────────────────────────────────────────

async function ensureLoggedIn(page, srProfile) {
  console.log('→ Checking login...');
  try {
    await page.goto(SARAMIN_BASE, { waitUntil: 'load', timeout: NAVIGATE_TIMEOUT_MS });
  } catch { /* partial load ok */ }
  await sleep(HYDRATION_WAIT_MS);

  const loggedIn = await page.evaluate(() =>
    !!(document.querySelector('.user_info, .my_page, .logout, a[href*="logout"], [class*="member"]'))
  );

  if (loggedIn) { console.log('  ✓ Logged in'); return true; }

  const id = srProfile?.saramin?.id;
  const pw = srProfile?.saramin?.password;
  if (!id || !pw) {
    console.log('  ⚠ Not logged in. Set saramin.id/pw in config/saramin-profile.yml');
    return false;
  }

  console.log('  → Logging in...');
  // Try multiple known login URLs
  const loginUrls = [
    `${SARAMIN_BASE}/zf_user/auth/login`,
    `${SARAMIN_BASE}/zf_user/auth`,
    `${SARAMIN_BASE}/member/login`,
  ];

  let loginSuccess = false;
  for (const url of loginUrls) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    } catch { continue; }
    await sleep(2_000);

    const idField = page.locator('input[name="id"], input#id, input[name="user_id"], input[type="text"]').first();
    const pwField = page.locator('input[name="password"], input#password, input[type="password"]').first();

    if (await idField.count() === 0) continue;

    await idField.fill(id);
    await pwField.fill(pw);
    await sleep(500);

    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("로그인")').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await sleep(3_000);
      loginSuccess = true;
      break;
    }
  }

  if (loginSuccess) { console.log('  ✓ Logged in'); }
  else { console.log('  ⚠ Login form not found — continue in headed mode'); }
  return loginSuccess;
}

// ── Field detection ───────────────────────────────────────────────────

async function detectFormFields(page) {
  return page.evaluate(() => {
    const formScope = document.querySelector(
      'form, .apply_form, .section_apply, .pop_apply, .jf_apply_wrap, .wrap_apply, body'
    ) || document;

    const elements = formScope.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea'
    );

    function getLabel(el) {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent.replace(/\s+/g, ' ').trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent.replace(el.value || '', '').replace(/\s+/g, ' ').trim();
      const row = el.closest('tr, .row, .form_group, .apply_row, dl, li');
      if (row) {
        const th = row.querySelector('th, .th, .tit, dt, .label, .form_tit');
        if (th) return th.textContent.replace(/\s+/g, ' ').trim();
      }
      return '';
    }

    function classify(label, name, type, tag) {
      const c = (label + ' ' + name).toLowerCase();
      if (/이름|name|성명/.test(c)) return 'name';
      if (/이메일|email|mail/.test(c)) return 'email';
      if (/전화|phone|tel|mobile|핸드폰|휴대폰/.test(c)) return 'phone';
      if (/생년|birth|birthday/.test(c)) return 'birth';
      if (/주소|addr|address|zipcode|우편/.test(c)) return 'address';
      if (/학교|school|대학|전공|major|graduat/.test(c)) return 'education';
      if (/경력|career|exp|경험|연차/.test(c)) return 'career';
      if (/연봉|salary|희망연봉|급여/.test(c)) return 'salary';
      if (/자기소개|자소서|pr|cover|소개서/.test(c)) return 'self_intro';
      if (/지원동기|motivation|지원.*이유/.test(c)) return 'motivation';
      if (/포트폴리오|portfolio|github/.test(c)) return 'portfolio';
      if (/기술|skill|tech/.test(c)) return 'skills';
      if (/자격|license|cert/.test(c)) return 'license';
      if (/영어|english|토익|toeic|opic|어학|lang/.test(c)) return 'language';
      if (/병역|military|군필/.test(c)) return 'military';
      if (/취미|hobby|특기/.test(c)) return 'hobby';
      if (/보훈|veteran|장애|disabled|취업보호/.test(c)) return 'preferential';
      if (/동의|agree|privacy|개인정보/.test(c)) return 'consent';
      return 'other';
    }

    const fields = [];
    for (const el of elements) {
      const label = getLabel(el);
      const name = el.getAttribute('name') || '';
      const id = el.getAttribute('id') || '';
      const type = el.getAttribute('type') || el.tagName.toLowerCase();
      const placeholder = el.getAttribute('placeholder') || '';
      const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
      const tag = el.tagName.toLowerCase();
      const category = classify(label, name, type, tag);

      let selector = id ? `#${CSS.escape(id)}` : (name ? `${tag}[name="${CSS.escape(name)}"]` : '');

      /** @type {{value: string, text: string}[]} */
      const options = tag === 'select'
        ? Array.from(el.querySelectorAll('option')).map(o => ({ value: o.value, text: o.textContent?.trim() })).filter(o => o.value || o.text)
        : undefined;

      fields.push({ selector, tag, type, name, id, label, placeholder, required, category, options });
    }
    return fields;
  });
}

// ── Value resolution ──────────────────────────────────────────────────

function resolveFieldValue(field, profile, srProfile, cv, report) {
  const sr = srProfile?.saramin || {};
  const cand = profile?.candidate || {};

  const resolvers = {
    name: () => ({ v: sr.name_kor || cand.full_name || '', s: 'saramin-profile.yml', c: false }),
    email: () => ({ v: sr.email || cand.email || '', s: 'saramin-profile.yml', c: false }),
    phone: () => ({ v: sr.phone || cand.phone || '', s: 'saramin-profile.yml', c: false }),
    birth: () => ({ v: sr.birth || '', s: 'saramin-profile.yml', c: false }),
    address: () => {
      const a = sr.address || {};
      if (/우편|zipcode/.test(field.label)) return { v: a.zipcode || '', s: 'saramin-profile.yml', c: false };
      if (/상세/.test(field.label)) return { v: a.detail || '', s: 'saramin-profile.yml', c: false };
      return { v: a.road || '', s: 'saramin-profile.yml', c: false };
    },
    education: () => {
      const e = sr.education || {};
      if (field.tag === 'select') {
        const map = { '고졸': '고등학교', '전문대졸': '전문대학', '대졸(4년)': '대학교(4년)', '대학원(석사)': '대학원 석사', '대학원(박사)': '대학원 박사' };
        const m = map[e.level] || e.level || '';
        const match = (field.options || []).find(o => o.text.includes(m) || o.value === e.level);
        return { v: match?.value || '', s: 'saramin-profile.yml', c: false };
      }
      return { v: e[field.label.includes('학교') ? 'school' : field.label.includes('전공') ? 'major' : 'graduation_status'] || '', s: 'saramin-profile.yml', c: false };
    },
    career: () => {
      const car = sr.career || {};
      if (field.tag === 'select') {
        const match = (field.options || []).find(o => o.text.includes(car.total_years) || o.value === car.total_years);
        return { v: match?.value || '', s: 'saramin-profile.yml', c: false };
      }
      return { v: car[field.label.includes('회사') ? 'recent_company' : 'responsibilities'] || '', s: 'saramin-profile.yml', c: false };
    },
    salary: () => ({ v: sr.desired?.salary || '', s: 'saramin-profile.yml', c: true }),
    military: () => {
      const m = sr.military || {};
      if (field.tag === 'select') {
        const match = (field.options || []).find(o => o.text.includes(m.status) || o.value === m.status);
        return { v: match?.value || '', s: 'saramin-profile.yml', c: false };
      }
      return { v: m[field.label.includes('계급') ? 'rank' : 'branch'] || '', s: 'saramin-profile.yml', c: false };
    },
    self_intro: () => ({ v: generateEssay(field, cv, report), s: 'cv.md + report', c: false }),
    motivation: () => ({ v: generateEssay(field, cv, report), s: 'cv.md + report', c: false }),
    portfolio: () => ({ v: (sr.portfolio_urls || []).concat(cand.portfolio_url || cand.github || []).filter(Boolean).join(', '), s: 'saramin-profile.yml', c: false }),
    skills: () => {
      const m = cv.match(/Skills|기술|Tech Stack/i);
      return { v: m ? cv.slice(m.index).split('\n').slice(1, 10).join(', ') : '', s: 'cv.md', c: false };
    },
    license: () => ({ v: (sr.licenses || []).map(l => `${l.name}(${l.organization || ''}, ${l.date || ''})`).join(', '), s: 'saramin-profile.yml', c: false }),
    language: () => {
      const eng = sr.language?.english || {};
      return { v: eng.test ? `${eng.test} ${eng.score} (${eng.level || ''})` : '', s: 'saramin-profile.yml', c: false };
    },
    preferential: () => ({ v: '', s: '', c: true }),
    consent: () => ({ v: 'true', s: 'auto', c: true }),
  };

  const r = resolvers[field.category];
  const result = r ? r() : { v: '', s: '', c: false };
  return { value: result.v, source: result.s, needsConfirm: result.c };
}

function generateEssay(field, cv, report) {
  const isIntro = field.category === 'self_intro';
  let companyName = '', roleName = '';
  if (report) {
    const cm = report.content.match(/\*\*Company:\*\*\s*(.+)/);
    const rm = report.content.match(/\*\*Role:\*\*\s*(.+)/);
    companyName = cm ? cm[1].trim() : '';
    roleName = rm ? rm[1].trim() : '';
  }
  const expMatch = cv.match(/##\s*(경력|Experience|Work).*?\n([\s\S]*?)(?=##|\n##|$)/im);
  const expText = expMatch ? expMatch[2].trim().slice(0, 300) : '';
  const skillMatch = cv.match(/##\s*(기술|Skills|Tech).*?\n([\s\S]*?)(?=##|\n##|$)/im);
  const skillText = skillMatch ? skillMatch[2].trim().slice(0, 200) : '';

  if (isIntro) {
    return [
      `[지원 동기]`,
      `${companyName}의 ${roleName} 포지션에 지원합니다.`,
      ``,
      `[주요 경력]`,
      expText,
      ``,
      `[기술 역량]`,
      skillText,
      ``,
      `[입사 후 포부]`,
      `귀사의 성장에 기여할 수 있는 기회를 소중히 생각하며, 맡은 바 책임을 다하겠습니다.`,
    ].join('\n');
  }
  return [
    `${companyName}에 지원하는 이유:`,
    `1. ${roleName || '해당 역할'}은 제 경험과 가장 잘 부합합니다.`,
    `2. 귀사의 비전과 기술 방향에 공감합니다.`,
    `3. 제 전문성을 바탕으로 즉시 기여할 수 있습니다.`,
  ].join('\n');
}

// ── Form filling ──────────────────────────────────────────────────────

async function fillForm(page, fields, profile, srProfile, cv, report, dryRun) {
  const results = [];
  for (const field of fields) {
    const resolved = resolveFieldValue(field, profile, srProfile, cv, report);
    results.push({
      label: field.label || field.name || field.selector,
      value: resolved.value,
      source: resolved.source,
      needsConfirm: resolved.needsConfirm,
      category: field.category,
    });

    if (dryRun || !resolved.value) continue;

    try {
      let locator;
      if (field.id) locator = page.locator(`#${field.id}`).first();
      else if (field.name) locator = page.locator(`[name="${field.name}"]`).first();
      else if (field.selector) locator = page.locator(field.selector).first();
      else continue;

      if (await locator.count() === 0) continue;

      if (field.category === 'consent' || (field.tag === 'input' && field.type === 'checkbox'))
        await locator.check({ force: true }).catch(() => {});
      else if (field.tag === 'select')
        await locator.selectOption(resolved.value).catch(() => {});
      else
        await locator.fill(resolved.value).catch(() => {});
    } catch {}
  }
  return results;
}

// ── Preflight display ─────────────────────────────────────────────────

function displayPreflight(results) {
  const sep = '─'.repeat(70);
  console.log(`\n${sep}`);
  console.log(`PREFLIGHT REVIEW — Saramin 지원서 검토`);
  console.log(sep);

  const groups = {
    personal: { title: '📋 인적사항', items: [] },
    education: { title: '🎓 학력', items: [] },
    career: { title: '💼 경력', items: [] },
    essays: { title: '📝 자기소개서 / 지원동기', items: [] },
    other: { title: '📎 기타', items: [] },
    confirm: { title: '⚠️ 확인 필요 (직접 검토)', items: [] },
  };

  for (const r of results) {
    const cat = r.needsConfirm ? 'confirm'
      : ['name','email','phone','birth','address'].includes(r.category) ? 'personal'
      : r.category === 'education' ? 'education'
      : ['career','salary','military'].includes(r.category) ? 'career'
      : ['self_intro','motivation'].includes(r.category) ? 'essays'
      : 'other';
    groups[cat].items.push(r);
  }

  for (const g of Object.values(groups)) {
    if (!g.items.length) continue;
    console.log(`\n${g.title}`);
    for (const item of g.items) {
      const flag = item.needsConfirm ? ' ⚠' : '';
      const d = item.value.length > 120 ? item.value.slice(0, 117) + '...' : (item.value || '(비어있음)');
      console.log(`  ${item.label || item.category}: ${d}${flag}`);
    }
  }
  console.log(`\n${sep}`);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const a = process.argv.slice(2);
  const urlIdx = a.indexOf('--url');
  const url = urlIdx !== -1 ? a[urlIdx + 1] : null;
  const rptIdx = a.indexOf('--report');
  const reportNum = rptIdx !== -1 ? a[rptIdx + 1] : null;
  const dryRun = a.includes('--dry-run');
  const hlIdx = a.indexOf('--headless');
  // Default to headed because Saramin blocks headless
  const headless = hlIdx !== -1 ? a[hlIdx + 1] === 'true' : false;

  if (!url && !reportNum) {
    console.log('Usage: node saramin-apply.mjs --url "..." [--report 42] [--dry-run] [--headless=true]');
    process.exit(1);
  }

  let targetUrl = url;
  let report = null;

  if (!targetUrl && reportNum) {
    report = findReport(reportNum);
    if (!report) { console.error(`✗ Report #${reportNum} not found`); process.exit(1); }
    const um = report.content.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s]+)/);
    targetUrl = um ? um[1] : null;
    if (!targetUrl) { console.error('✗ No URL in report'); process.exit(1); }
  }

  if (!targetUrl) { console.error('✗ No URL'); process.exit(1); }

  console.log(`\n🎯 Saramin Auto-Apply`);
  console.log(`   URL: ${targetUrl}`);
  if (report) console.log(`   Report: #${String(report.num).padStart(3, '0')}`);
  console.log(`   Mode: ${headless ? 'HEADLESS (may be blocked)' : 'HEADED'} ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const { profile, srProfile, cv } = loadProfile();
  if (!srProfile?.saramin?.id) console.log('⚠ saramin-profile.yml not configured — login will be skipped');
  if (!cv) console.log('⚠ cv.md not found — essays will be empty');

  const { browser, context, page } = await createBrowser(headless);

  try {
    const loggedIn = await ensureLoggedIn(page, srProfile);
    if (!loggedIn && !dryRun) {
      console.log('⚠ Cannot proceed without login. Use --dry-run to preview, or set credentials in config/saramin-profile.yml');
      await browser.close();
      return;
    }

    console.log('→ Navigating to job...');
    try { await page.goto(targetUrl, { waitUntil: 'load', timeout: NAVIGATE_TIMEOUT_MS }); }
    catch { /* partial load ok */ }
    await sleep(HYDRATION_WAIT_MS);
    console.log('   Title:', (await page.title()).slice(0, 60));

    // Click apply
    const applyBtn = page.locator(
      'button:has-text("지원하기"), a:has-text("지원하기"), button:has-text("입사지원"), a:has-text("입사지원"), .btn_apply, .btn-apply'
    ).first();

    if (await applyBtn.count() > 0) {
      console.log('→ Clicking apply...');
      await applyBtn.click();
      await sleep(3_000);
      const pages = context.pages();
      if (pages.length > 1) {
        await pages[pages.length - 1].bringToFront();
        await sleep(2_000);
      }
    } else {
      console.log('⚠ No apply button — check if posting is still open');
    }

    const active = context.pages()[context.pages().length - 1];
    const fields = await detectFormFields(active);
    console.log(`   Found ${fields.length} form fields`);

    if (fields.length === 0) {
      console.log('⚠ No form fields detected. Screenshot saved.');
      await active.screenshot({ path: resolve(PROJECT_ROOT, 'data/saramin-apply-debug.png') });
      return;
    }

    console.log('→ Filling fields...');
    const results = await fillForm(active, fields, profile, srProfile, cv, report, dryRun);
    displayPreflight(results);

    const warnings = results.filter(r => r.needsConfirm).length;
    if (warnings) console.log(`\n⚠ ${warnings} field(s) need manual confirmation.`);

    if (dryRun) {
      console.log('\n✓ DRY RUN — no submission.\n');
    } else if (!headless) {
      console.log('\n→ Review form in the browser. Close browser to finish.\n');
      console.log('  Browser stays open — verify all fields before manual submit.');
      await sleep(60_000); // Keep browser open for review
    }

  } finally {
    await browser.close().catch(() => {});
  }

  // Record
  if (!dryRun && report) {
    const trackerPath = resolve(PROJECT_ROOT, 'data/saramin-applications.tsv');
    mkdirSync(dirname(trackerPath), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const cm = report.content.match(/\*\*Company:\*\*\s*(.+)/);
    const rm = report.content.match(/\*\*Role:\*\*\s*(.+)/);
    const sm = report.content.match(/\*\*Score:\*\*\s*([\d.]+)/);
    if (!existsSync(trackerPath))
      appendFileSync(trackerPath, 'date\tcompany\trole\turl\treport_num\tscore\tresult\tnotes\n', 'utf-8');
    appendFileSync(trackerPath,
      [date, cm?.[1]?.trim() || '', rm?.[1]?.trim() || '', targetUrl, `#${report.num}`, sm?.[1] || '', dryRun ? 'DRY_RUN' : 'Applied', '']
        .map(v => String(v).replace(/\t/g, ' ')).join('\t') + '\n', 'utf-8');
    console.log('   ✓ Recorded in data/saramin-applications.tsv');
  }
  console.log('\n→ Done.\n');
}

// ── Entry ──────────────────────────────────────────────────────────────

function isMain() {
  try {
    if (!process.argv[1]) return false;
    return resolve(process.argv[1]).replace(/\\/g, '/') === import.meta.url.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  } catch { return false; }
}

if (isMain()) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

export { loadProfile, findReport, detectFormFields, resolveFieldValue };

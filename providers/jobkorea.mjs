// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// JobKorea provider — Playwright scraper for jobkorea.co.kr (Tailwind React SPA).
//
// JobKorea redesigned in 2026 to a Next.js/React SPA with Tailwind CSS.
// No public API — we use headless Chromium with Ko-KR context.
//
// portals.yml config per entry:
//   provider: jobkorea
//   search_keywords: ["AI 엔지니어", "머신러닝"]  (required)
//   location_filter: ["서울", "경기"]             (optional)
//   pages: 1                                      (optional, default 1, max 10)
//
// Usage via scan.mjs:
//   node scan.mjs --company "JobKorea"
//   node scan.mjs --company "JobKorea" --verify

const JOBKOREA_BASE = 'https://www.jobkorea.co.kr';
const NAVIGATE_TIMEOUT_MS = 30_000;
const HYDRATION_WAIT_MS = 4_000;
const CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'ko-KR',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitteredDelay(baseMs) {
  if (!baseMs || baseMs <= 0) return 0;
  return baseMs + Math.floor(Math.random() * baseMs);
}

/**
 * @param {import('./_types.js').PortalEntry} entry
 */
function parseConfig(entry) {
  const keywords = Array.isArray(entry.search_keywords)
    ? entry.search_keywords.filter(k => typeof k === 'string' && k.trim())
    : [];
  const locationFilter = Array.isArray(entry.location_filter)
    ? entry.location_filter.map(l => String(l).trim()).filter(Boolean)
    : [];
  const pages = Math.max(1, Math.min(10, Number(entry.pages) || 1));
  return {
    keywords: keywords.length > 0 ? keywords : [''],
    locationFilter,
    pages,
  };
}

/**
 * Clean JobKorea URL — strip tracking params (listno, sc) for dedup.
 */
function cleanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('listno');
    u.searchParams.delete('sc');
    u.searchParams.delete('logpath');
    return u.href;
  } catch {
    return rawUrl;
  }
}

/**
 * Extract jobs from a loaded JobKorea search page (Tailwind React SPA).
 * Cards use Tailwind utility classes (flex, w-full, p-7, mb-0.5, etc.)
 * and data-sentry attributes from the React component library.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
 */
async function extractJobs(page) {
  return page.evaluate(() => {
    /** @type {Array<{title: string, url: string, company: string, location: string}>} */
    const jobs = [];
    const seen = new Set();

    const allLinks = document.querySelectorAll('a[href*="Recruit/GI_Read"]');

    for (const link of allLinks) {
      const href = link.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);

      // Find card container — Tailwind padding classes p-5/p-6/p-7
      let card = link.closest('[class*="p-7"]');
      if (!card) card = link.closest('[class*="p-5"]');
      if (!card) card = link.closest('[class*="p-6"]');
      if (!card) continue;

      // Title: bold text in recruit link, native span inside
      let title = '';
      const titleEls = card.querySelectorAll(
        'span.font-semibold.text-gray900, span.truncate.font-semibold, ' +
        'a[href*="Recruit"] span[class*="text-gray900"], ' +
        '.font-semibold.text-typo-b1-18',
      );
      for (const el of titleEls) {
        const t = el.textContent.trim();
        if (t.length > 3) { title = t; break; }
      }
      // Fallback: any reasonably long text inside a recruit link
      if (!title) {
        const links = card.querySelectorAll('a[href*="Recruit"]');
        for (const l of links) {
          const t = l.textContent.trim();
          if (t.length > 5 && t.length < 200) { title = t; break; }
        }
      }

      // Company: truncate spans that aren't the title
      let company = '';
      const spans = card.querySelectorAll('span.truncate');
      for (const s of spans) {
        const t = s.textContent.trim();
        if (t === title) continue;
        if (s.closest('a')?.querySelector('.font-semibold, .text-gray900')) continue;
        if (t.length > 1 && t.length < 50 && !t.includes('만원') && !t.includes('년 ')) {
          company = t;
          break;
        }
      }

      // Location: text-gray spans with Korean district patterns
      let location = '';
      const graySpans = card.querySelectorAll('span[class*="text-gray"]');
      for (const s of graySpans) {
        const t = s.textContent.trim();
        if (!t || t === title || t === company) continue;
        if (t.length > 20 || t.includes('만원')) continue;
        // Korean location pattern: 시/도/구 + optional suffix
        if (/[가-힣]+ [가-힣]+[시군구]|[가-힣]+ [가-힣]+ [가-힣]+/.test(t)) {
          location = t;
          break;
        }
      }

      if (title) {
        jobs.push({ title, url: href, company, location });
      }
    }

    return jobs;
  });
}

/**
 * Scrape one search results page.
 */
async function scrapeSearchPage(context, keyword, pageNum, companyName, locationFilter) {
  const page = await context.newPage();

  try {
    const searchUrl = keyword
      ? `${JOBKOREA_BASE}/Search/?stext=${encodeURIComponent(keyword)}&Page_No=${pageNum}&tabType=recruit`
      : `${JOBKOREA_BASE}/Search/?Page_No=${pageNum}&tabType=recruit`;

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    });
    await sleep(HYDRATION_WAIT_MS);

    // Wait for job cards
    await page
      .locator('a[href*="Recruit/GI_Read"]')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});

    let jobs = await extractJobs(page);

    // Clean URLs and dedup
    const seen = new Set();
    jobs = jobs.filter(j => {
      const clean = cleanUrl(j.url);
      if (seen.has(clean)) return false;
      seen.add(clean);
      j.url = clean;
      return true;
    });

    // Location filter
    if (locationFilter.length > 0) {
      jobs = jobs.filter(j =>
        locationFilter.some(loc => j.location.toLowerCase().includes(loc.toLowerCase())),
      );
    }

    return jobs;
  } finally {
    await page.close().catch(() => {});
  }
}

/** @type {Provider} */
export default {
  id: 'jobkorea',

  detect(entry) {
    if (entry.provider !== 'jobkorea') return null;
    return { url: JOBKOREA_BASE };
  },

  async fetch(entry) {
    const { keywords, locationFilter, pages } = parseConfig(entry);

    if (keywords.length === 0 || (keywords.length === 1 && !keywords[0])) {
      throw new Error('jobkorea: search_keywords is required in portals.yml config');
    }

    let chromium;
    try {
      chromium = (await import('playwright')).chromium;
    } catch (err) {
      throw new Error(
        `jobkorea: Playwright required (run "npx playwright install chromium"): ${err.message}`,
        { cause: err },
      );
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext(CONTEXT_OPTIONS);

    const allJobs = [];
    const seen = new Set();

    try {
      for (const keyword of keywords) {
        for (let p = 1; p <= pages; p++) {
          try {
            if (p > 1) await sleep(jitteredDelay(2_000));

            const pageJobs = await scrapeSearchPage(context, keyword, p, entry.name, locationFilter);
            for (const job of pageJobs) {
              const clean = cleanUrl(job.url);
              if (!seen.has(clean)) {
                seen.add(clean);
                allJobs.push({ ...job, url: clean, company: job.company || entry.name });
              }
            }

            if (pageJobs.length === 0) break;
          } catch (err) {
            console.error(`  ✗ jobkorea: page ${p} "${keyword}": ${err.message}`);
            if (p === 1) break;
          }
        }
      }
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    return allJobs;
  },
};

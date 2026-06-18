// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Saramin provider — official REST API (oapi.saramin.co.kr/job-search).
//
// 사람인(Saramin) provides a public, documented JSON search API with
// access-key authentication. No scraping required — this is the
// officially supported, legal way to access job listings.
//
// API docs: https://oapi.saramin.co.kr/guide/job-search
//
// portals.yml config per entry:
//   provider: saramin
//   access_key: "YOUR_ACCESS_KEY"                (required — register at oapi.saramin.co.kr)
//   search_keywords: ["AI 엔지니어", "머신러닝"]   (optional — maps to `keywords` param)
//   location_codes: ["101010"]                    (optional — loc_cd from code table 2)
//   location_mcodes: ["101000"]                   (optional — loc_mcd, 1st-level location)
//   location_bcodes: ["101050"]                   (optional — loc_bcd, 2nd-level location)
//   job_type: "1"                                 (optional — employment type)
//   edu_level: "0"                                (optional — education level)
//   fields: "posting-date,expiration-date,count"  (optional — extra response fields)
//   count: 50                                     (optional — results per page, max 110)
//   max_pages: 3                                  (optional — pages to fetch)
//   sort: "pd"                                    (optional — sort order, pd=date desc)
//   stock: ""                                     (optional — kospi/kosdaq/konex)
//   sr: "directhire"                              (optional — exclude headhunting)
//
// Rate limit: 500 requests/day. The provider counts 1 request per page.
//
// Code tables (for location_codes etc.):
//   https://oapi.saramin.co.kr/guide/code-table2

const API_BASE = 'https://oapi.saramin.co.kr';
const DEFAULT_COUNT = 50;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGE_SIZE = 110;

const ALLOWED_SARAMIN_HOSTS = new Set([
  'oapi.saramin.co.kr',
  'www.saramin.co.kr',
]);

/** @param {string} url */
function assertApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`saramin: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`saramin: URL must use HTTPS: ${url}`);
  if (!ALLOWED_SARAMIN_HOSTS.has(parsed.hostname))
    throw new Error(`saramin: untrusted hostname "${parsed.hostname}" — must be oapi.saramin.co.kr`);
  return url;
}

/**
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {{
 *   accessKey: string,
 *   keywords: string[],
 *   count: number,
 *   maxPages: number,
 *   params: URLSearchParams
 * }}
 */
function parseConfig(entry) {
  const accessKey = String(entry.access_key || '').trim();
  const keywords = Array.isArray(entry.search_keywords)
    ? entry.search_keywords.filter(k => typeof k === 'string' && k.trim())
    : [];
  const count = Math.min(MAX_PAGE_SIZE, Math.max(10, Number(entry.count) || DEFAULT_COUNT));
  const maxPages = Math.max(1, Math.min(10, Number(entry.max_pages) || DEFAULT_MAX_PAGES));

  const params = new URLSearchParams();

  // Core params
  params.set('count', String(count));
  params.set('sort', String(entry.sort || 'pd'));

  // Extra response fields
  if (entry.fields) params.set('fields', String(entry.fields));

  // Location filters (use codes from official code table)
  if (entry.location_codes) {
    const codes = Array.isArray(entry.location_codes)
      ? entry.location_codes.join(' ')
      : String(entry.location_codes);
    if (codes) params.set('loc_cd', codes);
  }
  if (entry.location_mcodes) {
    const codes = Array.isArray(entry.location_mcodes)
      ? entry.location_mcodes.join(' ')
      : String(entry.location_mcodes);
    if (codes) params.set('loc_mcd', codes);
  }
  if (entry.location_bcodes) {
    const codes = Array.isArray(entry.location_bcodes)
      ? entry.location_bcodes.join(' ')
      : String(entry.location_bcodes);
    if (codes) params.set('loc_bcd', codes);
  }

  // Employment type
  if (entry.job_type) params.set('job_type', String(entry.job_type));

  // Education level
  if (entry.edu_level) params.set('edu_lv', String(entry.edu_level));

  // Stock exchange filter
  if (entry.stock) params.set('stock', String(entry.stock));

  // Exclude headhunting
  if (entry.sr) params.set('sr', String(entry.sr));

  return { accessKey, keywords, count, maxPages, params };
}

/**
 * Convert Saramin API job object to canonical Job format.
 * @param {any} rawJob
 * @returns {{title: string, url: string, company: string, location: string, postedAt: number | undefined} | null}
 */
function normalizeJob(rawJob) {
  if (!rawJob || typeof rawJob !== 'object') return null;

  const url = String(rawJob.url || '').trim();
  if (!url) return null;

  // Validate URL is from saramin.co.kr
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('saramin.co.kr')) return null;
  } catch {
    return null;
  }

  const title = String(rawJob.position?.title || '').trim();
  if (!title) return null;

  const company = String(rawJob.company?.detail?.name || rawJob.company?.name || '').trim();
  const location = String(rawJob.position?.location?.name || '').trim();

  // Convert posting-timestamp from string seconds to epoch ms
  let postedAt;
  const ts = rawJob['posting-timestamp'];
  if (ts) {
    const ms = Number(ts) * 1000;
    postedAt = Number.isFinite(ms) ? ms : undefined;
  }

  return { title, url, company, location, ...(postedAt != null ? { postedAt } : {}) };
}

/** @type {Provider} */
export default {
  id: 'saramin',

  detect(entry) {
    if (entry.provider !== 'saramin') return null;
    return { url: API_BASE };
  },

  async fetch(entry, ctx) {
    const { accessKey, keywords, count, maxPages, params } = parseConfig(entry);

    if (!accessKey) {
      throw new Error(
        'saramin: access_key is required — register at https://oapi.saramin.co.kr/join',
      );
    }

    // Keywords come from `keywords` param (per-request, one keyword at a time)
    // OR from the shared `search_keywords` array in portals.yml
    const searchTerms = keywords.length > 0 ? keywords : [''];

    const apiUrl = `${API_BASE}/job-search`;
    assertApiUrl(apiUrl);

    const allJobs = [];

    for (const keyword of searchTerms) {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(apiUrl);

        // Auth
        url.searchParams.set('access-key', accessKey);

        // Search keyword
        if (keyword) {
          url.searchParams.set('keywords', keyword);
        }

        // Copy fixed params
        for (const [key, value] of params) {
          url.searchParams.set(key, value);
        }

        // Pagination (0-based)
        url.searchParams.set('start', String(page * count));

        /** @type {any} */
        let json;
        try {
          json = await ctx.fetchJson(url.href, {
            headers: { Accept: 'application/json' },
            redirect: 'error',
          });
        } catch (err) {
          if (page === 0) {
            // First page failure is fatal for this keyword
            console.error(`saramin: keyword "${keyword}" fetch failed — ${err.message}`);
            break;
          }
          // Later page failure: stop pagination, keep what we have
          console.error(`saramin: page ${page} fetch failed — ${err.message}`);
          break;
        }

        // Check for API error response
        if (json && json.result) {
          const code = json.result.code || json.result;
          const message = json.result.message || json.message || 'unknown error';
          if (page === 0) {
            throw new Error(`saramin API error (code ${code}): ${message}`);
          }
          console.error(`saramin: API error on page ${page} (code ${code}): ${message}`);
          break;
        }

        // Parse jobs
        const jobs = json?.jobs?.job;
        const jobArray = Array.isArray(jobs) ? jobs : (jobs ? [jobs] : []);
        const total = Number(json?.jobs?.total || 0);

        if (jobArray.length === 0) break;

        for (const rawJob of jobArray) {
          const job = normalizeJob(rawJob);
          if (job) allJobs.push(job);
        }

        // Stop if we've exhausted all results
        const fetchedSoFar = (page + 1) * count;
        if (fetchedSoFar >= total || jobArray.length < count) break;

        // Small delay between pages for rate limit courtesy
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return allJobs;
  },
};

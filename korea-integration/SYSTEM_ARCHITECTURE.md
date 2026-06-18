# System Architecture — Korea Job Portal Integration

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    career-ops v1.12.0                        │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  scan.mjs   │  │  pipeline    │  │  jobkorea-apply   │  │
│  │  (orchestr) │  │  (evaluate)  │  │  .mjs (apply)     │  │
│  └──────┬──────┘  └──────────────┘  └───────────────────┘  │
│         │                                                    │
│    ┌────┴─────────────────────────┐                         │
│    │       Provider Layer         │                         │
│    │                              │                         │
│    │  ┌──────────────────┐        │                         │
│    │  │  saramin.mjs     │  HTTP  │──→ oapi.saramin.co.kr  │
│    │  │  (REST API)      │────────│    /job-search         │
│    │  └──────────────────┘        │                         │
│    │                              │                         │
│    │  ┌──────────────────┐        │                         │
│    │  │  jobkorea.mjs    │  PW    │──→ jobkorea.co.kr     │
│    │  │  (Playwright)    │────────│    /Search/            │
│    │  └──────────────────┘        │                         │
│    └─────────────────────────────┘                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Data Layer                                          │   │
│  │  data/pipeline.md    ← 공고 inbox                     │   │
│  │  data/scan-history.tsv ← dedup 이력                   │   │
│  │  data/applications.md ← 지원 트래커                    │   │
│  │  data/jobkorea-applications.tsv ← JobKorea 지원 이력   │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Saramin Provider (`providers/saramin.mjs`)

```
┌─────────────────────────────────────────────────┐
│ saramin.mjs                                     │
│                                                 │
│ detect(entry) → provider: saramin 확인          │
│                                                 │
│ fetch(entry, ctx)                               │
│ ├── parseConfig()                               │
│ │   ├── access_key                              │
│ │   ├── search_keywords[]                       │
│ │   ├── count (10~110, default 50)              │
│ │   ├── max_pages (1~10, default 2)             │
│ │   └── params (loc_cd, job_type, sort, etc.)  │
│ ├── for each keyword:                           │
│ │   for each page:                              │
│ │     ├── GET /job-search?access-key=...        │
│ │     ├── parse JSON response                   │
│ │     │   └── normalizeJob() → {title,url,      │
│ │     │       company,location,postedAt}        │
│ │     └── stop if exhausted or error             │
│ └── return Job[]                                 │
└─────────────────────────────────────────────────┘
```

**API Response → Job Mapping:**

```
Saramin JSON                              career-ops Job
─────────────                             ──────────────
job.position.title              →         title
job.url                         →         url (URL 검증)
job.company.detail.name         →         company
job.position.location.name      →         location
job.posting-timestamp × 1000    →         postedAt (epoch ms)
```

**Error Handling:**

| API Code | Provider 동작 |
|----------|--------------|
| 1 (no key) | throw — 안내 메시지 |
| 2 (invalid key) | throw |
| 3 (bad param) | throw |
| 4 (rate limit) | throw |
| 99 (server error) | throw |
| HTTP error page 1 | throw (키워드 건너뜀) |
| HTTP error page N | break (수집 결과 반환) |

---

### 2. JobKorea Provider (`providers/jobkorea.mjs`)

```
┌─────────────────────────────────────────────────┐
│ jobkorea.mjs                                    │
│                                                 │
│ detect(entry) → provider: jobkorea 확인         │
│                                                 │
│ fetch(entry)                                    │
│ ├── parseConfig()                               │
│ │   ├── search_keywords[]                       │
│ │   ├── location_filter[]                       │
│ │   └── pages (1~10, default 1)                 │
│ ├── chromium.launch(headless:true)              │
│ ├── context = browser.newContext({locale:ko})   │
│ ├── for each keyword:                           │
│ │   for each page:                              │
│ │     ├── page.goto(Search/?stext=...)          │
│ │     ├── wait 4s hydration                     │
│ │     ├── extractJobs() — page.evaluate()       │
│ │     │   ├── querySelectorAll(a[href*=GI_Read])│
│ │     │   ├── card = link.closest([class*=p-7]) │
│ │     │   ├── title: span.font-semibold         │
│ │     │   ├── company: span.truncate            │
│ │     │   └── location: span[class*=text-gray]  │
│ │     ├── cleanUrl() — strip listno, sc params  │
│ │     ├── location filter                       │
│ │     └── dedup                                 │
│ └── return Job[]                                 │
└─────────────────────────────────────────────────┘
```

**HTML Selectors (2026-06 기준 Tailwind React SPA):**

```
Card Container:  div[class*="p-7"]  (closest from recruit link)
Title Link:      span.font-semibold.text-gray900
Company Name:    span.truncate (not inside title link)
Location:        span[class*="text-gray"] matching Korean district pattern
URL:             a[href*="Recruit/GI_Read"] → cleanUrl()
```

**Browser Context:**
```js
{
  locale: 'ko-KR',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
}
```

---

### 3. JobKorea Auto-Apply (`jobkorea-apply.mjs`)

```
┌─────────────────────────────────────────────────────┐
│ jobkorea-apply.mjs                                  │
│                                                     │
│ main()                                              │
│ ├── parseArgs() — --url, --report, --dry-run, etc. │
│ ├── loadProfile()                                   │
│ │   ├── config/profile.yml                          │
│ │   ├── config/jobkorea-profile.yml                 │
│ │   └── cv.md                                       │
│ ├── findReport(# or company)                        │
│ ├── createBrowser(headless)                         │
│ ├── ensureLoggedIn(page, jkProfile)                 │
│ │   ├── goto(jobkorea.co.kr)                        │
│ │   ├── check login state (DOM)                     │
│ │   ├── if not logged in:                           │
│ │   │   ├── goto login page                         │
│ │   │   ├── fill id/pw                              │
│ │   │   ├── CAPTCHA detection                       │
│ │   │   └── submit + wait redirect                  │
│ │   └── return boolean                              │
│ ├── goto job URL                                    │
│ ├── click apply button (multi-selector fallback)    │
│ ├── detectFormFields(page)                          │
│ │   └── page.evaluate() → field[] {                 │
│ │       selector, tag, type, name, id,              │
│ │       label, placeholder, required,               │
│ │       category (16 classifications),              │
│ │       options (for selects)                       │
│ │     }                                             │
│ ├── fillForm(fields, ...)                           │
│ │   ├── resolveFieldValue(field) → value            │
│ │   │   ├── name/email/phone → jkProfile            │
│ │   │   ├── education/career → jkProfile            │
│ │   │   ├── self_intro/motivation → generateEssay() │
│ │   │   ├── consent → auto-check (confirm needed)   │
│ │   │   └── preferential → needsConfirm             │
│ │   └── Playwright fill/selectOption/check          │
│ ├── displayPreflight(results)                       │
│ ├── [dry-run: return]                               │
│ ├── wait for user confirmation                      │
│ └── submit + record in tracker                      │
└─────────────────────────────────────────────────────┘
```

**Field Classification Categories:**

| Category | Source | Needs Confirm |
|----------|--------|--------------|
| name, email, phone, birth | jobkorea-profile.yml | No |
| address, education, career | jobkorea-profile.yml | No |
| salary | jobkorea-profile.yml | **Yes** |
| self_intro, motivation | cv.md + report (generated) | No |
| portfolio, skills, license | jobkorea-profile.yml + cv.md | No |
| language, hobby | jobkorea-profile.yml | No |
| preferential | — | **Yes** |
| consent | auto | **Yes** |

**Exported API:**
```js
export {
  loadProfile,        // → { profile, jkProfile, cv }
  findReport,         // → { num, path, content } | null
  detectFormFields,   // → Promise<Field[]>
  resolveFieldValue,  // → { value, source, needsConfirm }
  generateEssayResponse, // → string (Korean)
};
```

---

## Data Flow

```
portals.yml           scan.mjs          Provider           External
──────────            ────────           ────────           ────────
tracked_companies ──→ resolveProvider ──→ saramin.fetch ──→ oapi.saramin.co.kr
job_boards        ──→                  ──→ jobkorea.fetch ─→ jobkorea.co.kr
                           │
                    ┌──────┴──────┐
                    │  title/loc  │
                    │  filter     │
                    │  dedup      │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │ pipeline.md │  ← 신규 공고
                    │ scan-hist   │  ← dedup 이력
                    └─────────────┘
```

---

## Security Considerations

### Saramin
- access-key는 portals.yml에 평문 저장 (gitignore 권장)
- HTTPS only (`ALLOWED_SARAMIN_HOSTS` 검증)
- redirect: 'error' — SSRF 방지

### JobKorea
- URL hostname white-list (`JOBKOREA_BASE` 검증)
- `cleanUrl()` — tracking params 제거
- `--no-sandbox` flag (CI/CD 환경)

---

## Performance

| Metric | Saramin | JobKorea |
|--------|---------|----------|
| Request/response | ~200ms | ~15s (headless browser) |
| Results/page | 10~110 | ~20 (variable) |
| Token usage | Zero (HTTP only) | Zero (no LLM) |
| Memory | ~30MB | ~400MB (Chromium) |
| 페이지 간 delay | 100ms | 2~4s jittered |

---

## Dependencies

```
career-ops v1.12.0
├── Node.js ≥ 18
├── playwright (JobKorea only)
│   └── chromium
├── js-yaml
└── fs, path, url (std)
```

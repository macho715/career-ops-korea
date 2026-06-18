# Korea Job Portal Integration

career-ops 기반 한국 채용포털(JobKorea·Saramin) 자동화 통합 모듈.

- **개발일**: 2026-06-18
- **기반**: career-ops v1.12.0
- **대상**: JobKorea (jobkorea.co.kr) / Saramin (saramin.co.kr)

---

## 기능

| 기능 | JobKorea | Saramin |
|------|----------|---------|
| 채용공고 스캔 | Playwright headless | 공식 REST API |
| 자동 지원서 작성 | Playwright form fill | — (추후 개발) |
| pipeline 연동 | `node scan.mjs --company "JobKorea"` | `node scan.mjs --company "Saramin"` |
| 속도 | ~15s/페이지 | ~200ms/페이지 |
| 법적 리스크 | 있음 (이용약관 확인 필요) | 없음 (공식 API) |

---

## 빠른 시작

### 1. Saramin (권장 — 공식 API)

```bash
# access-key 발급 (무료)
# → https://oapi.saramin.co.kr/join

# portals.yml 수정
#   - name: Saramin
#     access_key: "발급받은키"
#     enabled: true

# 스캔 실행
node scan.mjs --company "Saramin"
```

### 2. JobKorea (Playwright 기반)

```bash
# portals.yml 수정
#   - name: JobKorea
#     enabled: true

# 스캔 실행
node scan.mjs --company "JobKorea"

# 자동지원
node jobkorea-apply.mjs --report {#} --dry-run    # 미리보기
node jobkorea-apply.mjs --report {#} --headless=false  # 실제지원
```

---

## 디렉터리 구조

```
career-ops/
├── providers/
│   ├── saramin.mjs           # Saramin 공식 API provider
│   └── jobkorea.mjs          # JobKorea Playwright provider
├── jobkorea-apply.mjs        # JobKorea 자동지원 스크립트
├── config/
│   └── jobkorea-profile.yml.example  # 지원서 자동완성 설정
├── modes/
│   └── jobkorea.md           # JobKorea 통합 모드 문서
├── portals.yml               # 포털 설정 (+ JobKorea/Saramin)
├── korea-integration/        # 본 문서 폴더
│   ├── README.md
│   ├── CHANGELOG.md
│   ├── SYSTEM_ARCHITECTURE.md
│   ├── scripts/
│   └── providers/
└── data/
    ├── pipeline.md           # 공고 pipeline
    ├── jobkorea-applications.tsv
    └── scan-history.tsv
```

---

## 설정 파일

### portals.yml (JobKorea)

```yaml
- name: JobKorea
  provider: jobkorea
  search_keywords:
    - "AI 엔지니어"
    - "머신러닝"
    - "데이터 엔지니어"
  location_filter:
    - "서울"
    - "경기"
  pages: 1
  enabled: true
```

### portals.yml (Saramin)

```yaml
- name: Saramin
  provider: saramin
  access_key: "YOUR_KEY"
  search_keywords:
    - "AI 엔지니어"
    - "머신러닝"
  count: 50
  max_pages: 2
  sort: "pd"
  enabled: true
```

---

## 주의사항

### JobKorea

- Playwright Chromium 필수 (`npx playwright install chromium`)
- 자동지원 시 `config/jobkorea-profile.yml` 필요
- **법적 리스크**: 사람인 vs 잡코리아 소송 판례 있음 (120억원)
- 개인 구직 용도로만 사용 권장

### Saramin

- access-key 등록 필요 (무료)
- 일일 500회 요청 제한
- 공식 문서: https://oapi.saramin.co.kr/guide/job-search
- 지역/직무 코드표: https://oapi.saramin.co.kr/guide/code-table2

---

## 워크플로우

```
portals.yml 설정
        │
        ▼
┌──────────────────┐
│ node scan.mjs    │  ← 공고 스캔 (JobKorea/Saramin)
│ --company "..."  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ data/pipeline.md │  ← 신규 공고 적재
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ /career-ops      │  ← 공고 평가 (cv.md 필요)
│ pipeline         │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ jobkorea-apply   │  ← 자동 지원 (로그인 필요)
│ .mjs --report #  │
└──────────────────┘
```

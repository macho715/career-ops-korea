# CHANGELOG

## 2026-06-18 — Initial Release

### Added

#### Saramin Provider (`providers/saramin.mjs`)
- 공식 REST API 기반 provider (no scraping)
- access-key 인증, 페이지네이션, 다중 키워드 지원
- JSON 응답 → 표준 Job[] 정규화
- 에러 코드 처리 (1~4, 99)
- 일일 500회 요청 제한 준수

#### JobKorea Provider (`providers/jobkorea.mjs`)
- Playwright headless 기반 스크래퍼
- Tailwind React SPA 셀렉터 (2026년 6월 구조 기준)
- 다중 키워드, 페이지네이션, 위치 필터
- URL tracking param 제거 및 dedup
- 실제 검증: 90건 검색 → 22건 유니크 추출

#### JobKorea Auto-Apply (`jobkorea-apply.mjs`)
- Playwright 기반 JobKorea 지원서 자동 작성
- 9단계 워크플로우 (Login → Navigate → Detect → Fill → Preflight → Submit)
- 폼 필드 자동 감지 및 분류 (16개 카테고리)
- `config/jobkorea-profile.yml` 기반 자동완성
- `--dry-run` 모드 (미리보기)
- `--headless=false` 디버그 모드
- 한국어 자기소개서/지원동기 생성

#### Configuration
- `config/jobkorea-profile.yml.example` — 지원서 설정 템플릿
- `portals.yml` — JobKorea + Saramin 항목
- `templates/portals.example.yml` — 템플릿 업데이트

#### Documentation
- `modes/jobkorea.md` — 통합 모드 문서
- `korea-integration/README.md` — 통합 매뉴얼
- `korea-integration/CHANGELOG.md` — 본 파일
- `korea-integration/SYSTEM_ARCHITECTURE.md` — 아키텍처

#### Integration
- `AGENTS.md` — skill mode table에 `jobkorea` 추가
- `scan.mjs` 호환성 확인 완료

### Technical Details

#### JobKorea Site Analysis
- 2026년 6월 기준: Next.js/React SPA + Tailwind CSS
- 카드 구조: `div.flex.w-full.gap-5.p-7`
- 제목: `span.font-semibold.text-gray900`
- 회사명: `span.truncate` (비-제목)
- 지역: `span[class*="text-gray"]` + 한글 지역 패턴

#### Saramin API
- Endpoint: `GET https://oapi.saramin.co.kr/job-search`
- Auth: `access-key` query param
- Response: JSON (`Accept: application/json`)
- Max: 110 results/page, 500 req/day

### Known Issues

1. JobKorea 자동지원은 로그인 필요 (비로그인 시 지원 버튼 숨김)
2. `cv.md` 미생성 (평가/PDF 생성 불가)
3. `config/jobkorea-profile.yml` 미생성 (자동지원 데이터 없음)
4. JobKorea 법적 리스크 확인 필요

### Next

- [ ] Saramin 자동지원 기능 개발
- [ ] `cv.md` 생성 유도
- [ ] JobKorea 이용약관 법적 검토
- [ ] CI/CD에 Playwright 테스트 추가

# Mode: jobkorea — JobKorea 자동 스캔 + 지원

JobKorea(jobkorea.co.kr) 전용 모드. 채용공고 스캔 → 파이프라인 평가 → 자동 지원서 작성까지 통합 워크플로우.

## Prerequisites

- Playwright Chromium: `npx playwright install chromium`
- JobKorea 로그인 계정 (자동지원 시 필요)
- `config/jobkorea-profile.yml` 설정 완료 (지원서 자동완성 데이터)

## Commands

```
/career-ops jobkorea scan            → JobKorea 채용공고 스캔
/career-ops jobkorea scan --verify    → 스캔 + 공고 유효성 확인
/career-ops jobkorea pipeline         → 스캔된 공고 일괄 평가
/career-ops jobkorea apply {#}        → {#}번 공고 자동지원
/career-ops jobkorea apply --dry-run  → 지원서 미리보기만 (제출 X)
/career-ops jobkorea status           → JobKorea 지원 현황
```

---

## Phase 1 — SCAN: 채용공고 수집

### Prerequisites Check
1. `portals.yml`에 `provider: jobkorea` 항목 존재 확인
2. `search_keywords` 설정 확인
3. Playwright Chromium 설치 확인

### Execution
```bash
node scan.mjs --company "JobKorea"
```

신규 공고는 `data/pipeline.md` ## Pendientes에 추가됨.

### Keyword 추천
`cv.md`와 `config/profile.yml`의 target_roles를 기준으로 검색 키워드 자동 생성:
- 1차 키워드: target_roles.primary
- 2차 키워드: target_roles.archetypes[].name
- 3차 키워드: superpowers 연관 키워드

사용자에게 키워드 확인 후 `portals.yml` 업데이트.

### Scan 후
```
✓ N개 신규 공고 발견
→ /career-ops jobkorea pipeline 으로 일괄 평가 가능
```

---

## Phase 2 — PIPELINE: 공고 평가

`data/pipeline.md`에 쌓인 JobKorea 공고에 대해 일반 auto-pipeline과 동일하게 평가.

```bash
# batch/batch-runner.sh 또는 직접 평가
```

평가 완료 후:
- `reports/`에 평가 보고서 생성
- `data/applications.md`에 트래커 추가
- Score >= auto_pdf_score_threshold 이면 PDF CV 생성

---

## Phase 3 — APPLY: 자동 지원서 작성

### Step 1: Context Loading

대상 공고 정보 로드:
1. `data/applications.md`에서 지원할 공고 #번호 확인
2. `reports/{#}-*.md` 평가 보고서 로드
3. `config/jobkorea-profile.yml`에서 지원자 정보 로드
4. `cv.md`에서 경력/기술 정보 로드
5. `config/profile.yml`에서 기본 프로필 로드

### Step 2: JobKorea Login

**Login check (Playwright):**

```javascript
// Navigate to JobKorea
await page.goto('https://www.jobkorea.co.kr/');
// Check if logged in (look for user menu / logout button)
const isLoggedIn = await page.evaluate(() => {
  return !!document.querySelector('.my-page, .user-info, .logout, a[href*="Logout"]');
});
```

**If NOT logged in:**
> "JobKorea 로그인이 필요합니다. 아래 방법 중 선택:  
> 1. 로그인 정보를 `config/jobkorea-profile.yml`에 저장 (권장)  
> 2. 브라우저에서 직접 로그인 후 이어서 진행"

Login flow:
1. `config/jobkorea-profile.yml`에서 `jobkorea.id` / `jobkorea.password` 읽기
2. ID/PW 입력 후 로그인 버튼 클릭
3. CAPTCHA 발생 시 사용자에게 직접 해결 요청

### Step 3: Navigate to Job Posting

```javascript
await page.goto(jobUrl);  // from applications.md / report
// Wait for page to load
await page.waitForSelector('.coInfo, .detailContent, .readContent', { timeout: 10000 });
```

### Step 4: Click Apply Button

JobKorea 지원 버튼 패턴:
- `.btnApply, .btn-apply, a[href*="Apply"], .btnGSubmit` 
- `button:has-text("지원하기"), button:has-text("온라인 지원"), button:has-text("간편지원")`
- `a:has-text("지원하기")`

```javascript
// Find and click apply button
const applyBtn = await page.$('.btnApply, .btn-apply, a.btnGSubmit, button:has-text("지원")');
if (applyBtn) {
  await applyBtn.click();
  await page.waitForLoadState('domcontentloaded');
} else {
  // Some roles use inline forms — check for form on same page
  const form = await page.$('.apply-form, .popApply, #applyForm');
  if (!form) throw new Error('지원 폼을 찾을 수 없습니다.');
}
```

### Step 5: Extract Form Fields

JobKorea 지원 폼 주요 필드 패턴:

| Form Section | Selectors | Source |
|---|---|---|
| 이름 | `input[name*="name"]` | `config/jobkorea-profile.yml` |
| 이메일 | `input[name*="email"], input[type="email"]` | `config/profile.yml` |
| 전화번호 | `input[name*="phone"], input[name*="tel"]` | `config/jobkorea-profile.yml` |
| 생년월일 | `input[name*="birth"]` | `config/jobkorea-profile.yml` |
| 주소 | `input[name*="addr"]` | `config/jobkorea-profile.yml` |
| 최종학력 | `select[name*="education"], select[name*="school"]` | `config/jobkorea-profile.yml` |
| 경력 | `select[name*="career"], select[name*="experience"]` | `cv.md` |
| 희망연봉 | `input[name*="salary"], input[name*="hope"]` | `config/profile.yml` |
| 자기소개서 | `textarea[name*="intro"], textarea[name*="cover"], textarea[name*="self"]` | Generated (Block F + JD 매칭) |
| 지원동기 | `textarea[name*="motivation"], textarea[name*="why"]` | Generated (Block B + CV proof points) |
| 포트폴리오 | `input[name*="portfolio"], input[name*="url"]` | `config/profile.yml` |
| 기술스택 | `input[name*="skill"], textarea[name*="skill"]` | `cv.md` |
| 자격증 | `input[name*="license"]` | `cv.md` |
| 어학 | `select[name*="lang"]` | `config/jobkorea-profile.yml` |
| 취업우대 | `input[type="checkbox"][name*="veteran"], input[type="checkbox"][name*="protect"]` | Ask user |
| 개인정보동의 | `input[type="checkbox"][name*="agree"], input[type="checkbox"][name*="privacy"]` | Auto-check with user confirm |

### Step 6: Generate 응답 Content

#### 자기소개서 (Self-Introduction)
한국어로 작성. 구조:
```
[지원 동기]
- JD 요구사항과 본인 경험 매칭
- Block B (CV match) 기반 구체적 예시

[주요 성과]
- cv.md의 proof points 1-2개
- 정량적 성과 강조

[입사 후 계획]
- Block F (STAR stories) 기반
- 회사/팀에 기여할 구체적 방안
```

#### 지원동기 (Why This Company)
```
- Block A (Role Summary) 내용 활용
- Block D (Comp Research) 기반 회사 이해도 표현
- "왜 이 회사인가" — 구체적 이유
```

#### 추가질문 (Custom Questions)
JD 하단 추가 질문에 대해:
- 질문 유형 분류 (경험, 기술, 태도, 상황)
- cv.md + reports/ 평가 결과 기반 응답 생성
- `config/jobkorea-profile.yml`의 `custom_answers` 참조

### Step 7: PREFLIGHT Gate — Fill & Review

지원서 작성 완료 후, 제출 전 반드시:

1. **전체 필드 값 표시** — 사용자 검토용 테이블 출력:
```
| 필드 | 입력값 | 출처 |
|------|--------|------|
| 이름 | 홍길동 | jobkorea-profile.yml |
| 이메일 | hong@example.com | profile.yml |
| 자기소개서 | (전문) | cv.md + report #023 |
| 지원동기 | (전문) | report #023 Block A |
...
```

2. **WARNING 필드 하이라이트**:
   - 법적/인구통계 필드 (취업우대, 보훈)
   - 연봉 필드
   - 개인정보 동의

3. **사용자 확인 질문**:
> "총 {N}개 필드가 작성되었습니다. 위 내용을 검토하신 후 진행을 선택해주세요:  
> - '제출' — 바로 지원서 제출  
> - '수정' — 특정 필드 수정  
> - '취소' — 지원 중단"

### Step 8: Submit

```javascript
// Click final submit button
const submitBtn = await page.$('button:has-text("제출"), button:has-text("지원완료"), .btnSubmit, input[type="submit"]');
if (submitBtn) {
  await submitBtn.click();
  await page.waitForLoadState('domcontentloaded');
}
```

### Step 9: Post-Submit

1. 지원 완료 페이지 캡처/확인
2. `data/applications.md` 상태 업데이트: `Evaluated` → `Applied`
3. `data/jobkorea-applications.tsv`에 지원 기록 추가:
   ```
   date	company	role	report#	score	result
   ```
4. 확인 메시지:
> "✓ {회사명} — {직무명} 지원 완료 (#{N})  
> → 지원일: {date}  
> → 다음 추천: `/career-ops contacto` 로 LinkedIn 아웃리치"

---

## JobKorea Form Field Mapping — 상세

### 직무별 추가 필드 (Role-Specific)

JobKorea는 채용공고마다 커스텀 질문을 추가할 수 있음. 발견 시:

1. 질문 텍스트 추출
2. 질문 유형 분류:
   - **경험 질문**: "해당 직무 관련 경험을 기술해주세요" → cv.md 경력
   - **기술 질문**: "사용 가능한 프로그래밍 언어를 선택하세요" → cv.md Skills
   - **상황 질문**: "프로젝트 중 갈등 해결 경험을 기술해주세요" → STAR stories
   - **에세이 질문**: "지원 분야에 대한 본인의 생각을 서술하세요" → Generated
3. `config/jobkorea-profile.yml`의 `custom_answers` 맵 확인 (반복 질문 대응)
4. AI 응답 생성

### 필드별 기본값 매핑

| config key | JobKorea field name patterns |
|---|---|
| `jobkorea.id` | `id`, `user_id`, `login_id` |
| `jobkorea.password` | `pw`, `password`, `user_pw` |
| `jobkorea.name_kor` | `name`, `user_name`, `name_kor` |
| `jobkorea.email` | `email`, `mail`, `user_email` |
| `jobkorea.phone` | `phone`, `tel`, `mobile`, `cell_phone` |
| `jobkorea.birth` | `birth`, `birthday`, `birth_date` |
| `jobkorea.address` | `addr`, `address`, `zipcode` |
| `jobkorea.education.level` | `edu`, `education`, `school_level`, `final_edu` |
| `jobkorea.education.school` | `school`, `univ`, `college`, `graduated_school` |
| `jobkorea.education.major` | `major`, `department`, `specialty` |
| `jobkorea.career.total_years` | `career`, `experience`, `total_career`, `work_year` |
| `jobkorea.career.recent_company` | `company`, `current_company`, `recent_corp` |
| `jobkorea.salary.hope` | `salary`, `hope_salary`, `desired_salary`, `pay` |
| `jobkorea.language.english` | `eng`, `english`, `toeic`, `toefl`, `opic` |
| `jobkorea.hobbies` | `hobby`, `interest`, `specialty_etc` |

---

## Error Handling

### CAPTCHA 감지
```javascript
const hasCaptcha = await page.$('iframe[src*="captcha"], .g-recaptcha, #captcha, img[src*="captcha"]');
if (hasCaptcha) {
  // Pause and ask user
  throw new Error('CAPTCHA detected — user must solve manually');
}
```

### Session Expired
```javascript
const isExpired = await page.$('.login-form, #loginForm, .alert:has-text("로그인")');
if (isExpired) {
  await reLogin(page);
  // Retry current step
}
```

### 알 수 없는 폼 구조
새로운 폼 레이아웃 발견 시:
- 스크린샷 저장 → `data/jobkorea-unknown-forms/`
- 필드 정보 수동 매핑 요청
- 추후 동일 패턴 자동 대응 (학습)

---

## JobKorea 트래커

`data/jobkorea-applications.tsv`:
```
date	company	role	url	report_num	score	result	notes
2026-06-18	삼성	AI엔지니어	https://...	#042	4.2/5	Applied	
```

`analyze-patterns.mjs` 연동:
```bash
node analyze-patterns.mjs --source jobkorea
```

---

## Safety Rules

1. **NEVER auto-submit without user review** — Step 7 PREFLIGHT gate 필수
2. **Rate limiting** — 지원 간 최소 30초 간격
3. **로그인 실패 3회 시 중단** — 계정 잠김 방지
4. **대량 지원 경고** — 세션당 10건 초과 시 확인
5. **Score < 3.0 지원 권장하지 않음** — 윤리적 사용

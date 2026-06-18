# JobKorea 사이트 구조 매핑 (2026-06-18 실측)

## 기술 스택

Next.js (React SPA) + Tailwind CSS + Sentry (컴포넌트 추적)
- `data-sentry-component`, `data-sentry-source-file` 속성으로 React 컴포넌트 추적 가능
- 모든 CSS는 Tailwind 유틸리티 클래스 (시맨틱 클래스 없음)
- SPA — 초기 HTML은 빈 셸, JS 실행 후 렌더링

---

## 1. 검색 결과 페이지

**URL**: `https://www.jobkorea.co.kr/Search/?stext={검색어}&Page_No={페이지}&tabType=recruit`

### 카드 컨테이너

```
div.flex.w-full.gap-5.p-7    ← 메인 카드 (Tailwind: flex, full-width, 28px gap, 28px padding)
```

### 제목

```
div.mb-0.5 > a > span.truncate.font-semibold.text-typo-b1-18.text-gray900
```

계층: `card → div.mb-0.5 → a[href*="Recruit/GI_Read"] → span.font-semibold.text-gray900`

### 회사명

```
span.mb-5.inline-flex.items-center.gap-[6px] > a > span.truncate.text-gray700.text-typo-b2-16
```

회사명은 `span.truncate` 중 타이틀이 아닌 것.  
구분법: 타이틀은 `.font-semibold.text-gray900`, 회사명은 `.text-gray700`

### 지역

```
span[class*="text-gray"]  (길이 < 20자, 한글 지역 패턴)
```

지역 패턴: `[가-힣]+ [가-힣]+[시군구]` 또는 `[가-힣]+ [가-힣]+ [가-힣]+`

### URL

```
a[href*="Recruit/GI_Read"]  →  절대 URL (jobkorea.co.kr/Recruit/GI_Read/{id})
```

URL 파라미터 중 추적용은 제거: `listno`, `sc`, `logpath`

### 페이지네이션

- 현재 발견된 셀렉터: `[class*="pagination"]` (정확한 구조는 동적)
- 각 페이지 URL: `&Page_No=N`
- 결과 없으면 빈 페이지 (카드 0개)

### 총 검색결과 (h1)

```html
<title>'AI 엔지니어' 관련 📢 채용공고 | 총 2,239건의 검색결과</title>
```

페이지 타이틀에서 추출: `/총 ([\d,]+)건/`

### 광고/프리미엄 공고

- 일부 카드는 `data-sentry-component="AdBanner"` 또는 별도 광고 마커
- 광고는 `Recruit/GI_Read` 대신 다른 URL 패턴 사용
- 필터링: `a[href*="Recruit/GI_Read"]` 있는 카드만

---

## 2. 공고 상세 페이지

**URL**: `https://www.jobkorea.co.kr/Recruit/GI_Read/{id}`

### 공고 제목

비로그인 시 정확한 셀렉터 미확인 (페이지 렌더링 후 JS 필요).  
로그인 후 추정: `h1`, `[class*="view_tit"]`, `[class*="co_title"]`

### 기업명

로그인 필요. 추정 경로: `[class*="company"]`, `[class*="corp"]`

### JD 본문

로그인 필요. 추정: `[class*="readContent"]`, `[class*="detailContent"]`, `article`

### 메타 정보 (비로그인도 확인 가능)

```
마감일: ~06.26 (금)  →  "즉시 지원" 버튼 텍스트 주변
```

### 지원 버튼

```
button.inline-flex.items-center.justify-center.flex-shrink-0.whites (텍스트: "즉시 지원")
```

- `button:has-text("즉시 지원")` — 다수 검출됨 (목록 + 상세 각각)
- 비로그인: 버튼은 보이지만 클릭 시 로그인 페이지로 리디렉트
- 로그인: 팝업/탭 열림 → 지원 폼

---

## 3. 지원 폼 페이지

비로그인 시 확인 불가. 로그인 후 구조 추정:

### 폼 컨테이너

```
.popApply, #applyForm, .apply-form, .section_write, form[name="apply"]
```

### 필드 분류 (16개 카테고리)

| 카테고리 | 예상 필드명 패턴 | 유형 |
|----------|-----------------|------|
| name | input[name*="name"] | text |
| email | input[type="email"], input[name*="email"] | email |
| phone | input[name*="phone"], input[name*="tel"] | tel |
| birth | input[name*="birth"] | text/number |
| address | input[name*="addr"], input[name*="zipcode"] | text |
| education | select[name*="edu"], select[name*="school"] | select |
| career | select[name*="career"], select[name*="exp"] | select |
| salary | input[name*="salary"], input[name*="hope"] | number |
| self_intro | textarea[name*="intro"], textarea[name*="cover"] | textarea |
| motivation | textarea[name*="motivation"] | textarea |
| portfolio | input[name*="portfolio"], input[name*="url"] | url |
| skills | input[name*="skill"], textarea[name*="skill"] | text |
| license | input[name*="license"] | text |
| language | select[name*="lang"], input[name*="english"] | select/text |
| preferential | input[type="checkbox"][name*="veteran"] | checkbox |
| consent | input[type="checkbox"][name*="agree"] | checkbox |

---

## 4. 로그인 페이지

**URL**: `https://www.jobkorea.co.kr/Login/Login_Tot.asp?rDBName=GG`

### 로그인 접근

- 메인 페이지 → "회원가입/로그인" 링크
- 비로그인 지원 클릭 → 로그인 페이지 리디렉트

### 로그인 폼 (추정)

```
input[name="mber_id"]     ← 아이디
input[name="mber_pw"]     ← 비밀번호
button[type="submit"]     ← 로그인 버튼
```

---

## 5. 크롤링 시 필요 정보

### 필수

| 항목 | 값 |
|------|-----|
| 검색 URL | `/Search/?stext={keyword}&Page_No={page}&tabType=recruit` |
| 카드 컨테이너 | `div[class*="p-7"]` (closest from recruit link) |
| 공고 링크 | `a[href*="Recruit/GI_Read"]` |
| 공고 제목 | `span.font-semibold.text-gray900` |
| 회사명 | `span.truncate` (not inside title link) |
| 지역 | `span[class*="text-gray"]` + 한글 패턴 매칭 |
| 브라우저 | `locale: ko-KR`, Windows Chrome UA |

### 페이지당 추출량

- 한 페이지 약 20개 공고
- 총 65개 `Recruit/GI_Read` 링크 (중복 포함)
- 중복 제거 후 약 20~22개 유니크 공고

### URL 정규화

```
원본: /Recruit/GI_Read/49408833?Oem_Code=C1&logpath=1&stext=...&listno=1&sc=552
정규화: https://www.jobkorea.co.kr/Recruit/GI_Read/49408833?Oem_Code=C1&stext=...
```

제거할 파라미터: `listno`, `sc`, `logpath`

### 지연 시간

| 구간 | 권장 |
|------|------|
| 페이지 로딩 대기 | 3~4초 |
| 페이지 간 지터 | 2~4초 |
| 검색어 변경 간 | 5초 |

---

## 6. 주의사항

| 이슈 | 대응 |
|------|------|
| SPA 구조 | `waitUntil: 'domcontentloaded'` + 추가 3~4초 대기 |
| Headless 탐지 | Chrome 122+ UA + `navigator.webdriver = false` |
| 동적 카드 | `waitForSelector('a[href*="Recruit/GI_Read"]')` |
| 중복 URL | `cleanUrl()` + `Set` dedup |
| 빈 페이지 | 카드 0개 → 키워드 검색 종료 |
| CAPTCHA | 로그인 시에만 발생 가능 |

---

## 7. 실제 추출 예시

```
검색어: "AI 엔지니어"
결과: 2,239건
수집: 22건/페이지 (중복 제거 후)
추출 예:
  { title: "AI 엔지니어",
    url: "https://www.jobkorea.co.kr/Recruit/GI_Read/49333079?Oem_Code=C1&stext=...",
    company: "㈜에스원",
    location: "서울 중구" }
```

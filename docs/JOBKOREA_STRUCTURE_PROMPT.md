# JobKorea 구조 매핑 완료

## 필요 요소 요약

크롤링에 필요한 6가지 구조:

### 1. 검색 URL
```
https://www.jobkorea.co.kr/Search/?stext={검색어}&Page_No={페이지}&tabType=recruit
```

### 2. 카드 컨테이너
```
div[class*="p-7"]    ← Tailwind padding 유틸 클래스
```
찾는 법: `a[href*="Recruit/GI_Read"]` → `closest('[class*="p-7"]')`

### 3. 제목
```
div.mb-0.5 > a > span.truncate.font-semibold.text-gray900
```

### 4. 회사명
```
span.inline-flex > a > span.truncate (text-gray700, not font-semibold)
```

### 5. 지역
```
span[class*="text-gray"] + 한글 지역 정규식 매칭
```

### 6. URL 정규화
```
listno, sc, logpath 파라미터 제거
```

## 상세 문서

`docs/JOBKOREA_STRUCTURE.md` — 전체 7섹션 매핑 완료:
- 검색 결과 페이지 (URL, 카드, 제목, 회사명, 지역, URL, 페이지네이션)
- 공고 상세 페이지 (제목, 기업명, JD, 메타, 지원버튼)
- 지원 폼 (16개 필드 카테고리)
- 로그인 페이지
- 실제 추출 예시 (AI 엔지니어 → 22건)

## 브라우저 설정

```js
{
  locale: 'ko-KR',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
}
navigator.webdriver = false
```

## 지연

| 항목 | 시간 |
|------|------|
| 페이지 로딩 | 3~4초 |
| 페이지 간 | 2~4초 (jitter) |
| 검색어 변경 | 5초 |

---

**GitHub**: `docs/JOBKOREA_STRUCTURE.md`

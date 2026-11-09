# arcrush-sim — BIM 공정 시뮬레이터 v0.1

IFC 모델을 브라우저에서 열어(web-ifc, 서버 없음) 층·부재 종류 규칙으로 공정 순서를 만들고 타임라인으로 재생한다.
현장 경험에서 나온 질문 — "도면은 완성된 건물을 그리는데 현장은 순서로 움직인다. 설계안에서 공정을 자동으로 읽을 수 없을까?" — 에 대한 v0.1 답.

- 스택: Vite + TypeScript + Three.js + web-ifc 0.0.78 (MPL-2.0)
- 샘플: Duplex Apartment (IFC2X3, buildingSMART/NIBS 원본, 라이선스 문구 미확인), AC20-FZK-Haus (IFC4, KIT, unrestricted use)
- 공정 값은 개념 기본값이며 UI에서 조정한다. 수량·생산성 산출을 거친 공기가 아니다.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # dist/ → Cloudflare Pages (sim.arcrush.kr)
```

## 구조
- `src/ifc.ts` IFC 로드, 층 해석(ContainedInSpatialStructure + Aggregates), 메시 생성
- `src/schedule.ts` 공종 매핑 규칙, 작업 그래프, 위상정렬·전진 계산, 요소별 start/end
- `src/viewer.ts` Three.js 장면, 상태별 재질(진행/양생/완료/예정 윤곽), 피킹
- `src/main.ts` UI(공정표, 규칙 패널, 타임라인)

## 다음(v0.2)
- 내 IFC 업로드를 Web Worker로, 100MB 가드(현재 메인 스레드)
- 규칙 테이블 편집 UI, 미분류 버킷
- 40초 소개 영상, 포트폴리오 06 페이지 연결

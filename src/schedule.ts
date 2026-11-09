// 규칙 기반 공정 생성: 층 × 부재 종류 → 공종(trade) → 작업(task) → 선후행 → 위상정렬(CPM 전진 계산) → 요소별 start/end.
// 값은 '개념' 수준의 기본값이며 UI에서 바꿀 수 있다. 수량·생산성 산출을 거친 공기가 아니다.
import type { ElementRow, Storey } from "./ifc";

export type Trade = "foundation" | "vertical" | "horizontal" | "stair" | "roof" | "envelope" | "finish" | "misc";

export const TRADE_LABEL: Record<Trade, string> = {
  foundation: "기초",
  vertical: "골조·수직재",
  horizontal: "골조·수평재",
  stair: "계단",
  roof: "지붕",
  envelope: "외피·창호",
  finish: "마감",
  misc: "기타",
};

export const TRADE_COLOR: Record<Trade, string> = {
  foundation: "#8d6e63", vertical: "#c0392b", horizontal: "#e67e22", stair: "#d35400",
  roof: "#8e44ad", envelope: "#2980b9", finish: "#27ae60", misc: "#7f8c8d",
};

// 공종 매핑 규칙 (순서대로 첫 일치)
export interface TradeRule { match: (r: ElementRow, ctx: { topIndex: number }) => boolean; trade: Trade; label: string }
export const TRADE_RULES: TradeRule[] = [
  { label: "IfcFooting · IfcPile", trade: "foundation", match: (r) => /^IFC(FOOTING|PILE)$/.test(r.ifcClass) },
  { label: "IfcSlab(ROOF) · IfcRoof · 최상층 IfcMember/IfcSlab", trade: "roof",
    match: (r, c) => r.ifcClass === "IFCROOF" || (r.ifcClass === "IFCSLAB" && r.predefinedType === "ROOF") || (r.storeyIndex === c.topIndex && /^IFC(MEMBER|SLAB)$/.test(r.ifcClass)) },
  { label: "IfcWall* · IfcColumn", trade: "vertical", match: (r) => /^IFC(WALL|WALLSTANDARDCASE|WALLELEMENTEDCASE|COLUMN)$/.test(r.ifcClass) },
  { label: "IfcBeam · IfcSlab · IfcMember", trade: "horizontal", match: (r) => /^IFC(BEAM|SLAB|MEMBER)$/.test(r.ifcClass) },
  { label: "IfcStair · IfcStairFlight · IfcRamp", trade: "stair", match: (r) => /^IFC(STAIR|STAIRFLIGHT|RAMP|RAMPFLIGHT)$/.test(r.ifcClass) },
  { label: "IfcWindow · IfcDoor · IfcCurtainWall · IfcPlate", trade: "envelope", match: (r) => /^IFC(WINDOW|DOOR|CURTAINWALL|PLATE)$/.test(r.ifcClass) },
  { label: "IfcCovering · IfcRailing", trade: "finish", match: (r) => /^IFC(COVERING|RAILING)$/.test(r.ifcClass) },
  { label: "그 외 IfcBuildingElement", trade: "misc", match: () => true },
];

export interface Params {
  foundationDays: number;  // 기초 전체
  slabDays: number;        // 층당 수평재(슬래브·보) 타설·양생 포함 사이클
  wallDays: number;        // 층당 수직재
  curingDays: number;      // 콘크리트 양생(회색 표시) — 수평재에 적용
  roofDays: number;
  envelopeDays: number;    // 층당 창호·외피
  finishDays: number;      // 층당 마감
  envelopeLag: number;     // 골조 상부 몇 개 층이 올라간 뒤 외피 시작(0=바로 위층 골조 후)
}
export const DEFAULT_PARAMS: Params = {
  foundationDays: 10, slabDays: 4, wallDays: 3, curingDays: 3, roofDays: 6, envelopeDays: 4, finishDays: 6, envelopeLag: 1,
};
export const PARAM_META: { key: keyof Params; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "foundationDays", label: "기초 공기", min: 3, max: 30, step: 1, unit: "일" },
  { key: "wallDays", label: "층당 수직재", min: 1, max: 10, step: 1, unit: "일" },
  { key: "slabDays", label: "층당 수평재", min: 1, max: 10, step: 1, unit: "일" },
  { key: "curingDays", label: "양생(회색 표시)", min: 0, max: 7, step: 1, unit: "일" },
  { key: "roofDays", label: "지붕", min: 1, max: 20, step: 1, unit: "일" },
  { key: "envelopeDays", label: "층당 외피·창호", min: 1, max: 15, step: 1, unit: "일" },
  { key: "finishDays", label: "층당 마감", min: 1, max: 30, step: 1, unit: "일" },
  { key: "envelopeLag", label: "외피 착수 지연(층)", min: 0, max: 3, step: 1, unit: "층" },
];

export interface Task {
  id: string;
  label: string;
  trade: Trade;
  storeyIndex: number;      // -1 = 전체
  duration: number;
  preds: string[];
  start: number;
  end: number;
  elements: number[];       // expressID
  curing: number;           // 양생 표시 일수
}
export interface ElementSchedule { expressID: number; task: string; trade: Trade; start: number; end: number; curingEnd: number }
export interface Schedule {
  tasks: Task[];
  byElement: Map<number, ElementSchedule>;
  totalDays: number;
  rulesText: string[];
  unclassified: ElementRow[];
}

export function classify(rows: ElementRow[], storeys: Storey[]): Map<number, Trade> {
  const ctx = { topIndex: storeys.length - 1 };
  const out = new Map<number, Trade>();
  for (const r of rows) {
    const rule = TRADE_RULES.find((t) => t.match(r, ctx))!;
    out.set(r.expressID, rule.trade);
  }
  return out;
}

export function buildSchedule(rows: ElementRow[], storeys: Storey[], p: Params): Schedule {
  const trades = classify(rows, storeys);
  const n = storeys.length;
  const tasks = new Map<string, Task>();
  const mk = (id: string, label: string, trade: Trade, storeyIndex: number, duration: number, preds: string[], curing = 0) => {
    tasks.set(id, { id, label, trade, storeyIndex, duration, preds, start: 0, end: 0, elements: [], curing });
  };
  const sName = (i: number) => (i >= 0 && i < n ? storeys[i].name : "전체");

  // 작업 노드 생성 (요소 유무와 관계없이 골격 생성 → 비어 있으면 나중에 제거)
  mk("FDN", "기초", "foundation", -1, p.foundationDays, []);
  for (let i = 0; i < n; i++) {
    const below = i === 0 ? "FDN" : `V${i - 1}`;
    mk(`H${i}`, `${sName(i)} 수평재`, "horizontal", i, p.slabDays, [below], p.curingDays);
    mk(`V${i}`, `${sName(i)} 수직재`, "vertical", i, p.wallDays, [`H${i}`]);
    mk(`S${i}`, `${sName(i)} 계단`, "stair", i, Math.max(1, Math.round(p.wallDays / 2)), [`V${i}`]);
  }
  mk("ROOF", "지붕", "roof", n - 1, p.roofDays, [n > 0 ? `V${n - 1}` : "FDN"]);
  for (let i = 0; i < n; i++) {
    const lagIdx = Math.min(i + p.envelopeLag, n - 1);
    const envPred = i + p.envelopeLag >= n ? "ROOF" : `V${lagIdx}`;
    mk(`E${i}`, `${sName(i)} 외피·창호`, "envelope", i, p.envelopeDays, [envPred]);
    mk(`F${i}`, `${sName(i)} 마감`, "finish", i, p.finishDays, [`E${i}`, "ROOF"]);
    mk(`M${i}`, `${sName(i)} 기타`, "misc", i, Math.max(1, Math.round(p.finishDays / 2)), [`V${i}`]);
  }
  mk("M-1", "층 미상 요소", "misc", -1, 2, ["ROOF"]);

  // 요소 배정
  const unclassified: ElementRow[] = [];
  for (const r of rows) {
    const t = trades.get(r.expressID)!;
    const i = r.storeyIndex;
    let id: string;
    if (t === "foundation") id = "FDN";
    else if (t === "roof") id = "ROOF";
    else if (i < 0) id = "M-1";
    else id = ({ vertical: "V", horizontal: "H", stair: "S", envelope: "E", finish: "F", misc: "M" } as Record<string, string>)[t] + i;
    const task = tasks.get(id);
    if (!task) { unclassified.push(r); continue; }
    task.elements.push(r.expressID);
    if (t === "misc") unclassified.push(r);
  }

  // 빈 작업 제거 (선행은 그 작업의 선행으로 대체)
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of [...tasks.values()]) {
      if (t.elements.length === 0 && t.id !== "FDN") {
        for (const o of tasks.values()) {
          if (o.preds.includes(t.id)) o.preds = [...new Set(o.preds.filter((x) => x !== t.id).concat(t.preds))];
        }
        tasks.delete(t.id);
        changed = true;
      }
    }
  }
  if (tasks.get("FDN")?.elements.length === 0) {
    // 기초가 없는 모델: 기초 노드는 0일로 유지(시작점 표시용)
    tasks.get("FDN")!.duration = 0;
  }

  // 위상정렬 + 전진 계산
  const order: Task[] = [];
  const indeg = new Map<string, number>();
  for (const t of tasks.values()) indeg.set(t.id, t.preds.filter((pr) => tasks.has(pr)).length);
  const q = [...tasks.values()].filter((t) => indeg.get(t.id) === 0);
  while (q.length) {
    q.sort((a, b) => a.storeyIndex - b.storeyIndex);
    const t = q.shift()!;
    order.push(t);
    for (const o of tasks.values()) {
      if (o.preds.includes(t.id)) {
        indeg.set(o.id, indeg.get(o.id)! - 1);
        if (indeg.get(o.id) === 0) q.push(o);
      }
    }
  }
  for (const t of order) {
    t.start = Math.max(0, ...t.preds.filter((pr) => tasks.has(pr)).map((pr) => tasks.get(pr)!.end));
    t.end = t.start + t.duration;
  }
  const totalDays = Math.max(1, ...order.map((t) => t.end));

  // 요소별 시각: 작업 안에서 높이(elevation)·ID 순으로 균등 분산
  const byElement = new Map<number, ElementSchedule>();
  const rowById = new Map(rows.map((r) => [r.expressID, r]));
  for (const t of order) {
    const els = t.elements.slice().sort((a, b) => a - b);
    const m = els.length;
    const span = Math.max(t.duration, 0.01);
    els.forEach((id, k) => {
      const s = t.start + (span * k) / Math.max(m, 1);
      const e = t.start + (span * (k + 1)) / Math.max(m, 1);
      byElement.set(id, { expressID: id, task: t.id, trade: t.trade, start: s, end: e, curingEnd: e + (t.curing ?? 0) });
    });
    void rowById;
  }

  const rulesText = [
    "기초 → 1층 수평재 → 1층 수직재 → 2층 수평재 → … → 지붕 (층별 골조 사이클)",
    `외피·창호는 해당 층 위로 ${p.envelopeLag}개 층의 수직재가 끝난 뒤 시작 (최상층은 지붕 후)`,
    "마감은 그 층의 외피·창호와 지붕이 모두 끝난 뒤 시작",
    `수평재(슬래브·보)는 타설 후 ${p.curingDays}일 동안 '양생 중'으로 회색 표시`,
    "같은 작업 안의 요소는 ID 순으로 균등하게 나누어 순차 등장 (실제 시공 구역 분할이 아님)",
  ];

  return { tasks: order, byElement, totalDays, rulesText, unclassified };
}

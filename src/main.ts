import { loadIfc, type LoadedModel } from "./ifc";
import { buildSchedule, DEFAULT_PARAMS, PARAM_META, TRADE_COLOR, TRADE_LABEL, TRADE_RULES, type Params, type Schedule } from "./schedule";
import { Viewer } from "./viewer";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $("#status");
const viewer = new Viewer($("#canvas"));

let model: LoadedModel | null = null;
let sched: Schedule | null = null;
let params: Params = { ...DEFAULT_PARAMS };
let day = 0;
let playing = false;
let hoverTask: string | null = null;
let lastT = performance.now();

const dayInput = $<HTMLInputElement>("#day");
const playBtn = $<HTMLButtonElement>("#play");
const speedSel = $<HTMLSelectElement>("#speed");
const ghostChk = $<HTMLInputElement>("#ghost");
const rowById = () => new Map(model!.rows.map((r) => [r.expressID, r]));

function setStatus(s: string) { statusEl.textContent = s; }

async function openBytes(bytes: Uint8Array, name: string) {
  try {
    setStatus(`${name} 읽는 중…`);
    const t0 = performance.now();
    const m = await loadIfc(bytes, setStatus);
    model = m;
    viewer.setModel(m);
    rebuild();
    const ms = Math.round(performance.now() - t0);
    setStatus(`${name} · ${m.schema} · ${m.rows.length}개 요소 · ${m.storeys.length}개 층 · ${ms}ms`);
    day = 0; playing = false; playBtn.textContent = "▶";
    update();
  } catch (e) {
    console.error(e);
    setStatus(`열기 실패: ${(e as Error).message}`);
  }
}

async function openUrl(url: string) {
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  await openBytes(buf, url.split("/").pop() ?? url);
}

function rebuild() {
  if (!model) return;
  sched = buildSchedule(model.rows, model.storeys, params);
  dayInput.max = String(Math.ceil(sched.totalDays));
  renderGantt();
  renderRules();
  update();
}

function update() {
  if (!model || !sched) return;
  viewer.showGhost = ghostChk.checked;
  viewer.applyDay(day, sched, hoverTask);
  dayInput.value = String(day);
  $("#day-label").textContent = `${Math.floor(day)}일 / ${Math.ceil(sched.totalDays)}일`;
  const cur = sched.tasks.filter((t) => day >= t.start && day < t.end).map((t) => t.label);
  $("#phase-label").textContent = cur.length ? cur.join(" · ") : day >= sched.totalDays ? "준공" : "착공 전";
  document.querySelectorAll<HTMLElement>(".g-now").forEach((el) => { el.style.left = `${(day / sched!.totalDays) * 100}%`; });
  document.querySelectorAll<HTMLElement>(".g-bar").forEach((el) => {
    const t = sched!.tasks.find((x) => x.id === el.dataset.task)!;
    el.classList.toggle("cur", day >= t.start && day < t.end);
  });
}

function renderGantt() {
  const g = $("#gantt");
  g.innerHTML = "";
  if (!sched) return;
  $("#gantt-meta").textContent = `${sched.tasks.length}개 작업 · 총 ${Math.ceil(sched.totalDays)}일`;
  for (const t of sched.tasks) {
    const label = document.createElement("div");
    label.className = "g-label g-row";
    label.innerHTML = `${t.label}<small>${t.elements.length}</small>`;
    label.title = `${t.label} · ${t.start.toFixed(0)}~${t.end.toFixed(0)}일 · 요소 ${t.elements.length}`;
    const track = document.createElement("div");
    track.className = "g-track g-row";
    const bar = document.createElement("div");
    bar.className = "g-bar";
    bar.dataset.task = t.id;
    bar.style.left = `${(t.start / sched.totalDays) * 100}%`;
    bar.style.width = `${Math.max(0.5, ((t.end - t.start) / sched.totalDays) * 100)}%`;
    bar.style.background = TRADE_COLOR[t.trade];
    const now = document.createElement("div");
    now.className = "g-now";
    track.append(bar, now);
    for (const el of [label, track]) {
      el.addEventListener("pointerenter", () => { hoverTask = t.id; label.classList.add("hover"); track.classList.add("hover"); update(); });
      el.addEventListener("pointerleave", () => { hoverTask = null; label.classList.remove("hover"); track.classList.remove("hover"); update(); });
      el.addEventListener("click", () => { day = t.start; update(); });
    }
    g.append(label, track);
  }
}

function renderRules() {
  const p = $("#params");
  p.innerHTML = "";
  for (const m of PARAM_META) {
    const l = document.createElement("label");
    l.innerHTML = `<span>${m.label}</span><span class="v">${params[m.key]}${m.unit}</span>`;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = String(m.min); inp.max = String(m.max); inp.step = String(m.step); inp.value = String(params[m.key]);
    inp.addEventListener("input", () => { params = { ...params, [m.key]: Number(inp.value) }; (l.querySelector(".v") as HTMLElement).textContent = `${inp.value}${m.unit}`; rebuild(); });
    l.appendChild(inp);
    p.appendChild(l);
  }
  const tt = $("#trade-table");
  tt.innerHTML = "";
  const counts = new Map<string, number>();
  if (sched) for (const t of sched.tasks) counts.set(t.trade, (counts.get(t.trade) ?? 0) + t.elements.length);
  for (const r of TRADE_RULES) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.label}</td><td><i class="sw" style="background:${TRADE_COLOR[r.trade]}"></i>${TRADE_LABEL[r.trade]}</td>`;
    tt.appendChild(tr);
  }
  const ul = $("#rule-list");
  ul.innerHTML = "";
  for (const s of sched?.rulesText ?? []) { const li = document.createElement("li"); li.textContent = s; ul.appendChild(li); }
  const un = $("#unclassified");
  if (sched && sched.unclassified.length) {
    const byCls = new Map<string, number>();
    for (const r of sched.unclassified) byCls.set(r.ifcClass, (byCls.get(r.ifcClass) ?? 0) + 1);
    un.textContent = [...byCls].map(([k, v]) => `${k} ${v}`).join(", ") + " → '기타'로 배정";
  } else un.textContent = "없음";
  if (model && Object.keys(model.skipped).length) {
    un.textContent += `\n제외: ` + Object.entries(model.skipped).map(([k, v]) => `${k} ${v}`).join(", ");
  }
}

// 이벤트
dayInput.addEventListener("input", () => { day = Number(dayInput.value); playing = false; playBtn.textContent = "▶"; update(); });
playBtn.addEventListener("click", () => {
  if (!sched) return;
  if (day >= sched.totalDays) day = 0;
  playing = !playing;
  playBtn.textContent = playing ? "❚❚" : "▶";
  lastT = performance.now();
});
ghostChk.addEventListener("change", update);
$("#model-select").addEventListener("change", (e) => openUrl((e.target as HTMLSelectElement).value));
$<HTMLInputElement>("#file-input").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 100 * 1024 * 1024) { setStatus("100MB 이하 파일만 엽니다."); return; }
  await openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
});
viewer.onHover = (id) => {
  const info = $("#hover-info");
  if (id == null || !model || !sched) { info.textContent = ""; return; }
  const r = rowById().get(id);
  const es = sched.byElement.get(id);
  if (!r) { info.textContent = ""; return; }
  const t = es ? sched.tasks.find((x) => x.id === es.task) : null;
  info.textContent = `${r.ifcClass}${r.predefinedType ? " · " + r.predefinedType : ""}\n${r.name ?? ""}\n${r.storeyName}${t ? `\n${t.label} · ${es!.start.toFixed(1)}~${es!.end.toFixed(1)}일` : ""}`;
};

function loop(now: number) {
  if (playing && sched) {
    const dt = (now - lastT) / 1000;
    day = Math.min(sched.totalDays, day + dt * Number(speedSel.value));
    if (day >= sched.totalDays) { playing = false; playBtn.textContent = "▶"; }
    update();
  }
  lastT = now;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

openUrl($<HTMLSelectElement>("#model-select").value);

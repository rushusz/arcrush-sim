// IFC 로드 → 요소 행(rows) + 메시 추출. web-ifc 단독, 서버 없음.
import * as WebIFC from "web-ifc";
import * as THREE from "three";

export interface Storey { expressID: number; name: string; elevation: number }
export interface ElementRow {
  expressID: number;
  globalId: string | null;
  ifcClass: string;          // 대문자, 예: IFCWALLSTANDARDCASE
  predefinedType: string | null;
  name: string | null;
  storeyID: number | null;
  storeyIndex: number;       // 아래층부터 0; 층 미상이면 -1
  storeyName: string;
  elevation: number | null;
}
export interface LoadedModel {
  schema: string;
  storeys: Storey[];
  rows: ElementRow[];
  meshes: THREE.Mesh[];      // 메시마다 userData.expressID
  group: THREE.Group;
  bbox: THREE.Box3;
  skipped: Record<string, number>;
}

const SKIP = new Set([
  "IFCOPENINGELEMENT", "IFCOPENINGSTANDARDCASE", "IFCSPACE", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY",
  "IFCPROJECT", "IFCANNOTATION", "IFCGRID", "IFCDISTRIBUTIONPORT", "IFCPORT", "IFCVIRTUALELEMENT",
  "IFCSPATIALZONE", "IFCEXTERNALSPATIALELEMENT", "IFCSTRUCTURALCURVEMEMBER", "IFCSTRUCTURALSURFACEMEMBER",
  "IFCSTRUCTURALPOINTCONNECTION", "IFCSTRUCTURALCURVECONNECTION", "IFCSTRUCTURALSURFACECONNECTION",
  "IFCFURNISHINGELEMENT", "IFCFURNITURE", "IFCSYSTEMFURNITUREELEMENT",
]);

let api: WebIFC.IfcAPI | null = null;
export async function getApi(): Promise<WebIFC.IfcAPI> {
  if (api) return api;
  api = new WebIFC.IfcAPI();
  api.SetWasmPath("/", true);
  await api.Init();
  return api;
}

const val = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x ?? null);

export async function loadIfc(bytes: Uint8Array, onProgress?: (msg: string) => void): Promise<LoadedModel> {
  const ifc = await getApi();
  onProgress?.("모델 여는 중…");
  const modelID = ifc.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  try {
    const schema = ifc.GetModelSchema(modelID);
    const typeName = (id: number) => ifc.GetNameFromTypeCode(ifc.GetLineType(modelID, id)).toUpperCase();

    // 층
    const storeys: Storey[] = [];
    const sIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
    for (let i = 0; i < sIds.size(); i++) {
      const id = sIds.get(i);
      const s = ifc.GetLine(modelID, id);
      storeys.push({ expressID: id, name: val(s.Name) ?? `Storey#${id}`, elevation: Number(val(s.Elevation) ?? 0) });
    }
    storeys.sort((a, b) => a.elevation - b.elevation);
    const storeyIdx = new Map(storeys.map((s, i) => [s.expressID, i]));

    // 공간 포함 관계 + 집합 관계
    const containedIn = new Map<number, number>();
    const relIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < relIds.size(); i++) {
      const rel = ifc.GetLine(modelID, relIds.get(i));
      const st = rel.RelatingStructure?.value;
      for (const e of rel.RelatedElements ?? []) containedIn.set(e.value, st);
    }
    const parentOf = new Map<number, number>();
    const aggIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCRELAGGREGATES);
    for (let i = 0; i < aggIds.size(); i++) {
      const rel = ifc.GetLine(modelID, aggIds.get(i));
      const whole = rel.RelatingObject?.value;
      for (const p of rel.RelatedObjects ?? []) parentOf.set(p.value, whole);
    }
    const resolveStorey = (id: number): number | null => {
      let cur: number | undefined = id;
      for (let hops = 0; cur != null && hops < 10; hops++) {
        const c = containedIn.get(cur);
        if (c != null) {
          let sp: number | undefined = c;
          for (let h = 0; sp != null && h < 6; h++) {
            if (storeyIdx.has(sp)) return sp;
            sp = parentOf.get(sp);
          }
          return null;
        }
        cur = parentOf.get(cur);
      }
      return null;
    };

    // 타입 객체의 PredefinedType (IFC2X3 보강)
    const typePredef = new Map<number, string | null>();
    const defIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYTYPE);
    for (let i = 0; i < defIds.size(); i++) {
      const rel = ifc.GetLine(modelID, defIds.get(i));
      const t = rel.RelatingType?.value != null ? ifc.GetLine(modelID, rel.RelatingType.value) : null;
      const pdt = t ? val(t.PredefinedType) : null;
      for (const o of rel.RelatedObjects ?? []) typePredef.set(o.value, pdt);
    }

    // 요소 행
    onProgress?.("요소 분류 중…");
    const rows: ElementRow[] = [];
    const skipped: Record<string, number> = {};
    const prodIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCPRODUCT, true);
    for (let i = 0; i < prodIds.size(); i++) {
      const id = prodIds.get(i);
      const cls = typeName(id);
      if (SKIP.has(cls)) { skipped[cls] = (skipped[cls] ?? 0) + 1; continue; }
      const line = ifc.GetLine(modelID, id);
      if (!line.Representation) continue;
      const own = val(line.PredefinedType);
      const pdt = own && own !== "NOTDEFINED" ? own : typePredef.get(id) ?? own ?? null;
      const sid = resolveStorey(id);
      const sIndex = sid != null ? storeyIdx.get(sid)! : -1;
      rows.push({
        expressID: id,
        globalId: val(line.GlobalId),
        ifcClass: cls,
        predefinedType: pdt ? String(pdt).toUpperCase() : null,
        name: val(line.Name),
        storeyID: sid,
        storeyIndex: sIndex,
        storeyName: sIndex >= 0 ? storeys[sIndex].name : "(층 미상)",
        elevation: sIndex >= 0 ? storeys[sIndex].elevation : null,
      });
    }

    // 메시
    onProgress?.("형상 만드는 중…");
    const group = new THREE.Group(); // web-ifc는 이미 Y-up으로 변환해 내보낸다 (추가 회전 불필요)
    const meshes: THREE.Mesh[] = [];
    const matCache = new Map<string, THREE.MeshLambertMaterial>();
    const getMat = (c: { x: number; y: number; z: number; w: number }) => {
      const key = `${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)},${c.w.toFixed(2)}`;
      let m = matCache.get(key);
      if (!m) {
        m = new THREE.MeshLambertMaterial({
          color: new THREE.Color(c.x, c.y, c.z),
          transparent: true,
          opacity: c.w < 1 ? Math.max(c.w, 0.35) : 1,
          side: THREE.DoubleSide,
        });
        m.userData.baseOpacity = m.opacity;
        matCache.set(key, m);
      }
      return m;
    };
    const rowIds = new Set(rows.map((r) => r.expressID));
    ifc.StreamAllMeshes(modelID, (flat) => {
      if (!rowIds.has(flat.expressID)) return; // 가구·공간·개구부 등 공정 대상이 아닌 형상은 만들지 않음
      const geoms = flat.geometries;
      for (let j = 0; j < geoms.size(); j++) {
        const pg = geoms.get(j);
        const g = ifc.GetGeometry(modelID, pg.geometryExpressID);
        const verts = ifc.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
        const idx = ifc.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
        const pos = new Float32Array(verts.length / 2);
        const nor = new Float32Array(verts.length / 2);
        for (let k = 0, m = 0; k < verts.length; k += 6, m += 3) {
          pos[m] = verts[k]; pos[m + 1] = verts[k + 1]; pos[m + 2] = verts[k + 2];
          nor[m] = verts[k + 3]; nor[m + 1] = verts[k + 4]; nor[m + 2] = verts[k + 5];
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        const mat = getMat(pg.color);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(pg.flatTransformation);
        mesh.userData.expressID = flat.expressID;
        mesh.userData.baseMaterial = mat;
        group.add(mesh);
        meshes.push(mesh);
        g.delete();
      }
    });
    group.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(group);
    return { schema, storeys, rows, meshes, group, bbox, skipped };
  } finally {
    ifc.CloseModel(modelID);
  }
}

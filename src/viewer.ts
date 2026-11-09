// Three.js 뷰어: 장면, 카메라, 궤도 조작, 요소 상태 적용(숨김/진행/양생/완료/예정 윤곽), 마우스 피킹.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LoadedModel } from "./ifc";
import type { Schedule } from "./schedule";

export type ElementState = "hidden" | "active" | "curing" | "done";

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: LoadedModel | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hovered: number | null = null;
  onHover: ((expressID: number | null) => void) | null = null;
  showGhost = true;

  private matActive = new THREE.MeshLambertMaterial({ color: 0xff7a1a, emissive: 0x552200, side: THREE.DoubleSide });
  private matCuring = new THREE.MeshLambertMaterial({ color: 0x7a7f87, side: THREE.DoubleSide });
  private matGhost = new THREE.MeshBasicMaterial({ color: 0x3b3e45, wireframe: true, transparent: true, opacity: 0.18 });
  private matHighlight = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666, side: THREE.DoubleSide });

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x111214);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 0.9);
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(30, 60, 40);
    this.scene.add(hemi, dir);
    const grid = new THREE.GridHelper(60, 60, 0x2a2c31, 0x202226);
    grid.position.y = -0.01;
    this.scene.add(grid);

    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    canvas.addEventListener("pointerleave", () => { this.pointer.set(99, 99); });

    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(canvas);
    resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  setModel(m: LoadedModel) {
    if (this.model) this.scene.remove(this.model.group);
    this.model = m;
    this.scene.add(m.group);
    const size = m.bbox.getSize(new THREE.Vector3());
    const center = m.bbox.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z);
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 1.1, radius * 0.8, radius * 1.1));
    this.camera.near = radius / 200;
    this.camera.far = radius * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    const grid = this.scene.children.find((c) => c instanceof THREE.GridHelper) as THREE.GridHelper | undefined;
    if (grid) { grid.position.y = m.bbox.min.y - 0.01; grid.position.x = center.x; grid.position.z = center.z; }
  }

  /** day 시점의 상태를 모든 메시에 적용 */
  applyDay(day: number, sched: Schedule, highlightTask: string | null) {
    if (!this.model) return;
    for (const mesh of this.model.meshes) {
      const id = mesh.userData.expressID as number;
      const es = sched.byElement.get(id);
      let state: ElementState = "done";
      if (es) {
        if (day < es.start) state = "hidden";
        else if (day < es.end) state = "active";
        else if (day < es.curingEnd) state = "curing";
      }
      const hl = highlightTask && es?.task === highlightTask;
      if (state === "hidden") {
        mesh.visible = this.showGhost;
        mesh.material = this.matGhost;
      } else {
        mesh.visible = true;
        mesh.material = hl ? this.matHighlight : state === "active" ? this.matActive : state === "curing" ? this.matCuring : mesh.userData.baseMaterial;
      }
    }
  }

  private tick() {
    this.controls.update();
    if (this.model && this.pointer.x < 50) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const visible = this.model.meshes.filter((m) => m.visible && m.material !== this.matGhost);
      const hit = this.raycaster.intersectObjects(visible, false)[0];
      const id = hit ? (hit.object.userData.expressID as number) : null;
      if (id !== this.hovered) { this.hovered = id; this.onHover?.(id); }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

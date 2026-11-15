import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type ViewMode = "pbr" | "clay" | "wire" | "normals" | "uv";

export interface MeshStats {
  vertices: number;
  triangles: number;
  size: [number, number, number];
  textured: boolean;
}

export interface ViewerHandle {
  capture: (size?: number) => Promise<Blob | null>;
  resetView: () => void;
}

interface Props {
  src: string | File | null;
  mode: ViewMode;
  autoRotate?: boolean;
  grid?: boolean;
  onStats?: (s: MeshStats | null) => void;
  onLoaded?: () => void;
  empty?: React.ReactNode;
}

const clayMat = new THREE.MeshStandardMaterial({ color: 0xc8c2b8, roughness: 0.78, metalness: 0.02 });
const normalMat = new THREE.MeshNormalMaterial();
const wireMat = new THREE.MeshBasicMaterial({ color: 0xff8a50, wireframe: true, transparent: true, opacity: 0.55 });
const wireBase = new THREE.MeshStandardMaterial({ color: 0x2a2a31, roughness: 0.9 });

function uvMaterial(): THREE.Material {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const n = 16;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? "#1d1d24" : `hsl(${(x * 360) / n}, 70%, ${45 + (y / n) * 20}%)`;
      g.fillRect((x * size) / n, (y * size) / n, size / n, size / n);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: tex });
}
let uvMat: THREE.Material | null = null;

function extOf(src: string | File): string {
  const name = typeof src === "string" ? new URL(src, location.href).pathname : src.name;
  const m = /\.([a-z0-9]+)$/i.exec(decodeURIComponent(name));
  return (m?.[1] || "glb").toLowerCase();
}

async function loadObject(src: string | File): Promise<THREE.Object3D> {
  const ext = extOf(src);
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    if (ext === "glb" || ext === "gltf") {
      const gltf = await new GLTFLoader().loadAsync(url);
      return gltf.scene;
    }
    if (ext === "obj") return await new OBJLoader().loadAsync(url);
    const geom = ext === "ply" ? await new PLYLoader().loadAsync(url) : await new STLLoader().loadAsync(url);
    if (!geom.attributes.normal) geom.computeVertexNormals();
    const mat = geom.attributes.color
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })
      : clayMat.clone();
    return new THREE.Mesh(geom, mat);
  } finally {
    if (typeof src !== "string") setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

function dispose(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const original = mesh.userData.original as THREE.Material | THREE.Material[] | undefined;
    for (const m of ([] as THREE.Material[]).concat(original ?? mesh.material)) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

export const Viewer3D = forwardRef<ViewerHandle, Props>(function Viewer3D(
  { src, mode, autoRotate = false, grid = true, onStats, onLoaded, empty },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    grid: THREE.GridHelper;
    root: THREE.Group;
    wire: THREE.Group;
    frame: () => void;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasModel, setHasModel] = useState(false);
  const modeRef = useRef(mode);

  // --- scene bootstrap --------------------------------------------------
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 5, 4);
    scene.add(key, new THREE.HemisphereLight(0xffffff, 0x222233, 0.35));

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    camera.position.set(2.2, 1.5, 2.8);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.5, 0);
    controls.autoRotateSpeed = 1.6;

    const gridHelper = new THREE.GridHelper(6, 24, 0x3a3a44, 0x24242b);
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.7;
    scene.add(gridHelper);

    const root = new THREE.Group();
    const wire = new THREE.Group();
    scene.add(root, wire);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const frame = () => renderer.render(scene, camera);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      frame();
    };
    loop();
    ctx.current = { renderer, scene, camera, controls, grid: gridHelper, root, wire, frame };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      dispose(root);
      renderer.dispose();
      el.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  // --- options ------------------------------------------------------------
  useEffect(() => {
    if (ctx.current) ctx.current.controls.autoRotate = autoRotate;
  }, [autoRotate]);
  useEffect(() => {
    if (ctx.current) ctx.current.grid.visible = grid;
  }, [grid]);

  const applyMode = (m: ViewMode) => {
    const c = ctx.current;
    if (!c) return;
    c.wire.clear();
    c.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.userData.original) mesh.userData.original = mesh.material;
      const original = mesh.userData.original as THREE.Material;
      if (m === "pbr") mesh.material = original;
      else if (m === "clay") mesh.material = clayMat;
      else if (m === "normals") mesh.material = normalMat;
      else if (m === "uv") mesh.material = uvMat ?? (uvMat = uvMaterial());
      else {
        mesh.material = wireBase;
        const overlay = new THREE.Mesh(mesh.geometry, wireMat);
        mesh.updateWorldMatrix(true, false);
        overlay.matrixAutoUpdate = false;
        overlay.matrix.copy(mesh.matrixWorld);
        c.wire.add(overlay);
      }
    });
  };

  useEffect(() => {
    modeRef.current = mode;
    applyMode(mode);
  }, [mode]);

  const frameObject = () => {
    const c = ctx.current;
    if (!c || !c.root.children.length) return;
    const box = new THREE.Box3().setFromObject(c.root);
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const fov = (c.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.05;
    const target = new THREE.Vector3(0, size.y / 2, 0);
    c.controls.target.copy(target);
    c.camera.position.copy(target).add(new THREE.Vector3(0.55, 0.35, 0.9).normalize().multiplyScalar(dist));
    c.camera.near = dist / 100;
    c.camera.far = dist * 20;
    c.camera.updateProjectionMatrix();
    c.controls.update();
  };

  // --- loading ------------------------------------------------------------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    let cancelled = false;
    c.wire.clear();
    dispose(c.root);
    c.root.clear();
    setHasModel(false);
    setError(null);
    onStats?.(null);
    if (!src) return;
    setLoading(true);
    loadObject(src)
      .then((obj) => {
        if (cancelled) return dispose(obj);
        // Normalise: centre on X/Z, sit on the grid, fit in a ~2 unit box.
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const scale = 2 / (Math.max(size.x, size.y, size.z) || 1);
        const center = box.getCenter(new THREE.Vector3());
        obj.position.set(-center.x, -box.min.y, -center.z);
        const pivot = new THREE.Group();
        pivot.add(obj);
        pivot.scale.setScalar(scale);
        c.root.add(pivot);

        let vertices = 0;
        let triangles = 0;
        let textured = false;
        obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const g = mesh.geometry;
          vertices += g.attributes.position.count;
          triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat && (mat.map || mat.metalnessMap || mat.roughnessMap)) textured = true;
        });
        onStats?.({ vertices, triangles: Math.round(triangles), size: [size.x, size.y, size.z], textured });
        applyMode(modeRef.current);
        frameObject();
        setHasModel(true);
        onLoaded?.();
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useImperativeHandle(ref, () => ({
    resetView: frameObject,
    capture: async (size = 512) => {
      const c = ctx.current;
      if (!c || !c.root.children.length) return null;
      const gridWas = c.grid.visible;
      c.grid.visible = false;
      c.frame();
      const src = c.renderer.domElement;
      const out = document.createElement("canvas");
      out.width = out.height = size;
      const g = out.getContext("2d")!;
      const s = Math.min(src.width, src.height);
      g.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
      c.grid.visible = gridWas;
      return new Promise((resolve) => out.toBlob((b) => resolve(b), "image/png"));
    },
  }));

  return (
    <div className="viewer">
      <div ref={host} className="viewer-canvas" />
      {!src && !hasModel && <div className="viewer-empty">{empty}</div>}
      {loading && <div className="viewer-badge">Chargement du modèle…</div>}
      {error && <div className="viewer-badge error">Impossible de charger : {error}</div>}
    </div>
  );
});

// Client for the local Python backend (FastAPI on 127.0.0.1).

export interface Capabilities {
  shape: boolean;
  paint: boolean;
  paint_missing: string[];
  text: boolean;
  native: { rasterizer: boolean; inpaint: boolean };
}

export interface Health {
  ok: boolean;
  version: string;
  uptime: number;
  busy: boolean;
  loaded: string[];
  capabilities: Capabilities;
}

export interface GpuLive {
  cuda: boolean;
  torch?: string;
  cuda_version?: string;
  name?: string;
  vram_total?: number;
  vram_free?: number;
  vram_reserved?: number;
  error?: string;
}

export interface SystemLive {
  gpu: GpuLive;
  loaded: string[];
  python: string;
  capabilities: Capabilities;
  config: Record<string, unknown>;
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type JobKind = "image" | "text" | "texture";

export interface Job {
  id: string;
  item_id: string;
  kind: JobKind;
  name: string;
  status: JobStatus;
  created: number;
  started: number | null;
  finished: number | null;
  stages: { id: string; label: string }[];
  stage: string | null;
  stage_label: string;
  stage_progress: number;
  progress: number;
  detail: string;
  error: string | null;
  warning: string | null;
  params: GenParams;
  timings: Record<string, number>;
}

export interface ShapeParams {
  steps: number;
  guidance: number;
  octree: number;
  num_chunks: number;
  seed: number;
  remove_floaters: boolean;
  remove_degenerate: boolean;
  max_faces: number;
}

export interface TextureParams {
  enabled: boolean;
  views: number;
  resolution: number;
  texture_size: number;
  render_size: number;
  remesh: boolean;
}

export interface GenParams {
  shape?: ShapeParams;
  texture?: TextureParams;
  remove_bg?: "auto" | "always" | "never";
  prompt?: string;
  t2i?: { style_suffix: boolean; t2i_steps?: number };
  target_item?: string;
}

export interface FileInfo {
  name: string;
  mtime: number;
  size: number;
}

export interface LibraryItem {
  id: string;
  name: string;
  kind: JobKind;
  created: number;
  updated?: number;
  prompt?: string;
  seed?: number;
  params: GenParams;
  files: Record<string, string>;
  available: Partial<Record<"source" | "input" | "shape" | "textured" | "thumb", FileInfo>>;
  stats?: Record<string, { vertices?: number; faces?: number; watertight?: boolean; extent?: number[] }>;
  timings?: Record<string, number>;
  exports: string[];
  path: string;
  favorite?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  role: string;
  required: boolean;
  size_gb: number;
  source: string;
  path: string;
  installed: boolean;
  download: { status: "running" | "done" | "error"; total: number; done: number; speed: number; error: string | null; progress: number } | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface UnityStatus {
  connected: boolean;
  error?: string;
  unity?: string;
  product?: string;
  project?: string;
  scene_name?: string;
  gltf?: boolean;
  render_pipeline?: string;
}

let BASE = "http://127.0.0.1:47823";
export function setApiPort(port: number) {
  BASE = `http://127.0.0.1:${port}`;
}
export function apiBase() {
  return BASE;
}

async function req<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeout ?? 15000);
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = await res.json();
        msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
      } catch {
        /* not json */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => req<Health>("/health", { timeout: 2500 }),
  system: () => req<SystemLive>("/system"),
  setConfig: (values: Record<string, unknown>) => req<{ changed: string[] }>("/config", json("POST", values)),
  unload: () => req<{ loaded: string[] }>("/unload", { method: "POST" }),
  unityStatus: () => req<UnityStatus>("/integrations/unity", { timeout: 5000 }),

  models: () => req<ModelInfo[]>("/models"),
  downloadModel: (id: string) => req<unknown>(`/models/${id}/download`, { method: "POST" }),

  jobs: () => req<Job[]>("/jobs", { timeout: 4000 }),
  cancelJob: (id: string) => req<unknown>(`/jobs/${id}/cancel`, { method: "POST" }),
  clearJobs: () => req<unknown>("/jobs/clear", { method: "POST" }),
  createJob: (spec: { kind: JobKind; name?: string; params: GenParams }, image?: Blob | null, imageName?: string, mesh?: File | null) => {
    const form = new FormData();
    form.append("spec", JSON.stringify(spec));
    if (image) form.append("image", image, imageName || "image.png");
    if (mesh) form.append("mesh", mesh, mesh.name);
    return req<Job>("/jobs", { method: "POST", body: form, timeout: 120000 });
  },

  library: () => req<LibraryItem[]>("/library"),
  item: (id: string) => req<LibraryItem>(`/library/${id}`),
  updateItem: (id: string, changes: Partial<LibraryItem>) => req<LibraryItem>(`/library/${id}`, json("PATCH", changes)),
  deleteItem: (id: string) => req<unknown>(`/library/${id}`, { method: "DELETE" }),
  saveThumbnail: (id: string, png: Blob) =>
    req<LibraryItem>(`/library/${id}/thumbnail`, { method: "POST", body: png, headers: { "Content-Type": "image/png" } }),
  sendToUnity: (id: string, variant: string) =>
    req<{ asset: string; instance?: string }>(`/library/${id}/unity`, { ...json("POST", { variant }), timeout: 300000 }),
  exportItem: (id: string, variant: string, format: string, max_faces = 0) =>
    req<{ path: string }>(`/library/${id}/export`, { ...json("POST", { variant, format, max_faces }), timeout: 300000 }),
};

export function fileUrl(item: LibraryItem, key: keyof LibraryItem["available"]): string | null {
  const f = item.available[key];
  if (!f) return null;
  return `${BASE}/files/${item.id}/${encodeURIComponent(f.name)}?v=${f.mtime}`;
}

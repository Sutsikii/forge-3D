import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type VramProfile = "low" | "balanced" | "high";

export interface Settings {
  runtimeDir: string;
  modelsDir: string;
  hunyuanDir: string;
  outputsDir: string;
  port: number;
  vramProfile: VramProfile;
  flashvdm: boolean;
  t2iModel: string;
  torchVariant: string;
  autoStart: boolean;
  licenseAccepted: boolean;
}

export interface Gpu {
  name: string;
  vramMb: number;
  driver: string;
  computeCap: string;
}

export interface SystemInfo {
  os: string;
  gpus: Gpu[];
  cudaToolkit: { path: string; version: string } | null;
  vcvars: string | null;
  uv: string | null;
  diskFreeGb: number | null;
  recommendedProfile: VramProfile;
}

export interface RuntimeStatus {
  ready: boolean;
  installing: boolean;
  steps: { id: string; label: string; done: boolean }[];
  native: Record<string, boolean>;
  verify: Record<string, unknown> | null;
  lastError: string | null;
  runtimeDir: string;
  python: string;
  repoDir: string;
}

export interface BackendStatus {
  running: boolean;
  external: boolean;
  pid: number | null;
  url: string;
}

export const tauri = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  systemInfo: () => invoke<SystemInfo>("system_info"),
  runtimeStatus: () => invoke<RuntimeStatus>("runtime_status"),
  runtimeLogs: () => invoke<string[]>("runtime_logs"),
  runtimeInstall: (force = false, only: string[] | null = null) => invoke<void>("runtime_install", { force, only }),
  runtimeCancel: () => invoke<void>("runtime_cancel"),
  backendStart: () => invoke<BackendStatus>("backend_start"),
  backendStop: () => invoke<void>("backend_stop"),
  backendRestart: () => invoke<BackendStatus>("backend_restart"),
  backendStatus: () => invoke<BackendStatus>("backend_status"),
  backendLogs: () => invoke<string[]>("backend_logs"),
  probeWeights: (path: string) => invoke<{ shape: boolean; paint: boolean; path: string }>("probe_weights", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

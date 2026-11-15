import { create } from "zustand";
import type { BackendStatus, RuntimeStatus, Settings, SystemInfo } from "./tauri";
import type { Health, Job, LibraryItem, ModelInfo, GenParams } from "./api";

export type Page = "create" | "texture" | "queue" | "library" | "models" | "settings";

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

/** Prefill handed from the library to the Create / Texture pages. */
export interface Draft {
  page: "create" | "texture";
  params?: GenParams;
  targetItem?: string;
  name?: string;
  sourceUrl?: string;
}

interface AppStore {
  page: Page;
  settings: Settings | null;
  system: SystemInfo | null;
  runtime: RuntimeStatus | null;
  backend: BackendStatus | null;
  health: Health | null;
  jobs: Job[];
  library: LibraryItem[];
  models: ModelInfo[];
  focusItem: string | null;
  draft: Draft | null;
  toasts: Toast[];
  set: (partial: Partial<AppStore>) => void;
  go: (page: Page) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useStore = create<AppStore>((set) => ({
  page: "create",
  settings: null,
  system: null,
  runtime: null,
  backend: null,
  health: null,
  jobs: [],
  library: [],
  models: [],
  focusItem: null,
  draft: null,
  toasts: [],
  set: (partial) => set(partial),
  go: (page) => set({ page }),
  toast: (text, kind = "info") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 9000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (text: string, kind?: Toast["kind"]) => useStore.getState().toast(text, kind);

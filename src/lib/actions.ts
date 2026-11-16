import { api, setApiPort } from "./api";
import { tauri, type Settings } from "./tauri";
import { useStore } from "./store";

/** Persist settings, push the live ones to the backend, restart it if needed. */
export async function applySettings(next: Settings): Promise<Settings> {
  const prev = useStore.getState().settings;
  const saved = await tauri.saveSettings(next);
  useStore.getState().set({ settings: saved });
  setApiPort(saved.port);
  const needsRestart =
    !!prev && (prev.port !== saved.port || prev.modelsDir !== saved.modelsDir || prev.runtimeDir !== saved.runtimeDir);
  if (needsRestart) {
    await tauri.backendRestart();
    return saved;
  }
  if (useStore.getState().health) {
    await api
      .setConfig({
        profile: saved.vramProfile,
        flashvdm: saved.flashvdm,
        t2i_model: saved.t2iModel,
        hunyuan_dir: saved.hunyuanDir,
        outputs_dir: saved.outputsDir,
      })
      .catch(() => undefined);
    const [models, library] = await Promise.all([api.models(), api.library()]).catch(() => [null, null]);
    if (models && library) useStore.getState().set({ models, library });
  }
  return saved;
}

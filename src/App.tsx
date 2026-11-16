import { useEffect, useRef } from "react";
import { api, setApiPort } from "./lib/api";
import { on, tauri } from "./lib/tauri";
import { errorText, bytes } from "./lib/format";
import { toast, useStore, type Page } from "./lib/store";
import { Icon } from "./components/icons";
import { Create } from "./pages/Create";
import { Texture } from "./pages/Texture";
import { Queue } from "./pages/Queue";
import { Library } from "./pages/Library";
import { Models } from "./pages/Models";
import { SettingsPage } from "./pages/SettingsPage";
import { Setup } from "./pages/Setup";

const NAV: { id: Page; label: string; icon: keyof typeof Icon }[] = [
  { id: "create", label: "Créer", icon: "cube" },
  { id: "texture", label: "Texturer", icon: "brush" },
  { id: "queue", label: "File d'attente", icon: "queue" },
  { id: "library", label: "Bibliothèque", icon: "library" },
  { id: "models", label: "Modèles", icon: "chip" },
  { id: "settings", label: "Réglages", icon: "gear" },
];

function usePolling() {
  const lastJobsSig = useRef("");
  useEffect(() => {
    let alive = true;
    let tick = 0;
    const loop = async () => {
      if (!alive) return;
      tick++;
      const st = useStore.getState();
      try {
        const backend = await tauri.backendStatus();
        let health = null;
        if (backend.running) health = await api.health().catch(() => null);
        st.set({ backend, health });
        if (health) {
          const activeJobs = st.jobs.some((j) => j.status === "running" || j.status === "queued");
          if (activeJobs || tick % 4 === 0 || !lastJobsSig.current) {
            const jobs = await api.jobs();
            const sig = jobs.map((j) => `${j.id}:${j.status}`).join("|");
            const changed = sig !== lastJobsSig.current;
            lastJobsSig.current = sig;
            st.set({ jobs });
            if (changed || tick % 10 === 0) st.set({ library: await api.library() });
          }
          const downloading = st.models.some((m) => m.download?.status === "running");
          if (downloading || tick % 8 === 0 || !st.models.length) st.set({ models: await api.models() });
        }
        if (st.runtime?.installing || tick % 5 === 0) st.set({ runtime: await tauri.runtimeStatus() });
      } catch {
        /* transient: backend starting or restarting */
      }
      setTimeout(loop, 1000);
    };
    loop();
    return () => {
      alive = false;
    };
  }, []);
}

export default function App() {
  const s = useStore();
  usePolling();

  useEffect(() => {
    (async () => {
      try {
        const settings = await tauri.getSettings();
        setApiPort(settings.port);
        s.set({ settings });
        const [system, runtime] = await Promise.all([tauri.systemInfo(), tauri.runtimeStatus()]);
        s.set({ system, runtime });
      } catch (e) {
        toast(errorText(e), "error");
      }
    })();
    const sub = on<{ ok: boolean; error?: string }>("runtime://finished", async () => {
      useStore.getState().set({ runtime: await tauri.runtimeStatus() });
    });
    return () => {
      sub.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!s.settings || !s.runtime) {
    return (
      <div className="boot">
        <div className="brand-mark big pulse">
          <Icon.cube size={34} />
        </div>
      </div>
    );
  }

  const content = !s.runtime.ready ? (
    <Setup />
  ) : (
    {
      create: <Create />,
      texture: <Texture />,
      queue: <Queue />,
      library: <Library />,
      models: <Models />,
      settings: <SettingsPage />,
    }[s.page]
  );

  const running = s.jobs.find((j) => j.status === "running");
  const queued = s.jobs.filter((j) => j.status === "queued").length;
  const missingRequired = s.models.some((m) => m.required && !m.installed);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon.cube size={18} />
          </div>
          <div>
            <strong>Forge3D</strong>
            <span>Studio</span>
          </div>
        </div>
        {s.runtime.ready &&
          NAV.map((n) => {
            const I = Icon[n.icon];
            return (
              <button key={n.id} className={`nav ${s.page === n.id ? "active" : ""}`} onClick={() => s.go(n.id)}>
                <I />
                <span>{n.label}</span>
                {n.id === "queue" && (running || queued > 0) && <span className="nav-count">{(running ? 1 : 0) + queued}</span>}
                {n.id === "models" && missingRequired && <span className="nav-dot" />}
              </button>
            );
          })}
        <div className="sidebar-foot">
          {running && (
            <button className="mini-job" onClick={() => s.go("queue")}>
              <span>{running.stage_label}</span>
              <div className="mini-bar">
                <div style={{ width: `${running.progress * 100}%` }} />
              </div>
            </button>
          )}
          <StatusLine />
        </div>
      </nav>
      <div className="content">{content}</div>
      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => s.dismiss(t.id)}>
            {t.kind === "error" ? <Icon.alert size={16} /> : t.kind === "success" ? <Icon.check size={16} /> : <Icon.spark size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusLine() {
  const backend = useStore((s) => s.backend);
  const health = useStore((s) => s.health);
  const system = useStore((s) => s.system);
  const runtime = useStore((s) => s.runtime);
  const gpu = system?.gpus[0];
  let tone = "off";
  let label = "Moteur arrêté";
  if (runtime?.installing) {
    tone = "busy";
    label = "Installation…";
  } else if (backend?.running && !health) {
    tone = "busy";
    label = "Démarrage du moteur…";
  } else if (health) {
    tone = health.busy ? "busy" : "on";
    label = health.busy ? "Génération en cours" : "Moteur prêt";
  }
  return (
    <div className="status">
      <div className="status-row">
        <span className={`led ${tone}`} />
        <span>{label}</span>
        {!backend?.running && runtime?.ready && (
          <button className="link" onClick={() => tauri.backendStart().catch((e) => toast(errorText(e), "error"))}>
            démarrer
          </button>
        )}
      </div>
      {gpu && (
        <div className="status-gpu">
          {gpu.name.replace("NVIDIA GeForce ", "")} · {bytes(gpu.vramMb * 1048576)}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, apiBase, type SystemLive } from "../lib/api";
import { tauri, type Settings, type VramProfile } from "../lib/tauri";
import { bytes, errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { applySettings } from "../lib/actions";
import { Badge, Field, LogConsole, Section, Toggle } from "../components/controls";
import { Icon } from "../components/icons";

const PROFILES: { value: VramProfile; label: string; text: string }[] = [
  { value: "low", label: "Économe · ≤ 12 Go", text: "Un seul modèle en VRAM à la fois, octree 256, texture 2K. Idéal RTX 3060/4070." },
  { value: "balanced", label: "Équilibré · 16 Go", text: "Octree 384, texture 4K, déchargement entre étapes." },
  { value: "high", label: "Performance · 24 Go+", text: "Forme + peinture restent chargées, 8 vues à 768 px." },
];

export function SettingsPage() {
  const settings = useStore((s) => s.settings)!;
  const system = useStore((s) => s.system);
  const runtime = useStore((s) => s.runtime);
  const backend = useStore((s) => s.backend);
  const health = useStore((s) => s.health);
  const [draft, setDraft] = useState<Settings>(settings);
  const [live, setLive] = useState<SystemLive | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const installing = useStore.getState().runtime?.installing;
      setLogs(await (installing ? tauri.runtimeLogs() : tauri.backendLogs()).catch(() => []));
      if (useStore.getState().health) setLive(await api.system().catch(() => null));
    };
    tick();
    const t = setInterval(() => alive && tick(), 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const upd = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const save = async () => {
    try {
      await applySettings(draft);
      toast("Réglages enregistrés", "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const pickDir = async (k: "outputsDir" | "modelsDir" | "hunyuanDir") => {
    const dir = await open({ directory: true, defaultPath: draft[k] });
    if (dir && !Array.isArray(dir)) upd(k, dir);
  };
  const act = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try {
      await fn();
      if (ok) toast(ok, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const gpu = live?.gpu;
  return (
    <div className="page settings">
      <header className="page-head">
        <div>
          <h1>Réglages</h1>
          <p className="muted">Matériel, moteur et dossiers.</p>
        </div>
        <button className="btn primary" disabled={!dirty} onClick={save}>
          Enregistrer
        </button>
      </header>

      <div className="settings-grid">
        <Section title="Matériel">
          {system?.gpus.map((g) => (
            <div key={g.name} className="kv">
              <span>GPU</span>
              <strong>
                {g.name} · {(g.vramMb / 1024).toFixed(0)} Go · CC {g.computeCap}
              </strong>
            </div>
          ))}
          {gpu?.cuda && gpu.vram_total != null && (
            <div className="kv">
              <span>VRAM libre</span>
              <strong>
                {bytes(gpu.vram_free)} / {bytes(gpu.vram_total)} · torch {gpu.torch} (CUDA {gpu.cuda_version})
              </strong>
            </div>
          )}
          <div className="kv">
            <span>Modèles chargés</span>
            <strong>{health?.loaded.length ? health.loaded.join(", ") : "aucun"}</strong>
          </div>
          <div className="kv">
            <span>CUDA Toolkit</span>
            <strong>{system?.cudaToolkit ? `${system.cudaToolkit.version}` : <Badge tone="warn">absent</Badge>}</strong>
          </div>
          <div className="kv">
            <span>MSVC</span>
            <strong>{system?.vcvars ? "OK" : <Badge tone="warn">absent</Badge>}</strong>
          </div>
          <button className="btn ghost sm" disabled={!health || health.busy} onClick={act(() => api.unload(), "VRAM libérée")}>
            Libérer la VRAM
          </button>
        </Section>

        <Section title="Profil VRAM">
          <div className="profile-list">
            {PROFILES.map((p) => (
              <button key={p.value} className={`profile ${draft.vramProfile === p.value ? "active" : ""}`} onClick={() => upd("vramProfile", p.value)}>
                <strong>
                  {p.label}
                  {system?.recommendedProfile === p.value && <Badge tone="accent">recommandé</Badge>}
                </strong>
                <span>{p.text}</span>
              </button>
            ))}
          </div>
          <Toggle checked={draft.flashvdm} onChange={(v) => upd("flashvdm", v)} label="FlashVDM" hint="décodage du volume accéléré (recommandé)" />
        </Section>

        <Section title="Texte → image">
          <Field label="Modèle Hugging Face (diffusers)" hint="sdxl-turbo : 4 pas, rapide">
            <input className="input mono" value={draft.t2iModel} onChange={(e) => upd("t2iModel", e.target.value.trim())} />
          </Field>
        </Section>

        <Section title="Dossiers">
          {(
            [
              ["outputsDir", "Bibliothèque (sorties)"],
              ["hunyuanDir", "Poids Hunyuan3D-2.1"],
              ["modelsDir", "Autres modèles"],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label}>
              <div className="row">
                <input className="input mono" value={draft[k]} onChange={(e) => upd(k, e.target.value)} />
                <button className="icon-btn" title="Choisir" onClick={() => pickDir(k)}>
                  <Icon.folder />
                </button>
                <button className="icon-btn" title="Ouvrir" onClick={() => tauri.openPath(draft[k])}>
                  <Icon.external />
                </button>
              </div>
            </Field>
          ))}
          <Field label="Runtime Python">
            <div className="row">
              <input className="input mono" value={draft.runtimeDir} readOnly />
              <button className="icon-btn" onClick={() => tauri.openPath(draft.runtimeDir)}>
                <Icon.external />
              </button>
            </div>
          </Field>
        </Section>

        <Section title="Moteur">
          <div className="steps compact">
            {runtime?.steps.map((s) => (
              <div key={s.id} className={`step ${s.done ? "done" : ""}`}>
                {s.done ? <Icon.check size={14} /> : <Icon.x size={14} />} {s.label}
              </div>
            ))}
          </div>
          <div className="kv">
            <span>Extensions natives</span>
            <strong>
              rasterizer {runtime?.native.rasterizer ? "✓" : "✗"} · inpaint {runtime?.native.inpaint ? "✓" : "✗"}
            </strong>
          </div>
          <div className="row wrap">
            <button className="btn" disabled={runtime?.installing} onClick={act(() => tauri.runtimeInstall(false, ["native", "verify"]), "Compilation lancée")}>
              Recompiler les extensions
            </button>
            <button className="btn" disabled={runtime?.installing} onClick={act(() => tauri.runtimeInstall(false, ["verify"]), "Vérification lancée")}>
              Vérifier
            </button>
            <button className="btn ghost" disabled={runtime?.installing} onClick={act(() => tauri.runtimeInstall(false, ["deps", "verify"]), "Réinstallation des dépendances")}>
              Réparer les dépendances
            </button>
          </div>
        </Section>

        <Section title="Serveur local">
          <div className="kv">
            <span>État</span>
            <strong>
              {backend?.running ? <Badge tone="ok">actif{backend.external ? " (externe)" : ""}</Badge> : <Badge tone="error">arrêté</Badge>}
              {health && ` · v${health.version}`}
            </strong>
          </div>
          <div className="kv">
            <span>API</span>
            <strong className="mono">{apiBase()}</strong>
          </div>
          <p className="note">
            API REST locale : <code>POST /jobs</code> (multipart <code>spec</code> + <code>image</code>), <code>GET /jobs/&lt;id&gt;</code>, <code>GET /library</code>,
            <code> GET /files/&lt;id&gt;/textured.glb</code>. Pratique pour scripter des lots ou brancher Blender.
          </p>
          <div className="row">
            <button className="btn" onClick={act(() => tauri.backendRestart(), "Serveur redémarré")}>
              <Icon.refresh size={15} /> Redémarrer
            </button>
            <button className="btn ghost" onClick={act(() => tauri.backendStop())}>
              <Icon.stop size={15} /> Arrêter
            </button>
          </div>
          <Toggle checked={draft.autoStart} onChange={(v) => upd("autoStart", v)} label="Démarrer le moteur avec l'app" />
        </Section>

        <Section title="Journal du moteur">
          <LogConsole lines={logs} height={240} />
        </Section>

        <Section title="Licence">
          <p className="note">
            Hunyuan3D 2.1 est distribué sous la <em>Tencent Hunyuan Community License</em>, qui <strong>exclut l'Union européenne, le Royaume-Uni et la
            Corée du Sud</strong> de son territoire. Vérifie que ton usage est couvert avant d'exploiter les modèles ou leurs sorties.
          </p>
          <button className="btn ghost sm" onClick={() => tauri.openUrl("https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE")}>
            Lire la licence <Icon.external size={13} />
          </button>
        </Section>
      </div>
    </div>
  );
}

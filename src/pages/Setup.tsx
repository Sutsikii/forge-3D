import { useEffect, useState } from "react";
import { on, tauri } from "../lib/tauri";
import { bytes, errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { applySettings } from "../lib/actions";
import { Badge, LogConsole, Progress } from "../components/controls";
import { Icon } from "../components/icons";

type StepState = "pending" | "running" | "done" | "warning" | "error";

export function Setup() {
  const settings = useStore((s) => s.settings)!;
  const system = useStore((s) => s.system);
  const runtime = useStore((s) => s.runtime);
  const set = useStore((s) => s.set);
  const [logs, setLogs] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, { state: StepState; message: string }>>({});
  const [dl, setDl] = useState<{ id: string; done: number; total: number } | null>(null);
  const [accepted, setAccepted] = useState(settings.licenseAccepted);
  const installing = runtime?.installing ?? false;

  useEffect(() => {
    tauri.runtimeLogs().then(setLogs);
    const subs = [
      on<string>("runtime://log", (line) => setLogs((l) => (l.length > 3000 ? [...l.slice(-2500), line] : [...l, line]))),
      on<{ id: string; status: StepState; message: string }>("runtime://step", (e) =>
        setStates((s) => ({ ...s, [e.id]: { state: e.status, message: e.message } })),
      ),
      on<{ id: string; done: number; total: number }>("runtime://progress", setDl),
      on<{ ok: boolean; error?: string }>("runtime://finished", async (e) => {
        set({ runtime: await tauri.runtimeStatus() });
        setDl(null);
        if (e.ok) {
          toast("Moteur installé", "success");
          await tauri.backendStart().catch((err) => toast(errorText(err), "error"));
        } else toast(e.error ?? "Installation interrompue", "error");
      }),
    ];
    return () => subs.forEach((p) => p.then((u) => u()));
  }, [set]);

  const start = async (force = false) => {
    try {
      if (!settings.licenseAccepted) await applySettings({ ...settings, licenseAccepted: true });
      setStates({});
      await tauri.runtimeInstall(force, null);
      set({ runtime: await tauri.runtimeStatus() });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const gpu = system?.gpus[0];
  const checks: { label: string; ok: boolean | null; value: string; hint?: string }[] = [
    { label: "GPU NVIDIA", ok: !!gpu, value: gpu ? `${gpu.name} · ${(gpu.vramMb / 1024).toFixed(0)} Go` : "non détecté", hint: "CUDA requis" },
    {
      label: "VRAM",
      ok: gpu ? gpu.vramMb >= 10000 : null,
      value: gpu ? (gpu.vramMb >= 20000 ? "forme + texture confortables" : gpu.vramMb >= 10000 ? "OK en profil Économe" : "insuffisant (< 10 Go)") : "–",
    },
    { label: "Espace disque", ok: system?.diskFreeGb != null ? system.diskFreeGb > 40 : null, value: system?.diskFreeGb != null ? `${system.diskFreeGb.toFixed(0)} Go libres` : "–", hint: "~15 Go runtime + ~26 Go modèles" },
    { label: "uv", ok: true, value: system?.uv ? "trouvé" : "sera téléchargé" },
    { label: "Visual Studio C++", ok: system ? !!system.vcvars : null, value: system?.vcvars ? "OK" : "absent — requis pour la texture", hint: "Build Tools « Desktop C++ »" },
    {
      label: "CUDA Toolkit 12.x",
      ok: system ? !!system.cudaToolkit : null,
      value: system?.cudaToolkit ? system.cudaToolkit.version : "absent — requis pour la texture",
      hint: "winget install Nvidia.CUDA --version 12.4",
    },
  ];

  const anyState = Object.keys(states).length > 0;
  return (
    <div className="setup">
      <div className="setup-hero">
        <div className="brand-mark big">
          <Icon.cube size={34} />
        </div>
        <h1>Forge3D Studio</h1>
        <p>Studio local de génération 3D par IA, propulsé par Hunyuan3D 2.1. Première étape : installer le moteur Python isolé (rien ne touche à ton système).</p>
      </div>

      <div className="setup-grid">
        <div className="card-box">
          <h3>Ta machine</h3>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.label}>
                <span className={`check ${c.ok === true ? "ok" : c.ok === false ? "bad" : ""}`}>{c.ok ? <Icon.check size={14} /> : c.ok === false ? <Icon.alert size={14} /> : "·"}</span>
                <span className="check-label">{c.label}</span>
                <span className="check-value">
                  {c.value}
                  {c.ok === false && c.hint && <small className="mono">{c.hint}</small>}
                </span>
              </li>
            ))}
          </ul>
          <p className="note">Sans CUDA Toolkit / MSVC, la génération de forme fonctionne ; seule la texture PBR attendra la compilation des extensions (faisable plus tard depuis les Réglages).</p>
        </div>

        <div className="card-box">
          <h3>Installation</h3>
          <div className="steps">
            {(runtime?.steps ?? []).map((s) => {
              const st = states[s.id]?.state ?? (s.done ? "done" : "pending");
              return (
                <div key={s.id} className={`step ${st}`}>
                  <span className="step-dot">{st === "done" ? <Icon.check size={13} /> : st === "error" || st === "warning" ? <Icon.alert size={13} /> : null}</span>
                  <div>
                    <strong>{s.label}</strong>
                    {states[s.id]?.message && st !== "running" && <small>{states[s.id].message}</small>}
                    {st === "running" && dl && dl.id === s.id && (
                      <div className="step-progress">
                        <Progress value={dl.total ? dl.done / dl.total : 0} indeterminate={!dl.total} />
                        <small>
                          {bytes(dl.done)} {dl.total ? `/ ${bytes(dl.total)}` : ""}
                        </small>
                      </div>
                    )}
                    {st === "running" && !(dl && dl.id === s.id) && <Progress value={0} indeterminate />}
                  </div>
                </div>
              );
            })}
          </div>

          {!installing && (
            <label className="license">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>
                J'ai lu la <a onClick={() => tauri.openUrl("https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE")}>licence Tencent Hunyuan Community</a>, qui exclut
                l'UE, le Royaume-Uni et la Corée du Sud, et je suis responsable de mon usage.
              </span>
            </label>
          )}
          <div className="row">
            {installing ? (
              <button className="btn" onClick={() => tauri.runtimeCancel()}>
                <Icon.stop size={15} /> Annuler
              </button>
            ) : (
              <>
                <button className="btn primary lg" disabled={!accepted} onClick={() => start(false)}>
                  <Icon.download /> {anyState || runtime?.steps.some((s) => s.done) ? "Reprendre l'installation" : "Installer le moteur"}
                </button>
                {runtime?.steps.some((s) => s.done) && (
                  <button className="btn ghost" disabled={!accepted} onClick={() => start(true)}>
                    Tout réinstaller
                  </button>
                )}
              </>
            )}
            <span className="muted small">~6 Go de paquets · 10 à 25 min</span>
          </div>
          {runtime?.lastError && !installing && (
            <p className="job-error">
              <Badge tone="error">Dernière erreur</Badge> {runtime.lastError}
            </p>
          )}
        </div>
      </div>
      <div className="card-box">
        <h3>Journal</h3>
        <LogConsole lines={logs} height={280} />
      </div>
    </div>
  );
}

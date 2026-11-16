import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { tauri } from "../lib/tauri";
import { bytes, errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Badge, Progress } from "../components/controls";
import { Icon } from "../components/icons";
import { applySettings } from "../lib/actions";

export function Models() {
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings)!;
  const health = useStore((s) => s.health);
  const [probing, setProbing] = useState(false);
  const missing = models.filter((m) => !m.installed && m.id !== "t2i");
  const totalMissing = missing.reduce((a, m) => a + m.size_gb, 0);

  const download = async (id: string) => {
    try {
      await api.downloadModel(id);
      useStore.getState().set({ models: await api.models() });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const useExisting = async () => {
    const dir = await open({ directory: true, title: "Dossier tencent/Hunyuan3D-2.1 (contenant hunyuan3d-dit-v2-1)" });
    if (!dir || Array.isArray(dir)) return;
    setProbing(true);
    try {
      const probe = await tauri.probeWeights(dir);
      if (!probe.shape && !probe.paint) {
        toast("Ce dossier ne contient ni hunyuan3d-dit-v2-1 ni hunyuan3d-paintpbr-v2-1", "error");
        return;
      }
      await applySettings({ ...settings, hunyuanDir: dir });
      toast(`Poids détectés : ${[probe.shape && "forme", probe.paint && "texture"].filter(Boolean).join(" + ")}`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Modèles</h1>
          <p className="muted">Tout tourne en local. Télécharge uniquement ce dont tu as besoin.</p>
        </div>
        <div className="row">
          {missing.length > 0 && (
            <button className="btn primary" onClick={() => missing.forEach((m) => !m.download && download(m.id))}>
              <Icon.download size={15} /> Tout installer (~{totalMissing.toFixed(1)} Go)
            </button>
          )}
        </div>
      </header>

      <div className="callout">
        <Icon.folder />
        <div>
          <strong>Poids Hunyuan3D</strong>
          <p className="mono">{settings.hunyuanDir}</p>
          <p className="muted">Tu as déjà cloné tencent/Hunyuan3D-2.1 depuis Hugging Face ? Pointe simplement sur ce dossier, rien ne sera re-téléchargé.</p>
        </div>
        <button className="btn" disabled={probing} onClick={useExisting}>
          Utiliser un dossier existant
        </button>
      </div>

      {!health && <p className="note warn">Le moteur n'est pas démarré : l'état des modèles est indisponible.</p>}

      <div className="model-list">
        {models.map((m) => {
          const dl = m.download;
          const running = dl?.status === "running";
          return (
            <div key={m.id} className={`model ${m.installed ? "installed" : ""}`}>
              <div className="model-icon">{m.installed ? <Icon.check /> : <Icon.chip />}</div>
              <div className="model-body">
                <div className="model-title">
                  <strong>{m.name}</strong>
                  {m.required && <Badge tone="accent">Essentiel</Badge>}
                  {m.installed ? <Badge tone="ok">Installé</Badge> : <Badge>~{m.size_gb} Go</Badge>}
                </div>
                <p>{m.role}</p>
                <p className="muted mono small">{m.source} → {m.path}</p>
                {running && dl && (
                  <div className="model-progress">
                    <Progress value={dl.progress} indeterminate={!dl.total} />
                    <span className="muted small">
                      {bytes(dl.done)} / {dl.total ? bytes(dl.total) : "?"} · {bytes(dl.speed)}/s
                    </span>
                  </div>
                )}
                {dl?.status === "error" && <p className="job-error">{dl.error}</p>}
              </div>
              <div className="model-actions">
                {!m.installed && (
                  <button className="btn" disabled={running || !health} onClick={() => download(m.id)}>
                    <Icon.download size={15} /> {running ? "…" : dl?.status === "error" ? "Réessayer" : "Télécharger"}
                  </button>
                )}
                <button className="icon-btn" title="Ouvrir le dossier" onClick={() => tauri.openPath(m.path.replace(/[\\/][^\\/]+\.(pth|onnx)$/i, ""))}>
                  <Icon.folder />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api, type Job } from "../lib/api";
import { duration, errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Badge, Progress } from "./controls";
import { Icon } from "./icons";

const STATUS: Record<Job["status"], { label: string; tone: "neutral" | "ok" | "warn" | "error" | "accent" }> = {
  queued: { label: "En attente", tone: "neutral" },
  running: { label: "En cours", tone: "accent" },
  done: { label: "Terminé", tone: "ok" },
  error: { label: "Erreur", tone: "error" },
  cancelled: { label: "Annulé", tone: "warn" },
};

const KIND = { image: "Image → 3D", text: "Texte → 3D", texture: "Texture" };

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function JobCard({ job, compact = false }: { job: Job; compact?: boolean }) {
  const go = useStore((s) => s.go);
  const set = useStore((s) => s.set);
  const active = job.status === "running" || job.status === "queued";
  const now = useNow(active);
  const elapsed = job.started ? (job.finished ?? now) - job.started : null;
  const eta = job.status === "running" && job.progress > 0.05 && elapsed ? elapsed / job.progress - elapsed : null;
  const st = STATUS[job.status];

  const cancel = async () => {
    try {
      await api.cancelJob(job.id);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div className={`job ${job.status} ${compact ? "compact" : ""}`}>
      <div className="job-head">
        <div className="job-title">
          <strong>{job.name || "Sans titre"}</strong>
          <span className="muted">{KIND[job.kind]}</span>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      {job.status === "running" && (
        <>
          <div className="job-stages">
            {job.stages.map((s, i) => {
              const idx = job.stages.findIndex((x) => x.id === job.stage);
              return (
                <span key={s.id} className={i < idx ? "done" : i === idx ? "current" : ""}>
                  {s.label}
                </span>
              );
            })}
          </div>
          <Progress value={job.progress} />
          <div className="job-meta">
            <span>{job.detail || job.stage_label}</span>
            <span>
              {Math.round(job.progress * 100)} % · {duration(elapsed)}
              {eta != null && ` · reste ~${duration(eta)}`}
            </span>
          </div>
        </>
      )}
      {job.status === "error" && <p className="job-error">{job.error}</p>}
      {job.status === "done" && !compact && (
        <div className="job-meta">
          <span>Durée {duration(elapsed)}</span>
          <span className="muted">
            {Object.entries(job.timings)
              .map(([k, v]) => `${k} ${duration(v)}`)
              .join(" · ")}
          </span>
        </div>
      )}
      <div className="job-actions">
        {active && (
          <button className="btn ghost sm" onClick={cancel}>
            <Icon.stop size={14} /> {job.status === "queued" ? "Retirer" : "Annuler"}
          </button>
        )}
        {job.status === "done" && (
          <button
            className="btn ghost sm"
            onClick={() => {
              set({ focusItem: job.item_id });
              go("library");
            }}
          >
            <Icon.library size={14} /> Ouvrir
          </button>
        )}
      </div>
    </div>
  );
}

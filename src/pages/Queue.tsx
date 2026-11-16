import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { Empty } from "../components/controls";
import { JobCard } from "../components/JobCard";
import { Icon } from "../components/icons";

export function Queue() {
  const jobs = useStore((s) => s.jobs);
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").reverse();
  const finished = jobs.filter((j) => !(j.status === "running" || j.status === "queued"));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>File d'attente</h1>
          <p className="muted">Un seul GPU : les tâches passent l'une après l'autre. Tu peux en empiler autant que tu veux.</p>
        </div>
        {finished.length > 0 && (
          <button className="btn ghost" onClick={() => api.clearJobs().catch(() => undefined)}>
            <Icon.trash size={15} /> Vider l'historique
          </button>
        )}
      </header>
      {jobs.length === 0 && (
        <Empty icon={<Icon.queue size={36} />} title="Rien en cours">
          Lance une génération depuis l'onglet Créer.
        </Empty>
      )}
      {active.length > 0 && (
        <div className="job-list">
          <h3 className="list-title">En cours · {active.length}</h3>
          {active.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      )}
      {finished.length > 0 && (
        <div className="job-list">
          <h3 className="list-title">Historique de la session</h3>
          {finished.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}

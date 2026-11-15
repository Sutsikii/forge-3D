import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, type LibraryItem, type ShapeParams, type TextureParams } from "../lib/api";
import { errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Field, Section, Segmented, Toggle } from "../components/controls";
import { ImageDrop } from "../components/ImageDrop";
import { JobCard } from "../components/JobCard";
import { ShapeControls, TextureControls, shapeDefaults, textureDefaults } from "../components/ParamControls";
import { ViewerPanel } from "../components/ViewerPanel";
import type { ViewerHandle } from "../components/Viewer3D";
import { Icon } from "../components/icons";
import { useThumbnail } from "../lib/useThumbnail";

type Mode = "image" | "text";
const LS_KEY = "forge3d.create.v1";

function loadSaved(): { shape?: ShapeParams; texture?: TextureParams; removeBg?: string; mode?: Mode } {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function Create() {
  const settings = useStore((s) => s.settings)!;
  const health = useStore((s) => s.health);
  const jobs = useStore((s) => s.jobs);
  const library = useStore((s) => s.library);
  const draft = useStore((s) => s.draft);
  const set = useStore((s) => s.set);
  const caps = health?.capabilities;
  const profile = settings.vramProfile;
  const saved = useMemo(loadSaved, []);

  const [mode, setMode] = useState<Mode>(saved.mode ?? "image");
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState(true);
  const [removeBg, setRemoveBg] = useState<"auto" | "always" | "never">((saved.removeBg as "auto") ?? "auto");
  const [name, setName] = useState("");
  const [shape, setShape] = useState<ShapeParams>({ ...shapeDefaults(profile), ...saved.shape });
  const [texture, setTexture] = useState<TextureParams>({ ...textureDefaults(profile), ...saved.texture });
  const [jobId, setJobId] = useState<string | null>(null);
  const [shownId, setShownId] = useState<string | null>(library[0]?.id ?? null);
  const [variant, setVariant] = useState<"textured" | "shape">("textured");
  const [submitting, setSubmitting] = useState(false);
  const viewer = useRef<ViewerHandle>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ shape, texture, removeBg, mode }));
    } catch {
      /* storage unavailable */
    }
  }, [shape, texture, removeBg, mode]);

  // Prefill coming from the library ("Régénérer").
  useEffect(() => {
    if (!draft || draft.page !== "create") return;
    set({ draft: null });
    if (draft.params?.shape) setShape({ ...shapeDefaults(profile), ...draft.params.shape });
    if (draft.params?.texture) setTexture({ ...textureDefaults(profile), ...draft.params.texture });
    if (draft.params?.prompt) {
      setMode("text");
      setPrompt(draft.params.prompt);
    } else setMode("image");
    if (draft.name) setName(draft.name);
    if (draft.sourceUrl)
      fetch(draft.sourceUrl)
        .then((r) => r.blob())
        .then((b) => setFile(new File([b], "source.png", { type: b.type || "image/png" })))
        .catch(() => toast("Image source introuvable", "error"));
  }, [draft, profile, set]);

  const job = jobs.find((j) => j.id === jobId) ?? null;
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (job.status === "done" && lastStatus.current !== "done") {
      setShownId(job.item_id);
      setVariant("textured");
    }
    if (job.status === "error" && lastStatus.current !== "error") toast(job.error || "Échec", "error");
    lastStatus.current = job.status;
  }, [job]);

  const shown: LibraryItem | null = library.find((i) => i.id === shownId) ?? null;
  const shapeUrl = shown ? fileUrl(shown, "shape") : null;
  const texUrl = shown ? fileUrl(shown, "textured") : null;
  const src = variant === "textured" ? texUrl ?? shapeUrl : shapeUrl ?? texUrl;
  const onLoaded = useThumbnail(shown, viewer);

  const textureAvailable = !!caps?.paint;
  const canGo =
    !!caps?.shape &&
    !submitting &&
    (mode === "image" ? !!file : prompt.trim().length > 2 && !!caps?.text);

  const submit = useCallback(async () => {
    if (!canGo) return;
    setSubmitting(true);
    try {
      const params = {
        shape,
        texture: { ...texture, enabled: texture.enabled && textureAvailable },
        remove_bg: removeBg,
        ...(mode === "text" ? { prompt, t2i: { style_suffix: style } } : {}),
      };
      const j = await api.createJob({ kind: mode, name, params }, mode === "image" ? file : null, file?.name);
      setJobId(j.id);
      set({ jobs: [j, ...useStore.getState().jobs] });
      toast(jobs.some((x) => x.status === "running") ? "Ajouté à la file d'attente" : "Génération lancée");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSubmitting(false);
    }
  }, [canGo, shape, texture, textureAvailable, removeBg, mode, prompt, style, name, file, set, jobs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

  const recent = library.slice(0, 12);
  const activeOverlay =
    job && (job.status === "running" || job.status === "queued") ? <JobCard job={job} compact /> : null;

  return (
    <div className="studio">
      <aside className="panel">
        <div className="panel-scroll">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "image", label: <><Icon.image size={15} /> Image → 3D</> },
              { value: "text", label: <><Icon.text size={15} /> Texte → 3D</> },
            ]}
          />

          {mode === "image" ? (
            <Section title="Image de référence">
              <ImageDrop file={file} onFile={setFile} paste hint="glisser, cliquer ou Ctrl+V · PNG détouré idéal" />
              <Field label="Arrière-plan">
                <Segmented
                  size="sm"
                  value={removeBg}
                  onChange={setRemoveBg}
                  options={[
                    { value: "auto", label: "Auto", title: "Détoure sauf si l'image a déjà de la transparence" },
                    { value: "always", label: "Détourer" },
                    { value: "never", label: "Garder" },
                  ]}
                />
              </Field>
            </Section>
          ) : (
            <Section title="Description">
              <textarea
                className="input"
                rows={4}
                placeholder="ex. une lanterne de pirate en laiton, style low-poly stylisé"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <Toggle checked={style} onChange={setStyle} label="Cadrage « objet isolé »" hint="ajoute fond blanc, objet centré" />
              {!caps?.text && (
                <p className="note warn">
                  <Icon.alert size={14} /> Installe le modèle texte → image dans l'onglet Modèles.
                </p>
              )}
              <p className="note">Le texte est d'abord transformé en image ({settings.t2iModel}), puis en 3D. Les prompts en anglais donnent de meilleurs résultats.</p>
            </Section>
          )}

          <Field label="Nom">
            <input className="input" value={name} placeholder="automatique" onChange={(e) => setName(e.target.value)} />
          </Field>

          <ShapeControls value={shape} onChange={setShape} profile={profile} />
          <TextureControls value={texture} onChange={setTexture} available={textureAvailable} missing={caps?.paint_missing} />
        </div>
        <div className="panel-foot">
          {!caps?.shape && health && <p className="note warn">Modèle de forme non installé → onglet Modèles.</p>}
          <button className="btn primary block lg" disabled={!canGo} onClick={submit}>
            <Icon.spark /> Générer
            <kbd>Ctrl ↵</kbd>
          </button>
        </div>
      </aside>

      <main className="stage">
        <ViewerPanel
          ref={viewer}
          src={src}
          variant={variant}
          onVariant={(v) => setVariant(v as "textured" | "shape")}
          variants={[
            { id: "textured", label: "Texturé", src: texUrl },
            { id: "shape", label: "Forme brute", src: shapeUrl },
          ]}
          onLoaded={onLoaded}
          overlay={activeOverlay}
          toolbarExtra={shown && <span className="viewer-title">{shown.name}</span>}
          empty={
            <div className="hero-empty">
              <Icon.cube size={44} />
              <h2>Donne une image, récupère un asset 3D</h2>
              <p>Hunyuan3D 2.1 génère la forme puis une texture PBR (albedo, métal, rugosité). Résultat en GLB, prêt pour Blender, Unity ou Unreal.</p>
            </div>
          }
        />
        {recent.length > 0 && (
          <div className="filmstrip">
            {recent.map((it) => {
              const thumb = fileUrl(it, "thumb") ?? fileUrl(it, "input");
              return (
                <button key={it.id} className={`film ${it.id === shownId ? "active" : ""}`} title={it.name} onClick={() => setShownId(it.id)}>
                  {thumb ? <img src={thumb} alt="" /> : <Icon.cube />}
                  {it.available.textured && <span className="dot" />}
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

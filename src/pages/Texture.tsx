import { useEffect, useRef, useState } from "react";
import { api, fileUrl, type TextureParams } from "../lib/api";
import { errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Field, Section, Segmented } from "../components/controls";
import { ImageDrop } from "../components/ImageDrop";
import { JobCard } from "../components/JobCard";
import { TextureControls, textureDefaults } from "../components/ParamControls";
import { ViewerPanel } from "../components/ViewerPanel";
import type { ViewerHandle } from "../components/Viewer3D";
import { Icon } from "../components/icons";
import { useThumbnail } from "../lib/useThumbnail";

type Source = "file" | "library";

export function Texture() {
  const settings = useStore((s) => s.settings)!;
  const health = useStore((s) => s.health);
  const library = useStore((s) => s.library);
  const jobs = useStore((s) => s.jobs);
  const draft = useStore((s) => s.draft);
  const set = useStore((s) => s.set);
  const caps = health?.capabilities;

  const [source, setSource] = useState<Source>("file");
  const [mesh, setMesh] = useState<File | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [itemId, setItemId] = useState<string>("");
  const [useItemImage, setUseItemImage] = useState(true);
  const [params, setParams] = useState<TextureParams>(textureDefaults(settings.vramProfile));
  const [jobId, setJobId] = useState<string | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const viewer = useRef<ViewerHandle>(null);

  useEffect(() => {
    if (!draft || draft.page !== "texture") return;
    set({ draft: null });
    if (draft.targetItem) {
      setSource("library");
      setItemId(draft.targetItem);
      setUseItemImage(true);
    }
    if (draft.params?.texture) setParams({ ...params, ...draft.params.texture, enabled: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, set]);

  const item = library.find((i) => i.id === itemId) ?? null;
  const shapeItems = library.filter((i) => i.available.shape);
  const job = jobs.find((j) => j.id === jobId) ?? null;
  useEffect(() => {
    if (job?.status === "done") setResultId(job.item_id);
    if (job?.status === "error") toast(job.error || "Échec", "error");
  }, [job?.status, job?.item_id, job?.error]);

  const result = library.find((i) => i.id === resultId) ?? null;
  const resultUrl = result ? fileUrl(result, "textured") : null;
  const previewSrc: string | File | null =
    resultUrl ?? (source === "file" ? mesh : item ? fileUrl(item, "textured") ?? fileUrl(item, "shape") : null);
  const onLoaded = useThumbnail(result, viewer);

  const needImage = source === "file" || !useItemImage;
  const ready = !!caps?.paint && !busy && (source === "file" ? !!mesh && !!image : !!item && (!needImage || !!image));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setResultId(null);
    try {
      const p = { texture: { ...params, enabled: true }, remove_bg: "auto" as const, ...(source === "library" ? { target_item: itemId } : {}) };
      const j = await api.createJob({ kind: "texture", params: p }, needImage ? image : null, image?.name, source === "file" ? mesh : null);
      setJobId(j.id);
      set({ jobs: [j, ...useStore.getState().jobs] });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio">
      <aside className="panel">
        <div className="panel-scroll">
          <p className="lede">Peins une texture PBR sur n'importe quel maillage à partir d'une image de référence.</p>
          <Segmented
            value={source}
            onChange={(v) => {
              setSource(v);
              setResultId(null);
            }}
            options={[
              { value: "file", label: <><Icon.upload size={15} /> Fichier</> },
              { value: "library", label: <><Icon.library size={15} /> Bibliothèque</> },
            ]}
          />
          {source === "file" ? (
            <Section title="Maillage">
              <ImageDrop file={mesh} onFile={setMesh} kind="mesh" accept=".glb,.gltf,.obj,.ply,.stl,.off" label="Dépose un maillage" hint="GLB, OBJ, PLY, STL" />
            </Section>
          ) : (
            <Section title="Élément">
              {shapeItems.length ? (
                <div className="pick-list">
                  {shapeItems.map((it) => {
                    const thumb = fileUrl(it, "thumb") ?? fileUrl(it, "input");
                    return (
                      <button key={it.id} className={`pick ${it.id === itemId ? "active" : ""}`} onClick={() => setItemId(it.id)}>
                        {thumb ? <img src={thumb} alt="" /> : <Icon.cube />}
                        <span>{it.name}</span>
                        {it.available.textured && <small>déjà texturé</small>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="note">Aucune forme dans la bibliothèque pour l'instant.</p>
              )}
              {item && (
                <Segmented
                  size="sm"
                  value={useItemImage ? "item" : "other"}
                  onChange={(v) => setUseItemImage(v === "item")}
                  options={[
                    { value: "item", label: "Image d'origine" },
                    { value: "other", label: "Autre image" },
                  ]}
                />
              )}
            </Section>
          )}
          {needImage && (
            <Section title="Image de référence">
              <ImageDrop file={image} onFile={setImage} paste />
            </Section>
          )}
          <TextureControls value={{ ...params, enabled: true }} onChange={setParams} available={!!caps?.paint} missing={caps?.paint_missing} toggleable={false} />
          {source === "library" && item?.available.textured && (
            <Field label="">
              <p className="note">La texture existante de « {item.name} » sera remplacée.</p>
            </Field>
          )}
        </div>
        <div className="panel-foot">
          <button className="btn primary block lg" disabled={!ready} onClick={submit}>
            <Icon.brush /> Texturer
          </button>
        </div>
      </aside>
      <main className="stage">
        <ViewerPanel
          ref={viewer}
          src={previewSrc}
          onLoaded={onLoaded}
          overlay={job && (job.status === "running" || job.status === "queued") ? <JobCard job={job} compact /> : null}
          empty={
            <div className="hero-empty">
              <Icon.brush size={44} />
              <h2>Texture PBR multi-vues</h2>
              <p>Le modèle Paint génère 6 à 9 vues cohérentes, les super-résout puis les projette sur les UV : albedo, métal et rugosité.</p>
            </div>
          }
        />
      </main>
    </div>
  );
}

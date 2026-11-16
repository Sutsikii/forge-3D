import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, fileUrl, type LibraryItem } from "../lib/api";
import { tauri } from "../lib/tauri";
import { count, date, duration, errorText } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Badge, Empty, Field, Section, Segmented, Select, Slider } from "../components/controls";
import { ViewerPanel } from "../components/ViewerPanel";
import type { ViewerHandle } from "../components/Viewer3D";
import { Icon } from "../components/icons";
import { useThumbnail } from "../lib/useThumbnail";

type Filter = "all" | "textured" | "shape" | "text";

async function refreshLibrary() {
  const library = await api.library();
  useStore.getState().set({ library });
}

export function Library() {
  const library = useStore((s) => s.library);
  const focus = useStore((s) => s.focusItem);
  const set = useStore((s) => s.set);
  const go = useStore((s) => s.go);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(focus ?? library[0]?.id ?? null);

  useEffect(() => {
    if (focus) {
      setSelected(focus);
      set({ focusItem: null });
    }
  }, [focus, set]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return library.filter((i) => {
      if (filter === "textured" && !i.available.textured) return false;
      if (filter === "shape" && i.available.textured) return false;
      if (filter === "text" && i.kind !== "text") return false;
      return !q || i.name.toLowerCase().includes(q) || (i.prompt ?? "").toLowerCase().includes(q);
    });
  }, [library, query, filter]);

  const item = library.find((i) => i.id === selected) ?? null;

  return (
    <div className="library">
      <div className="library-main">
        <header className="page-head">
          <div>
            <h1>Bibliothèque</h1>
            <p className="muted">{library.length} élément(s)</p>
          </div>
          <div className="row">
            <input className="input search" placeholder="Rechercher…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "Tout" },
                { value: "textured", label: "Texturés" },
                { value: "shape", label: "Formes" },
                { value: "text", label: "Depuis texte" },
              ]}
            />
          </div>
        </header>
        {items.length === 0 ? (
          <Empty icon={<Icon.library size={36} />} title={library.length ? "Aucun résultat" : "Bibliothèque vide"}>
            {!library.length && (
              <button className="btn primary" onClick={() => go("create")}>
                Créer un premier modèle
              </button>
            )}
          </Empty>
        ) : (
          <div className="grid">
            {items.map((it) => {
              const thumb = fileUrl(it, "thumb") ?? fileUrl(it, "input");
              return (
                <button key={it.id} className={`card ${it.id === selected ? "active" : ""}`} onClick={() => setSelected(it.id)}>
                  <div className="card-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <Icon.cube size={32} />}</div>
                  <div className="card-body">
                    <strong>{it.name}</strong>
                    <span className="muted">{date(it.created)}</span>
                  </div>
                  <div className="card-tags">
                    {it.available.textured ? <Badge tone="ok">PBR</Badge> : it.available.shape ? <Badge>Forme</Badge> : <Badge tone="warn">Incomplet</Badge>}
                    {it.kind === "text" && <Badge tone="accent">Texte</Badge>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {item && <Detail key={item.id} item={item} onDeleted={() => setSelected(null)} />}
    </div>
  );
}

function Detail({ item, onDeleted }: { item: LibraryItem; onDeleted: () => void }) {
  const set = useStore((s) => s.set);
  const go = useStore((s) => s.go);
  const [variant, setVariant] = useState<"textured" | "shape">(item.available.textured ? "textured" : "shape");
  const [name, setName] = useState(item.name);
  const [fmt, setFmt] = useState("glb");
  const [maxFaces, setMaxFaces] = useState(0);
  const [exporting, setExporting] = useState(false);
  const viewer = useRef<ViewerHandle>(null);
  const onLoaded = useThumbnail(item, viewer);
  const shapeUrl = fileUrl(item, "shape");
  const texUrl = fileUrl(item, "textured");
  const src = variant === "textured" ? texUrl ?? shapeUrl : shapeUrl;
  const input = fileUrl(item, "input");
  const stats = item.stats?.[variant] ?? item.stats?.shape;
  const sh = item.params?.shape;

  const rename = async () => {
    if (name.trim() && name !== item.name) {
      await api.updateItem(item.id, { name: name.trim() }).catch((e) => toast(errorText(e), "error"));
      refreshLibrary();
    }
  };

  const remove = async () => {
    if (!(await ask(`Supprimer « ${item.name} » et ses fichiers ?`, { title: "Forge3D", kind: "warning" }))) return;
    try {
      await api.deleteItem(item.id);
      onDeleted();
      refreshLibrary();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const { path } = await api.exportItem(item.id, variant, fmt, variant === "shape" ? maxFaces : 0);
      toast("Export prêt", "success");
      tauri.revealPath(path);
      refreshLibrary();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setExporting(false);
    }
  };

  const mainFile = item.available[variant]?.name;

  return (
    <aside className="detail">
      <div className="detail-viewer">
        <ViewerPanel
          ref={viewer}
          src={src}
          variant={variant}
          onVariant={(v) => setVariant(v as "textured" | "shape")}
          variants={[
            { id: "textured", label: "Texturé", src: texUrl },
            { id: "shape", label: "Forme", src: shapeUrl },
          ]}
          onLoaded={onLoaded}
        />
      </div>
      <div className="detail-scroll">
        <input className="input title-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <div className="detail-meta">
          {input && <img className="detail-input" src={input} alt="" />}
          <dl>
            <dt>Créé</dt>
            <dd>{date(item.created)}</dd>
            {item.prompt && (
              <>
                <dt>Prompt</dt>
                <dd>{item.prompt}</dd>
              </>
            )}
            {stats && (
              <>
                <dt>Maillage</dt>
                <dd>
                  {count(stats.faces)} faces · {count(stats.vertices)} sommets{stats.watertight ? " · étanche" : ""}
                </dd>
              </>
            )}
            {sh && (
              <>
                <dt>Forme</dt>
                <dd className="mono">
                  seed {item.seed ?? sh.seed} · {sh.steps} pas · cfg {sh.guidance} · octree {sh.octree}
                </dd>
              </>
            )}
            {item.timings && Object.keys(item.timings).length > 0 && (
              <>
                <dt>Temps</dt>
                <dd>
                  {Object.entries(item.timings)
                    .map(([k, v]) => `${k} ${duration(v)}`)
                    .join(" · ")}
                </dd>
              </>
            )}
          </dl>
        </div>

        <div className="actions">
          <button
            className="btn"
            disabled={!item.available.shape}
            onClick={() => {
              set({ draft: { page: "texture", targetItem: item.id, params: item.params } });
              go("texture");
            }}
          >
            <Icon.brush size={15} /> {item.available.textured ? "Re-texturer" : "Texturer"}
          </button>
          <button
            className="btn"
            onClick={() => {
              set({ draft: { page: "create", params: item.params, name: item.name, sourceUrl: fileUrl(item, "source") ?? input ?? undefined } });
              go("create");
            }}
          >
            <Icon.refresh size={15} /> Variante
          </button>
          <button className="btn" onClick={() => tauri.openPath(item.path)}>
            <Icon.folder size={15} /> Dossier
          </button>
          {mainFile && (
            <button className="btn" title="Ouvrir avec l'application par défaut" onClick={() => tauri.openPath(`${item.path}\\${mainFile}`)}>
              <Icon.external size={15} /> Ouvrir
            </button>
          )}
          <button className="btn danger" onClick={remove}>
            <Icon.trash size={15} />
          </button>
        </div>

        <Section title="Exporter">
          <div className="row">
            <Select
              value={fmt}
              onChange={setFmt}
              options={[
                { value: "glb", label: "GLB (PBR)" },
                { value: "obj", label: "OBJ + MTL" },
                { value: "ply", label: "PLY" },
                { value: "stl", label: "STL (impression 3D)" },
                { value: "off", label: "OFF" },
              ]}
            />
            <button className="btn primary" disabled={exporting || !item.available[variant]} onClick={doExport}>
              <Icon.download size={15} /> {exporting ? "Export…" : "Exporter"}
            </button>
          </div>
          {variant === "shape" && (
            <Field label="Décimation" hint={maxFaces ? "réduit le nombre de faces" : "aucune"}>
              <Slider value={maxFaces} min={0} max={200000} step={2500} onChange={setMaxFaces} format={(v) => (v ? `${(v / 1000).toFixed(1)} k` : "off")} />
            </Field>
          )}
          {variant === "textured" && <p className="note">Les textures sont conservées en GLB et OBJ ; PLY/STL n'exportent que la géométrie.</p>}
          {item.exports.length > 0 && <p className="note mono">exports/ : {item.exports.join(", ")}</p>}
        </Section>
      </div>
    </aside>
  );
}

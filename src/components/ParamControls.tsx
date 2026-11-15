import type { ShapeParams, TextureParams } from "../lib/api";
import type { VramProfile } from "../lib/tauri";
import { Field, Section, Segmented, Select, Slider, Toggle } from "./controls";
import { Icon } from "./icons";

export const PROFILE_DEFAULTS: Record<VramProfile, { octree: number; num_chunks: number; views: number; resolution: number; texture_size: number }> = {
  low: { octree: 256, num_chunks: 8000, views: 6, resolution: 512, texture_size: 2048 },
  balanced: { octree: 384, num_chunks: 20000, views: 6, resolution: 512, texture_size: 4096 },
  high: { octree: 384, num_chunks: 50000, views: 8, resolution: 768, texture_size: 4096 },
};

export type Preset = "draft" | "standard" | "quality" | "custom";

export function shapeDefaults(profile: VramProfile): ShapeParams {
  const p = PROFILE_DEFAULTS[profile];
  return {
    steps: 30,
    guidance: 5,
    octree: p.octree,
    num_chunks: p.num_chunks,
    seed: -1,
    remove_floaters: true,
    remove_degenerate: true,
    max_faces: 0,
  };
}

export function textureDefaults(profile: VramProfile): TextureParams {
  const p = PROFILE_DEFAULTS[profile];
  return { enabled: true, views: p.views, resolution: p.resolution, texture_size: p.texture_size, render_size: 2048, remesh: true };
}

export function applyPreset(preset: Preset, s: ShapeParams, profile: VramProfile): ShapeParams {
  const max = profile === "low" ? 384 : 512;
  if (preset === "draft") return { ...s, steps: 15, octree: 256 };
  if (preset === "standard") return { ...s, steps: 30, octree: PROFILE_DEFAULTS[profile].octree };
  if (preset === "quality") return { ...s, steps: 50, octree: max };
  return s;
}

export function detectPreset(s: ShapeParams, profile: VramProfile): Preset {
  for (const p of ["draft", "standard", "quality"] as Preset[]) {
    const x = applyPreset(p, s, profile);
    if (x.steps === s.steps && x.octree === s.octree) return p;
  }
  return "custom";
}

export function ShapeControls({ value, onChange, profile }: { value: ShapeParams; onChange: (v: ShapeParams) => void; profile: VramProfile }) {
  const set = <K extends keyof ShapeParams>(k: K, v: ShapeParams[K]) => onChange({ ...value, [k]: v });
  const preset = detectPreset(value, profile);
  return (
    <Section title="Forme">
      <Segmented
        value={preset}
        onChange={(p) => p !== "custom" && onChange(applyPreset(p, value, profile))}
        options={[
          { value: "draft", label: "Brouillon", title: "15 pas, octree 256 — aperçu rapide" },
          { value: "standard", label: "Standard" },
          { value: "quality", label: "Qualité", title: "50 pas, octree max" },
          { value: "custom", label: "Perso", disabled: preset !== "custom" },
        ]}
      />
      <Field label="Pas de diffusion" hint="plus = plus fidèle, plus lent">
        <Slider value={value.steps} min={5} max={100} onChange={(v) => set("steps", v)} />
      </Field>
      <Field label="Guidance" hint="adhérence à l'image">
        <Slider value={value.guidance} min={1} max={15} step={0.5} onChange={(v) => set("guidance", v)} format={(v) => v.toFixed(1)} />
      </Field>
      <Field label="Résolution d'octree" hint="finesse du maillage">
        <Segmented
          size="sm"
          value={value.octree}
          onChange={(v) => set("octree", v)}
          options={[192, 256, 384, 512].map((v) => ({
            value: v,
            label: String(v),
            title: v === 512 && profile === "low" ? "Gourmand en VRAM sur 12 Go" : undefined,
          }))}
        />
      </Field>
      <Field label="Seed">
        <div className="row">
          <input
            className="input mono"
            type="number"
            value={value.seed < 0 ? "" : value.seed}
            placeholder="aléatoire"
            onChange={(e) => set("seed", e.target.value === "" ? -1 : Math.max(0, Math.floor(Number(e.target.value))))}
          />
          <button className="icon-btn" title="Seed aléatoire à chaque génération" onClick={() => set("seed", -1)}>
            <Icon.dice />
          </button>
        </div>
      </Field>
      <Section title="Avancé" collapsible defaultOpen={false}>
        <Field label="Taille des blocs (num_chunks)" hint="baisser si manque de VRAM au décodage">
          <Select
            value={value.num_chunks}
            onChange={(v) => set("num_chunks", v)}
            options={[4000, 8000, 20000, 50000, 100000, 200000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }))}
          />
        </Field>
        <Toggle checked={value.remove_floaters} onChange={(v) => set("remove_floaters", v)} label="Supprimer les fragments flottants" />
        <Toggle checked={value.remove_degenerate} onChange={(v) => set("remove_degenerate", v)} label="Nettoyer les faces dégénérées" />
        <Field label="Limite de faces" hint={value.max_faces ? "décimation après génération" : "désactivée"}>
          <Slider
            value={value.max_faces}
            min={0}
            max={300000}
            step={5000}
            onChange={(v) => set("max_faces", v)}
            format={(v) => (v ? `${Math.round(v / 1000)} k` : "off")}
          />
        </Field>
      </Section>
    </Section>
  );
}

export function TextureControls({ value, onChange, available, missing, toggleable = true }: {
  value: TextureParams;
  onChange: (v: TextureParams) => void;
  available: boolean;
  missing?: string[];
  toggleable?: boolean;
}) {
  const set = <K extends keyof TextureParams>(k: K, v: TextureParams[K]) => onChange({ ...value, [k]: v });
  const enabled = available && (value.enabled || !toggleable);
  return (
    <Section
      title="Texture PBR"
      right={
        toggleable && (
          <Toggle checked={enabled} disabled={!available} onChange={(v) => set("enabled", v)} label="" />
        )
      }
    >
      {!available && (
        <p className="note warn">
          <Icon.alert size={14} /> Indisponible : {missing?.join(", ") || "modèles manquants"}.
        </p>
      )}
      {enabled && (
        <>
          <Field label="Vues générées" hint="couverture de la texture">
            <Slider value={value.views} min={6} max={9} onChange={(v) => set("views", v)} />
          </Field>
          <Field label="Résolution des vues">
            <Segmented size="sm" value={value.resolution} onChange={(v) => set("resolution", v)} options={[{ value: 512, label: "512" }, { value: 768, label: "768" }]} />
          </Field>
          <Field label="Taille de texture" hint="la carte finale est réduite de moitié">
            <Segmented size="sm" value={value.texture_size} onChange={(v) => set("texture_size", v)} options={[{ value: 2048, label: "2K" }, { value: 4096, label: "4K" }]} />
          </Field>
          <Toggle checked={value.remesh} onChange={(v) => set("remesh", v)} label="Remaillage avant peinture" hint="UV plus propres, recommandé" />
        </>
      )}
    </Section>
  );
}

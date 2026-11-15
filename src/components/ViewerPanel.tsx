import { forwardRef, useState, type ReactNode } from "react";
import { count } from "../lib/format";
import { Segmented } from "./controls";
import { Icon } from "./icons";
import { Viewer3D, type MeshStats, type ViewMode, type ViewerHandle } from "./Viewer3D";

interface Props {
  src: string | File | null;
  variants?: { id: string; label: string; src: string | null }[];
  variant?: string;
  onVariant?: (id: string) => void;
  overlay?: ReactNode;
  empty?: ReactNode;
  onLoaded?: () => void;
  toolbarExtra?: ReactNode;
}

export const ViewerPanel = forwardRef<ViewerHandle, Props>(function ViewerPanel(
  { src, variants, variant, onVariant, overlay, empty, onLoaded, toolbarExtra },
  ref,
) {
  const [mode, setMode] = useState<ViewMode>("pbr");
  const [rotate, setRotate] = useState(false);
  const [grid, setGrid] = useState(true);
  const [stats, setStats] = useState<MeshStats | null>(null);

  return (
    <div className="viewer-panel">
      <div className="viewer-toolbar">
        {variants && variants.length > 1 && (
          <Segmented
            size="sm"
            value={variant ?? variants[0].id}
            onChange={(v) => onVariant?.(v)}
            options={variants.map((v) => ({ value: v.id, label: v.label, disabled: !v.src }))}
          />
        )}
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "pbr", label: "Rendu", title: "Matériaux PBR" },
            { value: "clay", label: "Argile", title: "Forme sans texture" },
            { value: "wire", label: "Filaire", title: "Topologie" },
            { value: "normals", label: "Normales" },
            { value: "uv", label: "UV", title: "Damier UV" },
          ]}
        />
        <div className="spacer" />
        {toolbarExtra}
        <button className={`icon-btn ${rotate ? "on" : ""}`} title="Rotation automatique" onClick={() => setRotate(!rotate)}>
          <Icon.rotate />
        </button>
        <button className={`icon-btn ${grid ? "on" : ""}`} title="Grille" onClick={() => setGrid(!grid)}>
          <Icon.grid />
        </button>
        <button
          className="icon-btn"
          title="Recadrer"
          onClick={() => (ref && typeof ref !== "function" ? ref.current?.resetView() : undefined)}
        >
          <Icon.target />
        </button>
      </div>
      <Viewer3D ref={ref} src={src} mode={mode} autoRotate={rotate} grid={grid} onStats={setStats} onLoaded={onLoaded} empty={empty} />
      {stats && (
        <div className="viewer-stats">
          <span>{count(stats.triangles)} triangles</span>
          <span>{count(stats.vertices)} sommets</span>
          <span>{stats.textured ? "Texturé" : "Sans texture"}</span>
        </div>
      )}
      {overlay && <div className="viewer-overlay">{overlay}</div>}
    </div>
  );
});

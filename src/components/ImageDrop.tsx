import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

interface Props {
  file: File | null;
  onFile: (f: File | null) => void;
  accept?: string;
  label?: string;
  hint?: string;
  kind?: "image" | "mesh";
  /** Accept Ctrl+V pasted images while this component is mounted. */
  paste?: boolean;
}

export function ImageDrop({ file, onFile, accept = "image/*", label = "Dépose une image", hint, kind = "image", paste = false }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file || kind !== "image") return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, kind]);

  useEffect(() => {
    if (!paste) return;
    const handler = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const blob = item?.getAsFile();
      if (blob) onFile(new File([blob], `collage-${Date.now()}.png`, { type: blob.type }));
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [paste, onFile]);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      className={`drop ${over ? "over" : ""} ${file ? "filled" : ""}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
    >
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => pick(e.target.files)} />
      {preview ? (
        <img src={preview} alt="" className="drop-preview" />
      ) : file ? (
        <div className="drop-file">
          <Icon.cube size={28} />
          <strong>{file.name}</strong>
          <small>{(file.size / 1048576).toFixed(1)} Mo</small>
        </div>
      ) : (
        <div className="drop-hint">
          {kind === "image" ? <Icon.image size={30} /> : <Icon.cube size={30} />}
          <strong>{label}</strong>
          <small>{hint ?? "ou clique pour parcourir"}</small>
        </div>
      )}
      {file && (
        <button
          className="drop-clear"
          title="Retirer"
          onClick={(e) => {
            e.stopPropagation();
            onFile(null);
            if (input.current) input.current.value = "";
          }}
        >
          <Icon.x size={14} />
        </button>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";

export function Section({ title, right, children, collapsible = false, defaultOpen = true }: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? "" : "closed"}`}>
      <header className="section-head" onClick={() => collapsible && setOpen(!open)} data-collapsible={collapsible}>
        <h3>
          {collapsible && <span className="chev">{open ? "▾" : "▸"}</span>}
          {title}
        </h3>
        {right && <div onClick={(e) => e.stopPropagation()}>{right}</div>}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function Field({ label, hint, children, inline = false }: { label: ReactNode; hint?: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`field ${inline ? "inline" : ""}`}>
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Slider({ value, min, max, step = 1, onChange, format, disabled }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{format ? format(value) : value}</span>
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled, hint }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className={`toggle ${disabled ? "disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, size = "md" }: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={`segmented ${size}`}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          disabled={o.disabled}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select
      className="select"
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Progress({ value, indeterminate = false, tone = "accent" }: { value: number; indeterminate?: boolean; tone?: "accent" | "ok" | "error" }) {
  return (
    <div className={`progress ${indeterminate ? "indeterminate" : ""} ${tone}`}>
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "error" | "accent"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function LogConsole({ lines, height = 260 }: { lines: string[]; height?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);
  return (
    <pre
      ref={ref}
      className="console"
      style={{ height }}
      onScroll={(e) => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
      }}
    >
      {lines.length ? lines.slice(-1500).join("\n") : "—"}
    </pre>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h4>{title}</h4>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

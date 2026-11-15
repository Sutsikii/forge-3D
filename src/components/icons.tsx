// Small inline stroke icons (24px grid) so the app has no icon-font dependency.
const P = (d: string) => (props: { size?: number }) => (
  <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export const Icon = {
  cube: P("M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4L12 2.8Zm0 0v0M4 7.4l8 4.6 8-4.6M12 12v9.2"),
  brush: P("M14.5 4.5 19.5 9.5 10 19H5v-5l9.5-9.5ZM13 6l5 5"),
  queue: P("M4 6h16M4 12h16M4 18h10"),
  library: P("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"),
  chip: P("M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"),
  gear: P("M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13.5l1.6 1.2-2 3.5-1.9-.7a7.6 7.6 0 0 1-1.9 1.1L15 20.5h-4l-.3-1.9a7.6 7.6 0 0 1-1.9-1.1l-1.9.7-2-3.5 1.6-1.2a7.7 7.7 0 0 1 0-2.9L4.9 9.4l2-3.5 1.9.7a7.6 7.6 0 0 1 1.9-1.1L11 3.5h4l.3 1.9a7.6 7.6 0 0 1 1.9 1.1l1.9-.7 2 3.5-1.6 1.2a7.7 7.7 0 0 1 0 2.9Z"),
  image: P("M4 5h16v14H4zM4 15l4.5-4.5L13 15l2.5-2.5L20 17M15.5 9.5h.01"),
  text: P("M5 6h14M12 6v13M9 19h6"),
  upload: P("M12 16V4M7 9l5-5 5 5M4 20h16"),
  play: P("M7 4.5v15l12-7.5-12-7.5Z"),
  stop: P("M6 6h12v12H6z"),
  x: P("M6 6l12 12M18 6 6 18"),
  folder: P("M3.5 6.5h6l2 2h9v10h-17z"),
  download: P("M12 4v12M7 11l5 5 5-5M4 20h16"),
  trash: P("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"),
  dice: P("M5 5h14v14H5zM9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01"),
  refresh: P("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"),
  rotate: P("M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"),
  grid: P("M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"),
  camera: P("M4 7h3l2-2.5h6L17 7h3v12H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"),
  target: P("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12h.01"),
  check: P("M5 12.5 10 17.5 19 7"),
  alert: P("M12 3 2.5 20h19L12 3ZM12 10v4.5M12 17.5h.01"),
  spark: P("M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"),
  edit: P("M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"),
  external: P("M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"),
};

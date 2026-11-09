import type { ReactNode } from 'react'

// Drawn on a 16-unit grid as outlines in the text colour, so they take the
// colour of whatever they sit in.
const shapes = {
 download: <path d="M8 2v8M5 7l3 3 3-3M3 10.5V13h10v-2.5" />,
  link: <><rect x="1.5" y="2.5" width="4" height="4" rx="1" /><rect x="10.5" y="9.5" width="4" height="4" rx="1" /><path d="M5.5 4.5H8a1 1 0 0 1 1 1v5a1 1 0 0 0 1 1h.5M8.5 9.5l2 2-2 2" /></>,
  dashboard: <path d="M2.5 2.5H7v6H2.5zM9 2.5h4.5V6H9zM9 8h4.5v5.5H9zM2.5 10.5H7v3H2.5z" />,
  chart: <path d="M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V9" />,
  line: <path d="M2.5 13.5h11M3 10.5l3-4 3 2.5 4-5.5" />,
  area: <path d="M2.5 13.5h11M3 11l3-4 3 2.5 4-5.5v7.5H3z" />,
  pie: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5V8l4.5 3" />
    </>
  ),
  number: <path d="M6 3 4.5 13M11.5 3 10 13M3 6h10.5M2.5 10H13" />,
  hbar: <path d="M2.5 2.5v11M5 4.5h4M5 8h8M5 11.5h5.5" />,
  combo: <path d="M2.5 13.5h11M4.5 11V8.5M8 11V7M11.5 11V9M3 6l3.5-2.5 3 1.5 4-3" />,
  scatter: (
    <>
      <path d="M2.5 2.5v11h11" />
      <circle cx="5.75" cy="9.75" r="1.25" />
      <circle cx="8.5" cy="6" r="1.25" />
      <circle cx="11.5" cy="9" r="1.25" />
      <circle cx="11" cy="4.25" r="1.25" />
    </>
  ),
  funnel: <path d="M2.5 3.5h11M4 6.5h8M5.5 9.5h5M7 12.5h2" />,
  treemap: <path d="M2.5 2.5h11v11h-11zM8.5 2.5v11M8.5 8h5M2.5 9.5h6" />,
  heatmap: <path d="M2.5 2.5h11v11h-11zM6.17 2.5v11M9.83 2.5v11M2.5 6.17h11M2.5 9.83h11" />,
  gauge: <path d="M2.75 11.5a5.5 5.5 0 1 1 10.5 0M8 10.5l2.5-3.5" />,
  sankey: <path d="M2.5 3h2v4.5h-2zM2.5 9.5h2v3.5h-2zM11.5 3h2v3h-2zM11.5 8h2v5h-2zM4.5 5.25c3.5 0 3.5 5.25 7 5.25M4.5 11.25c3.5 0 3.5-6.75 7-6.75" />,
  pivot: <path d="M2.5 2.5h11v11h-11zM2.5 6h11M6 2.5v11M6 9.75h7.5M9.75 6v7.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  dataset: <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6" />,
  explore: (
    <>
      <ellipse cx="6" cy="3.5" rx="4" ry="1.5" />
      <path d="M2 3.5v7c0 .83 1.8 1.5 4 1.5M10 3.5v2M2 7c0 .83 1.8 1.5 4 1.5" />
      <circle cx="10.5" cy="10" r="2.75" />
      <path d="m12.5 12 2 2" />
    </>
  ),
  workbench: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M6 6v7.5" /></>,
  sql: <path d="m5 4.5-3.5 3.5L5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.5 2.5l-3 11" />,
  database: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="1.75" />
      <path d="M3 4v8c0 1 2.2 1.75 5 1.75s5-.75 5-1.75V4M3 8c0 1 2.2 1.75 5 1.75S13 9 13 8" />
    </>
  ),
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3L7.5 5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  folderPlus: <path d="M2 4.5a1 1 0 0 1 1-1h3L7.5 5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM8 7.5v3M6.5 9h3" />,
  chevronLeft: <path d="M10 3.5 5.5 8 10 12.5" />,
  chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  chevronDown: <path d="M3.5 6 8 10.5 12.5 6" />,
  sortAsc: <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />,
  sortDesc: <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 13.5 13.5" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.6" />
      <circle cx="8" cy="8" r="0.6" />
      <circle cx="12.5" cy="8" r="0.6" />
    </>
  ),
  play: <path d="M5 3.5v9l7-4.5z" />,
  stop: <path d="M4.5 4.5h7v7h-7z" />,
  save: <path d="M3 3h8l2 2v8H3zM5.5 3v3.5h4V3M5.5 13V9.5h5V13" />,
  plan: <path d="M8 2.5v3M8 5.5H4v3M8 5.5h4v3M2.5 8.5h3v3h-3zM10.5 8.5h3v3h-3zM6.5 2h3" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.65M13 2.5v3h-3" />,
  format: <path d="M2.5 4h11M5.5 8h8M5.5 12h5" />,
  table: <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11" />,
  rows: <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6 3.5v9M10 3.5v9" />,
  column: <path d="M5.5 2.5h5v11h-5z" />,
  schema: <path d="M2.5 3h4.5v3.5H2.5zM9 9.5h4.5V13H9zM4.75 6.5v4.75H9" />,
  lineage: <path d="M2 3h3.5v3H2zM2 10h3.5v3H2zM10.5 6.5H14v3h-3.5zM5.5 4.5H8v7H5.5M8 8h2.5" />,
  fit: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  expand: <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />,
  collapse: <path d="M13.5 2.5 9.5 6.5M9.5 3.5v3h3M2.5 13.5l4-4M6.5 12.5v-3h-3" />,
  warning: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.25v.25" />,
  share: <><circle cx="12" cy="3.5" r="1.75" /><circle cx="4" cy="8" r="1.75" /><circle cx="12" cy="12.5" r="1.75" /><path d="M5.55 7.15 10.45 4.35M5.55 8.85l4.9 2.8" /></>,
  lock: <path d="M3.5 7.5h9v6h-9zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />,
  unlock: <path d="M3.5 7.5h9v6h-9zM5.5 7.5V5a2.5 2.5 0 0 1 4.7-1.2" />,
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />,
  swap: <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />,
  copy: <path d="M5.5 5.5h7v8h-7zM3.5 10.5v-8h7" />,
  edit: <path d="M3 13l.6-2.9L10.8 2.9l2.3 2.3-7.2 7.2zM9.3 4.4l2.3 2.3" />,
  trash: <path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9M6.75 7v4M9.25 7v4" />,
  grip: (
    <>
      <circle cx="6" cy="4" r="0.6" />
      <circle cx="10" cy="4" r="0.6" />
      <circle cx="6" cy="8" r="0.6" />
      <circle cx="10" cy="8" r="0.6" />
      <circle cx="6" cy="12" r="0.6" />
      <circle cx="10" cy="12" r="0.6" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  user: <><circle cx="8" cy="5" r="2.5" /><path d="M3 13c0-3 1.5-4.5 5-4.5s5 1.5 5 4.5" /></>,
  users: <><circle cx="6" cy="5" r="2.25" /><path d="M1.5 13c0-3 1.5-4.5 4.5-4.5s4.5 1.5 4.5 4.5M10 2.75a2.25 2.25 0 0 1 0 4.5M11.5 8.75c2 .5 3 1.75 3 4.25" /></>,
  settings: <><path d="M3.5 2v12M8 2v12M12.5 2v12M1.75 5h3.5M6.25 10h3.5M10.75 6h3.5" /></>,
  filter: <path d="M2 3h12L9.5 8v4.5l-3 1V8z" />,
  layers: <path d="m8 2 6 3.5L8 9 2 5.5zM2 8.5 8 12l6-3.5M2 11 8 14.5l6-3.5" />,
  eye: <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></>,
  undo: <path d="m5.5 2.5-3 3 3 3M2.5 5.5H9a4 4 0 0 1 0 8H7" />,
  redo: <path d="m10.5 2.5 3 3-3 3M13.5 5.5H7a4 4 0 0 0 0 8h2" />,
  language: <path d="M2 4h7M5.5 2v2M7.5 4c-.5 3-2.5 5.5-5.5 7M3 6c1 2 2.5 3.5 5 4.5M8.5 14l3-8 3 8M9.5 11.5h4" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1v1M8 14v1M1 8h1M14 8h1M3 3l.75.75M12.25 12.25 13 13M3 13l.75-.75M12.25 3.75 13 3" /></>,
  moon: <path d="M13.5 9.25A5.75 5.75 0 0 1 6.75 2.5 5.75 5.75 0 1 0 13.5 9.25Z" />,
  signOut: <path d="M6 2.5H2.5v11H6M6 8h8M11 5l3 3-3 3" />,
  help: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.3 6.5a1.75 1.75 0 1 1 2.6 1.5c-.6.35-.9.75-.9 1.4M8 11.4v.05" />
    </>
  ),
  text: <path d="M3.5 5V3.5h9V5M8 3.5v9M6.5 12.5h3" />,
  heading: <path d="M4 3v10M12 3v10M4 8h8" />,
  paragraph: <path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7" />,
  frame: <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />,
  star: <path d="M8 2.2 9.53 6.3 13.9 6.48 10.47 9.2 11.64 13.42 8 11 4.36 13.42 5.53 9.2 2.1 6.48 6.47 6.3Z" />,
  tabs: <path d="M2.5 13.5v-11H7v3h6.5v8zM7 3.5h4v2" />,
  detach: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8h5" /></>,
  move: <path d="M2.5 8h8M8 5l3 3-3 3M13.5 3v10" />,
  pipette: <path d="M8 4.5l3.5 3.5M9.2 3.3l1-1a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4l-1 1M10.5 7 4.5 13H3v-1.5L9 5.5" />,
  toggle: (
    <>
      <rect x="1.75" y="4.5" width="12.5" height="7" rx="3.5" />
      <circle cx="10.75" cy="8" r="1.4" />
    </>
  ),
  calendar: <path d="M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3" />,
  assistant: <path d="M7 2.5c.45 2.75 1.75 4.05 4.5 4.5-2.75.45-4.05 1.75-4.5 4.5-.45-2.75-1.75-4.05-4.5-4.5C5.25 6.55 6.55 5.25 7 2.5ZM12.5 10v3.5M10.75 11.75h3.5" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  mail: <path d="M2.5 3.5h11v9h-11zM2.5 4l5.5 4.5L13.5 4" />,
  bell: <path d="M4 11V7.25a4 4 0 0 1 8 0V11l1.25 1.5H2.75L4 11ZM6.5 13.5a1.6 1.6 0 0 0 3 0" />,
  megaphone: <path d="M2.5 6.25v3.5h2.25l5.25 3V3.25l-5.25 3H2.5ZM12 6a2.4 2.4 0 0 1 0 4M4.75 9.75l.85 3.25" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof shapes

/** A small outline icon. It is decoration: whatever it sits in carries the name. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {shapes[name]}
    </svg>
  )
}

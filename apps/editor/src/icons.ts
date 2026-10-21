// Interface icons: MFP's own set of 24×24 outline SVGs (color is currentColor).

import type { NodeType } from '@mfp/core';

const svg = (body: string) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  logo: '<img class="ic brand-mark" src="/brand/mfp-mark.png" alt="" aria-hidden="true" />',
  move: svg('<path d="M6.5 3.5l11 8.6-4.9 1 2.8 5.6-2.3 1.1-2.8-5.6-3.8 3.4z"/>'),
  hand: svg(
    '<path d="M8 12.5V6.8a1.4 1.4 0 012.8 0V11"/><path d="M10.8 10.5V5.4a1.4 1.4 0 012.8 0v5.1"/><path d="M13.6 10.5V6.4a1.4 1.4 0 012.8 0v7.1a6.3 6.3 0 01-6.3 6.3h-.3a5.6 5.6 0 01-4.4-2.2l-2-2.6a1.4 1.4 0 012.1-1.8L8 14.4"/>',
  ),
  scale: svg('<rect x="4" y="10" width="10" height="10" rx="1"/><path d="M12.5 4.5h7v7M19.5 4.5l-7.5 7.5"/>'),
  frame: svg('<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
  rect: svg('<rect x="4.5" y="5.5" width="15" height="13" rx="1"/>'),
  line: svg('<path d="M5 19L19 5"/>'),
  ellipse: svg('<circle cx="12" cy="12" r="7.5"/>'),
  polygon: svg('<path d="M12 4.5l8 14.5H4z"/>'),
  star: svg('<path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3l-4.8 2.6 1-5.4-4-3.8 5.4-.7z"/>'),
  image: svg('<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M4 16l4.5-4.5 4 4 2-2L20 18"/><circle cx="15.5" cy="9.5" r="1.5"/>'),
  pen: svg('<path d="M12 3.5l5.5 8-2.3 8h-6.4l-2.3-8z"/><path d="M12 3.5V11"/><circle cx="12" cy="12.5" r="1.5"/>'),
  pencil: svg('<path d="M15.5 4.5l4 4L9 19l-5 1 1-5z"/><path d="M13.5 6.5l4 4"/>'),
  sparkle: svg('<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2-5.2-1.8 5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  mic: svg('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0012 0M12 17.5v3"/>'),
  micOff: svg('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0012 0M12 17.5v3M4.5 4.5l15 15"/>'),
  hangup: svg('<path d="M3.5 14.5c4.5-4 12.5-4 17 0l-2 2.5-3-1.5v-2.5c-2.2-.7-4.8-.7-7 0v2.5l-3 1.5z"/>'),
  brush: svg('<path d="M19.5 4.5c-2.5 1.5-6.5 5.5-8.5 8l1.5 1.5c2.5-2 6.5-6 8-8.5z"/><path d="M11 12.5c-2.5-.5-4.5 1-4.5 3.5 0 1.5-1 2.5-2.5 3 3.5 1 8 0 8.5-5z"/>'),
  width: svg('<path d="M4 17c3-1 4-6 8-6s5 5 8 6"/><path d="M4 17c3-3 4-9 8-9s5 6 8 9"/><circle cx="12" cy="9.5" r="1.2"/>'),
  text: svg('<path d="M5.5 7V5h13v2M12 5v14M9 19h6"/>'),
  plugins: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><path d="M16.5 13.5v6M13.5 16.5h6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  sidebar: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9.5 5v14"/>'),
  collapseAll: svg('<path d="M8 5l4 4 4-4M8 19l4-4 4 4"/>'),
  fitContent: svg('<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>'),
  paintSolid: svg('<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>'),
  paintGradient: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8 8h.01M11 8h.01M14 8h.01M9.5 11h.01M12.5 11h.01M8 14h.01M11 14h.01M14 14h.01M16 11h.01" stroke-width="2.2"/>'),
  paintPattern: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M5 12h14M12 5v14"/>'),
  paintVideo: svg('<rect x="4.5" y="5.5" width="15" height="13" rx="2"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/>'),
  designMode: svg('<rect x="4" y="4.5" width="9" height="15" rx="1.5"/><path d="M4 9h9"/><path d="M14.5 12l5.5 2-2.4 1 -1 2.4z" fill="currentColor"/>'),
  home: svg('<path d="M4 10.5L12 4l8 6.5"/><path d="M6 9v10.5h4.5V14h3v5.5H18V9"/>'),
  folder: svg('<path d="M3.5 7V18a1 1 0 001 1h15a1 1 0 001-1V9a1 1 0 00-1-1H12l-2-2.5H4.5a1 1 0 00-1 1z"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/><path d="M10.5 10.5v5M13.5 10.5v5"/>'),
  drive: svg('<rect x="3.5" y="13" width="17" height="6" rx="1"/><path d="M5.5 13l2.5-7.5h8L18.5 13"/><circle cx="16.5" cy="16" r="0.9" fill="currentColor"/>'),
  history: svg('<path d="M4.5 12a7.5 7.5 0 101.8-4.9"/><path d="M4 4.5v3.5h3.5"/><path d="M12 8v4.5l3 1.5"/>'),
  comment: svg('<path d="M5 5.5h14a1 1 0 011 1v9a1 1 0 01-1 1h-8l-4.5 3.5V16.5H5a1 1 0 01-1-1v-9a1 1 0 011-1z"/>'),
  bell: svg('<path d="M12 3.75c.55 0 1 .45 1 1v.55a5.6 5.6 0 0 1 4.6 5.5v3.1l1.55 2.45c.3.47-.04 1.1-.6 1.1H5.45c-.56 0-.9-.63-.6-1.1L6.4 13.9v-3.1A5.6 5.6 0 0 1 11 5.3v-.55c0-.55.45-1 1-1z"/><path d="M9.75 19.4a2.35 2.35 0 0 0 4.5 0"/>'),
  attach: svg('<path d="M15.5 7.5l-6.4 6.4a1.8 1.8 0 002.5 2.5l6.7-6.7a3.5 3.5 0 00-5-5L6.6 11.4a5.2 5.2 0 007.4 7.4l5-5"/>'),
  smile: svg('<circle cx="12" cy="12" r="8"/><path d="M8.8 14a4 4 0 006.4 0"/><circle cx="9.5" cy="10" r="0.6" fill="currentColor"/><circle cx="14.5" cy="10" r="0.6" fill="currentColor"/>'),
  slice: svg('<path d="M5 19L19 5"/><path d="M4.5 9.5V4.5h5M14.5 19.5h5v-5" stroke-dasharray="2 2"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  play: svg('<path d="M8 5.5v13l10-6.5z"/>'),
  chevronDown: svg('<path d="M8 10l4 4 4-4"/>'),
  chevronRight: svg('<path d="M10 8l4 4-4 4"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  eye: svg('<path d="M3 12s3.3-5.5 9-5.5S21 12 21 12s-3.3 5.5-9 5.5S3 12 3 12z"/><circle cx="12" cy="12" r="2.5"/>'),
  eyeOff: svg('<path d="M3 12s3.3-5.5 9-5.5S21 12 21 12s-3.3 5.5-9 5.5S3 12 3 12z"/><path d="M5 19L19 5"/>'),
  lock: svg('<rect x="6.5" y="11" width="11" height="8.5" rx="1.5"/><path d="M8.8 11V8.2a3.2 3.2 0 016.4 0V11"/>'),
  unlock: svg('<rect x="6.5" y="11" width="11" height="8.5" rx="1.5"/><path d="M8.8 11V8.2a3.2 3.2 0 016.2-1.1"/>'),
  component: svg('<path d="M12 4l6.93 4v8L12 20l-6.93-4V8z"/><path d="M12 9l2.6 1.5v3L12 15l-2.6-1.5v-3z" fill="currentColor"/>'),
  instance: svg('<path d="M12 4.5l6.5 3.75v7.5L12 19.5l-6.5-3.75v-7.5z"/>'),
  group: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1" stroke-dasharray="3 2.4"/>'),
  vector: svg('<path d="M5.5 17.5C8.5 6.5 15.5 17.5 18.5 6.5"/><rect x="3.5" y="15.5" width="4" height="4" rx=".6"/><rect x="16.5" y="4.5" width="4" height="4" rx=".6"/>'),
  boolean: svg('<rect x="4" y="4" width="10" height="10" rx="1"/><rect x="10" y="10" width="10" height="10" rx="1"/>'),
  section: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M6.5 6.75h5"/>'),
  page: svg('<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4"/>'),
  alignLeft: svg('<path d="M4.5 4v16"/><rect x="7.5" y="6.5" width="11" height="4" rx=".8"/><rect x="7.5" y="13.5" width="7" height="4" rx=".8"/>'),
  alignHCenter: svg('<path d="M12 4v16"/><rect x="6" y="6.5" width="12" height="4" rx=".8"/><rect x="8" y="13.5" width="8" height="4" rx=".8"/>'),
  alignRight: svg('<path d="M19.5 4v16"/><rect x="5.5" y="6.5" width="11" height="4" rx=".8"/><rect x="9.5" y="13.5" width="7" height="4" rx=".8"/>'),
  alignTop: svg('<path d="M4 4.5h16"/><rect x="6.5" y="7.5" width="4" height="11" rx=".8"/><rect x="13.5" y="7.5" width="4" height="7" rx=".8"/>'),
  alignVCenter: svg('<path d="M4 12h16"/><rect x="6.5" y="6" width="4" height="12" rx=".8"/><rect x="13.5" y="8" width="4" height="8" rx=".8"/>'),
  alignBottom: svg('<path d="M4 19.5h16"/><rect x="6.5" y="5.5" width="4" height="11" rx=".8"/><rect x="13.5" y="9.5" width="4" height="7" rx=".8"/>'),
  skew: svg('<path d="M9 6h10l-4 12H5z"/>'),
  rotate: svg('<path d="M18.5 12a6.5 6.5 0 11-1.9-4.6"/><path d="M18.5 4.5v3.5H15"/>'),
  flipH: svg('<path d="M12 4v16"/><path d="M9 7.5L4.5 12 9 16.5zM15 7.5l4.5 4.5-4.5 4.5z"/>'),
  flipV: svg('<path d="M4 12h16"/><path d="M7.5 9L12 4.5 16.5 9zM7.5 15l4.5 4.5 4.5-4.5z"/>'),
  corner: svg('<path d="M5.5 18.5v-7a6 6 0 016-6h7"/>'),
  opacity: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 010 15z" fill="currentColor"/>'),
  link: svg('<path d="M10 14.5a3.5 3.5 0 005 0l3-3a3.5 3.5 0 00-5-5l-1 1"/><path d="M14 9.5a3.5 3.5 0 00-5 0l-3 3a3.5 3.5 0 005 5l1-1"/>'),
  textAutoWidth: svg('<path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/>'),
  textAutoHeight: svg('<path d="M12 4v16M9 7l3-3 3 3M9 17l3 3 3-3"/>'),
  textFixed: svg('<rect x="5" y="5" width="14" height="14" rx="1.5"/>'),
  textFit: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/><path d="M8 8l3 3M16 16l-3-3M16 8l-3 3M8 16l3-3"/>'),
  bucket: svg('<path d="M5 11.5l6.5-6.5 7 7-6.5 6.5z"/><path d="M5 11.5h13.5M19.5 15.5s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z"/>'),
  lasso: svg('<ellipse cx="12" cy="9.5" rx="7.5" ry="5"/><path d="M8 13.8c-.8 1.2-.6 2.7.6 3.4 1 .6 2.4.3 2.9-.8"/><path d="M11.5 16.4l-1.5 4"/>'),
  knife: svg('<circle cx="7" cy="17" r="2.5"/><circle cx="17" cy="17" r="2.5"/><path d="M8.8 15.2L18 4.5M15.2 15.2L6 4.5"/>'),
  eraser: svg('<path d="M8.5 19.5l-4-4 9.5-9.5 6 6-7.5 7.5z"/><path d="M10.5 9.5l6 6M8.5 19.5h11"/>'),
  layoutRow: svg('<rect x="4.5" y="5.5" width="4" height="13" rx="1"/><rect x="10" y="5.5" width="4" height="13" rx="1"/><rect x="15.5" y="5.5" width="4" height="9" rx="1"/>'),
  layoutCol: svg('<rect x="5.5" y="4.5" width="13" height="4" rx="1"/><rect x="5.5" y="10" width="13" height="4" rx="1"/><rect x="5.5" y="15.5" width="9" height="4" rx="1"/>'),
  layoutGrid: svg('<rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1"/><rect x="13" y="4.5" width="6.5" height="6.5" rx="1"/><rect x="4.5" y="13" width="6.5" height="6.5" rx="1"/><rect x="13" y="13" width="6.5" height="6.5" rx="1"/>'),
  autoLayout: svg('<rect x="4.5" y="4.5" width="15" height="4" rx="1"/><rect x="4.5" y="10" width="15" height="4" rx="1"/><rect x="4.5" y="15.5" width="9" height="4" rx="1"/>'),
  arrowDown: svg('<path d="M12 5v14M7 14l5 5 5-5"/>'),
  arrowRight: svg('<path d="M5 12h14M14 7l5 5-5 5"/>'),
  wrap: svg('<path d="M4.5 7.5h11a3.5 3.5 0 010 7H9"/><path d="M11.5 11.5l-3 3 3 3"/>'),
  gap: svg('<path d="M5 4.5v15M19 4.5v15"/><path d="M9 12h6M9 12l2-2M9 12l2 2M15 12l-2-2M15 12l-2 2"/>'),
  paddingH: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1"/><path d="M8 9v6M16 9v6"/>'),
  paddingV: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1"/><path d="M9 8h6M9 16h6"/>'),
  absolute: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1" stroke-dasharray="2.4 2.6"/><rect x="9" y="9" width="6" height="6" rx=".8" fill="currentColor" stroke="none"/>'),
  distributeH: svg('<path d="M4.5 4v16M19.5 4v16"/><rect x="8" y="7.5" width="3" height="9" rx=".6"/><rect x="13" y="7.5" width="3" height="9" rx=".6"/>'),
  distributeV: svg('<path d="M4 4.5h16M4 19.5h16"/><rect x="7.5" y="8" width="9" height="3" rx=".6"/><rect x="7.5" y="13" width="9" height="3" rx=".6"/>'),
  tidy: svg('<rect x="5" y="5" width="5.5" height="5.5" rx="1"/><rect x="13.5" y="5" width="5.5" height="5.5" rx="1"/><rect x="5" y="13.5" width="5.5" height="5.5" rx="1"/><rect x="13.5" y="13.5" width="5.5" height="5.5" rx="1"/>'),
  corners: svg('<path d="M4.5 9.5v-2a3 3 0 013-3h2M14.5 4.5h2a3 3 0 013 3v2M19.5 14.5v2a3 3 0 01-3 3h-2M9.5 19.5h-2a3 3 0 01-3-3v-2"/>'),
  paddingSides: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="1"/><path d="M8 9.5v5M16 9.5v5M9.5 8h5M9.5 16h5"/>'),
  constraintH: svg('<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M3.5 12h3.5M17 12h3.5"/>'),
  constraintV: svg('<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M12 3.5V7M12 17v3.5"/>'),
  wrapV: svg('<path d="M7.5 4.5v11a3.5 3.5 0 007 0V9"/><path d="M11.5 11.5l3-3 3 3"/>'),
  gapRows: svg('<path d="M4.5 5h15M4.5 19h15"/><path d="M12 9v6M12 9l-2 2M12 9l2 2M12 15l-2-2M12 15l2-2"/>'),
  clip: svg('<path d="M7 3.5v13.5h13.5"/><path d="M3.5 7h13.5v13.5"/>'),
  help: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 114.6 1.3c-.7 1-2.2 1.4-2.2 3"/><circle cx="12" cy="16.8" r=".4" fill="currentColor"/>'),
  users: svg('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.5 14.4A4.5 4.5 0 0121 19"/>'),
  check: svg('<path d="M5.5 12.5l4 4 9-9"/>'),
  blend: svg('<circle cx="9.5" cy="12" r="5.5"/><circle cx="14.5" cy="12" r="5.5"/>'),
  stroke: svg('<rect x="5" y="5" width="14" height="14" rx="1" stroke-width="2.6"/>'),
  strokeSides: svg('<path d="M5 8.5V19h14V8.5" stroke-dasharray="2 2"/><path d="M4.5 5h15" stroke-width="2.6"/>'),
  settings: svg('<path d="M4.5 7.5h9M17.5 7.5h2M4.5 16.5h2M10.5 16.5h9"/><circle cx="15.5" cy="7.5" r="2"/><circle cx="8.5" cy="16.5" r="2"/>'),
  swap: svg('<path d="M5 9h13l-3.5-3.5M19 15H6l3.5 3.5"/>'),
  arrow: svg('<path d="M5 19L19 5M11 5h8v8"/>'),
  effects: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>'),
  export: svg('<path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"/><path d="M5 14v5.5h14V14"/>'),
  // Design system.
  styles: svg('<circle cx="8" cy="8" r="2.4"/><circle cx="16" cy="8" r="2.4"/><circle cx="8" cy="16" r="2.4"/><circle cx="16" cy="16" r="2.4"/>'),
  variable: svg('<path d="M8.5 4.5c-2 0-2.5 1-2.5 2.5v2.5c0 1.2-.8 2-2 2.5 1.2.5 2 1.3 2 2.5V17c0 1.5.5 2.5 2.5 2.5M15.5 4.5c2 0 2.5 1 2.5 2.5v2.5c0 1.2.8 2 2 2.5-1.2.5-2 1.3-2 2.5V17c0 1.5-.5 2.5-2.5 2.5"/>'),
  unlink: svg('<path d="M10 14.5a3.5 3.5 0 005 0l3-3a3.5 3.5 0 00-5-5"/><path d="M14 9.5a3.5 3.5 0 00-5 0l-3 3a3.5 3.5 0 005 5"/><path d="M4.5 4.5l15 15"/>'),
  reset: svg('<path d="M5.5 12a6.5 6.5 0 106.5-6.5H8.5"/><path d="M10.5 3l-2.5 2.5L10.5 8"/>'),
  target: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>'),
  slot: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="2" stroke-dasharray="3 2.4"/><path d="M12 9v6M9 12h6"/>'),
  assets: svg('<path d="M5.5 4.5h10a3 3 0 013 3v12h-10a3 3 0 01-3-3z"/><path d="M5.5 16.5a3 3 0 013-3h10"/>'),
  mode: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 000 15z" fill="currentColor"/>'),
  more: svg('<circle cx="6.5" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="17.5" cy="12" r="1.1" fill="currentColor"/>'),
  toggleProp: svg('<rect x="3.5" y="7.5" width="17" height="9" rx="4.5"/><circle cx="15.5" cy="12" r="2.5" fill="currentColor"/>'),
  textProp: svg('<path d="M6.5 8V6h11v2M12 6v12M9.5 18h5"/>'),
  componentSet: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.4"/><path d="M8.5 9l2.6 1.5v3L8.5 15l-2.6-1.5v-3zM15.5 9l2.6 1.5v3L15.5 15l-2.6-1.5v-3z"/>'),
  code: svg('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0014 4.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5"/>'),
  library: svg('<path d="M5.5 5v14M9 5v14"/><path d="M12.5 5.8l3.4-.9 3.6 13.6-3.4.9z"/>'),
  layers: svg('<path d="M12 4.5l8 4-8 4-8-4z"/><path d="M4 12.5l8 4 8-4M4 16.5l8 4 8-4"/>'),
  annotate: svg('<path d="M5.5 4.5h13v10l-4 4h-9z"/><path d="M14.5 18.5v-4h4M8.5 8.5h7M8.5 11.5h4.5"/>'),
  ruler: svg('<path d="M3.5 15.5l12-12 5 5-12 12z"/><path d="M7.5 11.5l2 2M10.5 8.5l1.5 1.5M13.5 5.5l2 2"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l4.5 4.5"/>'),
  warning: svg('<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".4" fill="currentColor"/>'),
} as const;

export type IconName = keyof typeof ICON;

/** Layer icon in the layers panel. */
export const NODE_ICON: Partial<Record<NodeType, string>> = {
  FRAME: ICON.frame,
  GROUP: ICON.group,
  SECTION: ICON.section,
  RECTANGLE: ICON.rect,
  ELLIPSE: ICON.ellipse,
  TEXT: ICON.text,
  VECTOR: ICON.vector,
  LINE: ICON.line,
  POLYGON: ICON.polygon,
  STAR: ICON.star,
  COMPONENT: ICON.component,
  COMPONENT_SET: ICON.componentSet,
  INSTANCE: ICON.instance,
  BOOLEAN_OPERATION: ICON.boolean,
  PAGE: ICON.page,
  SLICE: ICON.slice,
};

/**
 * Layer row icon: by type; for a frame with auto layout, by flow direction; for a shape with
 * a single image or video fill, an image or video.
 */
export function layerIcon(type: NodeType, props: { layoutMode?: string; fills?: readonly { type: string; visible?: boolean }[] | null }): string {
  if (type === 'FRAME') {
    if (props.layoutMode === 'HORIZONTAL') return ICON.layoutRow;
    if (props.layoutMode === 'VERTICAL') return ICON.layoutCol;
    if (props.layoutMode === 'GRID') return ICON.layoutGrid;
  }
  if (type === 'RECTANGLE') {
    const shown = (props.fills ?? []).filter((p) => p.visible !== false);
    if (shown.length === 1 && shown[0]!.type === 'IMAGE') return ICON.image;
    if (shown.length === 1 && shown[0]!.type === 'VIDEO') return ICON.paintVideo;
  }
  return NODE_ICON[type] ?? ICON.rect;
}

/** Layer type name (properties panel heading). */
export const NODE_LABEL: Partial<Record<NodeType, string>> = {
  FRAME: 'Фрейм',
  GROUP: 'Группа',
  SECTION: 'Секция',
  RECTANGLE: 'Прямоугольник',
  ELLIPSE: 'Эллипс',
  TEXT: 'Текст',
  VECTOR: 'Вектор',
  LINE: 'Линия',
  POLYGON: 'Многоугольник',
  STAR: 'Звезда',
  COMPONENT: 'Компонент',
  COMPONENT_SET: 'Набор вариантов',
  INSTANCE: 'Инстанс',
  BOOLEAN_OPERATION: 'Булева операция',
  SLICE: 'Срез',
};

/** Element with an icon (innerHTML from our own strings, no external content). */
export function iconEl(name: IconName | string, cls = 'icon'): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.innerHTML = name in ICON ? ICON[name as IconName] : name;
  return el;
}

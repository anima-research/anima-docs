// Stroke icons (24×24, currentColor), Lucide-style.

const P: Record<string, string> = {
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  list: '<line x1="9" x2="21" y1="6" y2="6"/><line x1="9" x2="21" y1="12" y2="12"/><line x1="9" x2="21" y1="18" y2="18"/><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  listOrdered: '<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  listChecks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  codeBlock: '<path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  table: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>',
  hr: '<path d="M4 12h16"/><path d="M8 7h8" opacity=".45"/><path d="M8 17h8" opacity=".45"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  commentAdd: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  suggest: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/><path d="m15 5 3 3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  sparkle: '<path d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1z" fill="currentColor" stroke="none"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  offline: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  cloudCheck: '<path d="m17 15-5.5 5.5L9 18"/><path d="M5 17.743A7 7 0 1 1 15.71 10h1.79a4.5 4.5 0 0 1 1.5 8.742"/>',
  heading: '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  reopen: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  unlink: '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
};

export type IconName = keyof typeof P;

export function icon(name: IconName | string, size = 18, cls = ''): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="icon${cls ? ` ${cls}` : ''}">${P[name] ?? ''}</svg>`;
  return tpl.content.firstChild as SVGSVGElement;
}

/** The product mark (same art as /favicon.svg). */
export function logo(size = 28): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" class="logo-mark">
  <defs><linearGradient id="lg-${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22b8a6"/><stop offset="1" stop-color="#2459e0"/></linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="url(#lg-${size})"/>
  <path d="M21 12h16.5L47 21.5V49a3 3 0 0 1-3 3H21a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z" fill="#fff"/>
  <path d="M37.5 12v7.5a2 2 0 0 0 2 2H47z" fill="#cfe0ff"/>
  <path d="M24 24h9M24 30h17" stroke="#9db4dc" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M26.5 42.5c1.2-4.6 4.2-7 7-7s5.8 2.4 7 7z" fill="#22b8a6"/>
  <path d="M23 45.2c2.2-1.6 4.4-1.6 6.6 0s4.4 1.6 6.6 0 4.4-1.6 6.6 0" stroke="#2459e0" stroke-width="2.4" fill="none" stroke-linecap="round"/>
</svg>`;
  return tpl.content.firstChild as SVGSVGElement;
}

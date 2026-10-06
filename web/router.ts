// Client-side routing on the history API.

type Renderer = (path: string) => void;
let render: Renderer = () => {};

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (path === location.pathname + location.search && !opts.replace) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  render(location.pathname);
}

export function startRouter(fn: Renderer) {
  render = fn;
  window.addEventListener('popstate', () => render(location.pathname));
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest?.('a[data-link]') as HTMLAnchorElement | null;
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
  render(location.pathname);
}

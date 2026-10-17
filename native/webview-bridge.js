/* Only the native host may answer commands. No network or Node access. */
(() => {
  const pending = new Map(),
    snapshots = new Set(),
    navigation = new Set();
  let id = 0;
  window.chrome.webview.addEventListener('message', (event) => {
    const m = event.data;
    if (m.kind === 'response') {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        p.resolve({ ok: m.ok, data: m.data, error: m.error });
      }
    }
    if (m.kind === 'snapshot') snapshots.forEach((fn) => fn(m.data));
    if (m.kind === 'navigate') navigation.forEach((fn) => fn(m.data));
  });
  window.pawshift = Object.freeze({
    command: (message) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        pending.set(key, { resolve, reject });
        window.chrome.webview.postMessage({ kind: 'command', id: key, message });
      }),
    onSnapshot: (fn) => {
      snapshots.add(fn);
      return () => snapshots.delete(fn);
    },
    onNavigate: (fn) => {
      navigation.add(fn);
      return () => navigation.delete(fn);
    },
  });
})();

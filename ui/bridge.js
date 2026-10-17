/* Adapter between the shared UI contract and the isolated desktop API. */
window.acquirePawShiftApi = () => ({
  getState: () => {
    try {
      return JSON.parse(localStorage.getItem('pawshift.view') || 'null');
    } catch {
      return null;
    }
  },
  setState: (value) => localStorage.setItem('pawshift.view', JSON.stringify(value)),
  postMessage: (message) => {
    window.pawshift
      .command(message)
      .then((result) => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'response', commandId: message.commandId, ...result },
          }),
        );
      })
      .catch((error) => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'response',
              commandId: message.commandId,
              ok: false,
              error: String(error),
            },
          }),
        );
      });
  },
});
window.pawshift.onSnapshot((data) =>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', data } })),
);
window.pawshift.onNavigate((data) =>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', ...data } })),
);

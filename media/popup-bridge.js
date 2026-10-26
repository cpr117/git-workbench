'use strict';
(() => {
  let saved;
  window.acquireVsCodeApi = () => ({
    getState: () => saved,
    setState: value => { saved = value; },
    postMessage: value => window.webkit.messageHandlers.gitWorkbench.postMessage(value),
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); window.webkit.messageHandlers.gitWorkbench.postMessage({ type: 'close' }); }
  });
})();

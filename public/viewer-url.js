// The browser uses the published Viewer port, not Docker-internal DNS or a tunnel.
(() => {
  const viewerUrl = new URL(window.location.href);
  viewerUrl.port = '3011';
  viewerUrl.pathname = '/';
  viewerUrl.search = '';
  viewerUrl.hash = '';
  document.getElementById('viewer').src = viewerUrl.href;
  document.getElementById('viewerAddress').textContent =
    `🎮 Bot 第一人称视角 · ${viewerUrl.host}`;
})();

(function (root) {
  function create(document, name) {
    if (typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name) || name === 'air') return null;
    const image = document.createElement('img');
    image.className = 'item-icon';
    image.src = `/assets/items/${name}.svg`;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.width = 32;
    image.height = 32;
    image.addEventListener('load', () => image.parentNode?.classList.add('has-item-icon'));
    image.addEventListener('error', () => {
      image.hidden = true;
      image.parentNode?.classList.remove('has-item-icon');
    });
    return image;
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ItemIcons = api;
})(typeof window === 'undefined' ? globalThis : window);

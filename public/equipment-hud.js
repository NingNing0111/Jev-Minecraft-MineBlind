(function (root) {
  const icons = typeof module !== 'undefined' && module.exports ? require('./item-icons') : root.ItemIcons;
  const rendered = new WeakMap();
  const labels = { head: '头盔', chest: '胸甲', legs: '护腿', feet: '靴子', offhand: '副手' };
  function render(document, state) {
    const data = state?.equipment_slots;
    const hotbar = document.getElementById('hotbar');
    const armor = document.getElementById('armorSlots');
    if (!hotbar || !armor) return;
    const signature = JSON.stringify(data ?? null);
    const previous = rendered.get(document);
    if (previous?.hotbar === hotbar && previous?.armor === armor && previous.signature === signature) return;
    function slot(item, label, selected, known) {
      const el = document.createElement('div');
      el.className = 'equipment-slot' + (selected ? ' selected' : '');
      el.setAttribute('role', 'listitem');
      const name = known ? (item?.name || '空') : '未知';
      el.title = `${label}: ${name}${item ? ' ×' + item.count : ''}`;
      el.setAttribute('aria-label', el.title + (selected ? ' · 当前主手' : ''));
      const key = document.createElement('span'); key.className = 'slot-key'; key.textContent = label;
      const text = document.createElement('span'); text.className = 'slot-name';
      text.textContent = name.replaceAll('_', ' ');
      el.append(key, text);
      if (item) {
        const icon = icons.create(document, item.name);
        if (icon) el.append(icon);
        const count = document.createElement('span'); count.className = 'slot-count'; count.textContent = String(item.count);
        el.append(count);
      }
      return el;
    }
    hotbar.replaceChildren(...Array.from({ length: 9 }, (_, i) =>
      slot(data?.hotbar?.[i], String(i + 1), data?.selected === i, Array.isArray(data?.hotbar))));
    armor.replaceChildren(...Object.entries(labels).map(([key, label]) =>
      slot(key === 'offhand' ? data?.offhand : data?.armor?.[key], label, false, Boolean(data))));
    document.getElementById('equipmentStatus').textContent = data
      ? '装备 / 快捷栏 · 只读' : '等待槽位数据 · 不从背包推测';
    rendered.set(document, { hotbar, armor, signature });
  }
  const api = { render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EquipmentHud = api;
})(typeof window === 'undefined' ? globalThis : window);

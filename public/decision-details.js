/* Details are loaded on demand; live updates never replace the open dialog. */
(function (root) {
  function attach(doc, fetcher = fetch) {
    const dialog = doc.getElementById('decisionDialog');
    const content = doc.getElementById('decisionDetail');
    let sequence = 0;
    doc.getElementById('closeDecision').onclick = () => { sequence++; dialog.close(); };
    dialog.addEventListener('cancel', () => { sequence++; });
    return async function open(entry) {
      const current = ++sequence;
      doc.getElementById('decisionTitle').textContent = '决策详情 · ' + new Date(entry.timestamp).toLocaleString();
      content.textContent = '加载中…'; dialog.showModal();
      try {
        if (!entry.id) throw new Error('旧记录未保存输入输出；请查看更新后的新决策。');
        const res = await fetcher('/api/decisions/' + encodeURIComponent(entry.id));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '无法加载详情');
        if (current !== sequence || !dialog.open) return;
        content.textContent = '';
        const note = doc.createElement('p'); note.className = 'muted'; note.textContent = data.note || ''; content.appendChild(note);
        for (const [label, value] of [['输入 · 决策上下文', data.input], ['输出 · 技能选择结果', data.output],
          ['Jev 请求正文（不含鉴权信息）', data.request], ['Jev 原始响应', data.response], ['调用错误 / 降级原因', data.error]]) {
          const section = doc.createElement('details'); section.open = label.startsWith('输入') || label.startsWith('输出');
          const title = doc.createElement('summary'); title.textContent = label;
          const pre = doc.createElement('pre'); pre.textContent = value == null ? '无（未调用 / 未返回）' : JSON.stringify(value, null, 2);
          section.appendChild(title); section.appendChild(pre); content.appendChild(section);
        }
      } catch (error) {
        if (current === sequence && dialog.open) content.textContent = error.message;
      }
    };
  }
  if (typeof module !== 'undefined') module.exports = { attach };
  else root.DecisionDetails = { attach };
})(typeof window === 'undefined' ? globalThis : window);

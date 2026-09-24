(function () {
  const open = document.getElementById('bestRunsOpen');
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('bestRunsDialog'));
  const status = document.getElementById('bestRunsStatus');
  const results = document.getElementById('bestRunsResults');
  const normal = document.getElementById('bestRunsNormal');
  const test = document.getElementById('bestRunsTest');
  let mode = 'normal';
  let data = null;
  let request = 0;
  const date = value => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(parsed) : '时间未记录';
  };
  function render() {
    normal.setAttribute('aria-selected', String(mode === 'normal'));
    test.setAttribute('aria-selected', String(mode === 'test'));
    normal.tabIndex = mode === 'normal' ? 0 : -1;
    test.tabIndex = mode === 'test' ? 0 : -1;
    results.setAttribute('aria-labelledby', mode === 'normal' ? normal.id : test.id);
    results.replaceChildren();
    if (!data) return;
    status.textContent = `实时记录 · ${date(data.recordedAt)}（北京时间）`;
    const rows = Array.isArray(data[mode]) ? data[mode].slice(0, 5) : [];
    if (!rows.length) {
      results.textContent = '暂无符合条件的记录';
      return;
    }
    const list = document.createElement('ol');
    for (const row of rows) {
      const item = document.createElement('li');
      const stage = document.createElement('strong');
      stage.textContent = `通关 ${Math.max(0, Number(row.highestClearedStage) || 0)} 关`;
      const endedStage = Number(row.lastStage) || 0;
      const stoppedAt = row.finished && endedStage > Number(row.highestClearedStage)
        ? ` · 第 ${endedStage} 关止步` : '';
      const time = document.createElement('span');
      time.textContent = date(row.achievedAt);
      const details = document.createElement('small');
      details.textContent = `击毁 ${Number(row.kills) || 0} · 阵亡 ${Number(row.deaths) || 0}${stoppedAt}${row.finished ? ' · 已结束' : ' · 仍在进行或结束情况未确认'}`;
      const versions = document.createElement('small');
      versions.textContent = `版本：${(Array.isArray(row.buildVersions) ? row.buildVersions : [])
        .map(v => v === 'UNVERSIONED' || v === 'LEGACY' ? '未记录' : String(v)).join('、') || '未记录'}`;
      item.append(stage, time, details, versions);
      list.append(item);
    }
    results.append(list);
  }
  function select(next) { mode = next; render(); }
  normal.addEventListener('click', () => select('normal'));
  test.addEventListener('click', () => select('test'));
  for (const tab of [normal, test]) tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    select(event.key === 'Home' ? 'normal' : event.key === 'End' ? 'test' : mode === 'normal' ? 'test' : 'normal');
    (mode === 'normal' ? normal : test).focus();
  });
  open.addEventListener('click', async () => {
    const id = ++request;
    data = null;
    render();
    status.textContent = '正在读取记录…';
    if (!dialog.open) dialog.showModal();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('records/best-five-runs.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Unavailable');
      const value = await response.json();
      if (!value || !Array.isArray(value.normal) || !Array.isArray(value.test)) throw new Error('Invalid records');
      if (id !== request) return;
      data = value;
      render();
    } catch {
      if (id === request) status.textContent = '记录读取失败，请关闭后重试。';
    } finally { clearTimeout(timeout); }
  });
  document.getElementById('bestRunsClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { request++; open.focus(); });
  // Keep modal keyboard navigation from controlling the game underneath it.
  window.addEventListener('keydown', event => {
    if (dialog.open) event.stopImmediatePropagation();
  });
})();

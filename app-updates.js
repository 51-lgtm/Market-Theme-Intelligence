/* Display-only release notice. Never clears storage or reloads without a click. */
(function(root) {
  'use strict';
  const validRelease = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
  function releaseState(current, latest) {
    if (!validRelease(current) || !validRelease(latest)) return 'unknown';
    return current === latest ? 'current' : 'available';
  }
  async function readRelease(fetchImpl, signal) {
    const response = await fetchImpl('/app-release.json', { cache: 'no-store', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('release_unavailable');
    const payload = await response.json();
    if (!validRelease(payload.release)) throw new Error('release_invalid');
    return payload.release;
  }
  async function activateAndReload(registration, navigator, reload, timers = { setTimeout, clearTimeout }) {
    if (!registration?.waiting) { reload(); return; }
    // Only called after the user explicitly accepts the unsaved-input warning.
    return new Promise((resolve, reject) => {
      let completed = false;
      let timeout;
      const finish = () => {
        if (completed) return;
        completed = true;
        timers.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', finish);
        reload();
        resolve();
      };
      timeout = timers.setTimeout(() => {
        if (completed) return;
        completed = true;
        navigator.serviceWorker.removeEventListener('controllerchange', finish);
        reject(new Error('activation_timeout'));
      }, 15000);
      navigator.serviceWorker.addEventListener('controllerchange', finish);
      try { registration.waiting.postMessage('SKIP_WAITING'); }
      catch (error) {
        completed = true;
        timers.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', finish);
        reject(error);
      }
    });
  }
  function mount(win) {
    const doc = win.document;
    const current = doc.querySelector('meta[name="app-release"]')?.content;
    const main = doc.querySelector('main');
    if (!main || !validRelease(current) || doc.getElementById('app-release-status')) return;
    const box = doc.createElement('aside');
    box.id = 'app-release-status';
    box.setAttribute('aria-label', '画面の更新状況');
    box.style.cssText = 'grid-column:1/-1;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;line-height:1.5;color:#aebed1;margin:0 0 10px;overflow-wrap:anywhere';
    const label = doc.createElement('span');
    label.textContent = '画面版 11/12・好悪材料の綱引き';
    label.title = current;
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    status.textContent = '更新確認中';
    const check = doc.createElement('button');
    check.type = 'button';
    check.textContent = '版を確認';
    check.style.cssText = 'font:inherit;color:#bceeff;background:#111a2e;border:1px solid #315264;border-radius:6px;padding:8px;min-height:36px;cursor:pointer';
    const refresh = check.cloneNode(true);
    refresh.textContent = '新版を表示';
    refresh.hidden = true;
    box.append(label, status, check, refresh);
    main.prepend(box);
    let registration = null;
    let busy = false;
    let lastCheck = 0;
    let latestState = 'unknown';
    const showWaiting = () => {
      if (registration?.waiting) {
        status.textContent = '更新ファイルあり。保存後に新版を表示できます';
        refresh.hidden = false;
      }
    };
    const run = async () => {
      if (busy) return;
      busy = true;
      lastCheck = Date.now();
      check.disabled = true;
      const controller = new AbortController();
      const timeout = win.setTimeout(() => controller.abort(), 12000);
      try {
        const latest = await readRelease(win.fetch.bind(win), controller.signal);
        latestState = releaseState(current, latest);
        status.textContent = latestState === 'current' ? '公開版と一致' : '新版あり。保存後に再読み込みしてください';
        refresh.hidden = latestState !== 'available';
        if (registration) registration.update().then(showWaiting).catch(() => {});
        showWaiting();
      } catch (_) {
        status.textContent = '公開版を確認できません。表示中の画面版は左記です';
      } finally {
        win.clearTimeout(timeout);
        busy = false;
        check.disabled = false;
      }
    };
    check.addEventListener('click', run);
    refresh.addEventListener('click', async () => {
      if (!win.confirm('画面を再読み込みします。保存済みの保有情報は消しませんが、まだ保存していない入力は失われます。入力を保存しましたか？')) return;
      refresh.disabled = true;
      try {
        registration = await win.navigator.serviceWorker?.getRegistration?.();
        await activateAndReload(registration, win.navigator, () => win.location.reload());
      } catch (_) {
        status.textContent = '更新に失敗しました。画面を閉じて開き直してください。保有情報の削除は不要です';
        refresh.disabled = false;
      }
    });
    if (win.navigator.serviceWorker) {
      win.navigator.serviceWorker.getRegistration().then(reg => {
        registration = reg;
        showWaiting();
        reg?.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', showWaiting);
        });
      }).catch(() => {});
    }
    doc.addEventListener('visibilitychange', () => {
      if (!doc.hidden && Date.now() - lastCheck > 300000) run();
    });
    run();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { validRelease, releaseState, readRelease, activateAndReload };
  if (root?.document) mount(root);
})(typeof window === 'undefined' ? null : window);

// House content bridge — mirrors Miya character cards + worldbooks for Adrian.
(function (global) {
  'use strict';

  var SOURCE = 'miya';
  var STATE_KEY = 'miya-house-content-bridge-v1';
  var HOUSE_HOST = 'web-production-204b5.up.railway.app';
  var running = false;

  function toast(message) {
    if (global.miyaSettingsApp && typeof global.miyaSettingsApp.toast === 'function') {
      global.miyaSettingsApp.toast(message);
    } else {
      console.info('[House sync]', message);
    }
  }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function saveState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    refreshSettingsUi();
    return state;
  }

  function pairingState(value) {
    var text = String(value || '').trim();
    if (!text) throw new Error('请粘贴爸爸发来的 Miya 配对链接');
    var url;
    try { url = new URL(text, location.href); }
    catch (e) { throw new Error('配对链接格式不对'); }
    var params = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (params.get('house-content-source') !== SOURCE) throw new Error('这不是 Miya 的配对链接');
    var token = params.get('house-content-token') || '';
    var houseUrl = params.get('house-content-url') || '';
    var house;
    try { house = new URL(houseUrl); }
    catch (e) { throw new Error('配对链接里的 House 地址无效'); }
    if (!token || house.protocol !== 'https:' || house.host !== HOUSE_HOST) {
      throw new Error('配对链接无效或不属于这个 House');
    }
    return { token: token, houseUrl: house.origin, revision: 0, fingerprint: '' };
  }

  async function pair(value) {
    saveState(pairingState(value));
    var ok = await sync({ silent: false });
    refreshSettingsUi();
    return ok;
  }

  function hash(value) {
    var text = JSON.stringify(value);
    var valueHash = 0x811c9dc5;
    for (var i = 0; i < text.length; i += 1) {
      valueHash ^= text.charCodeAt(i);
      valueHash = Math.imul(valueHash, 0x01000193);
    }
    return text.length + ':' + (valueHash >>> 0).toString(16);
  }

  async function storesReady() {
    if (!global.miyaContactsStore || !global.miyaWorldbookStore) {
      throw new Error('Miya 角色卡或世界书还没有载入');
    }
    await Promise.all([
      global.miyaContactsStore.whenReady(),
      global.miyaWorldbookStore.whenReady()
    ]);
  }

  async function readLocal() {
    await storesReady();
    return {
      characters: global.miyaContactsStore.getState(),
      worldbooks: global.miyaWorldbookStore.getState()
    };
  }

  async function writeLocal(snapshot) {
    if (!snapshot.characters || !Array.isArray(snapshot.characters.characters) ||
        !snapshot.worldbooks || !Array.isArray(snapshot.worldbooks.entries)) {
      throw new Error('House 返回的 Miya 数据格式不对');
    }
    if (typeof global.miyaWriteLsJsonKey !== 'function') {
      throw new Error('Miya 存储还没有准备好');
    }
    await Promise.all([
      global.miyaWriteLsJsonKey(global.miyaContactsStore.STORE_KEY, snapshot.characters),
      global.miyaWriteLsJsonKey(global.miyaWorldbookStore.STORE_KEY, snapshot.worldbooks)
    ]);
    global.miyaContactsStore.invalidateCache();
    global.miyaWorldbookStore.invalidateCache();
    await storesReady();
    global.dispatchEvent(new CustomEvent('miya-house-content-synced'));
  }

  function isEmpty(snapshot) {
    return snapshot.characters.characters.length === 0 && snapshot.worldbooks.entries.length === 0;
  }

  async function request(state, method, body) {
    var response = await fetch(
      state.houseUrl.replace(/\/$/, '') + '/api/phone-content/' + SOURCE + '/snapshot',
      {
        method: method,
        headers: {
          Authorization: 'Bearer ' + state.token,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      }
    );
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(payload.detail || ('House 同步失败（' + response.status + '）'));
    return payload;
  }

  async function push(state, local, revision) {
    var result = await request(state, 'PUT', {
      base_revision: revision,
      characters: local.characters,
      worldbooks: local.worldbooks
    });
    if (result.conflict || result.ok === false) return null;
    state.revision = result.revision;
    state.fingerprint = hash(local);
    state.lastSyncedAt = Date.now();
    saveState(state);
    return result;
  }

  async function pull(state, remote) {
    var local = { characters: remote.characters, worldbooks: remote.worldbooks };
    await writeLocal(local);
    state.revision = remote.revision;
    state.fingerprint = hash(local);
    state.lastSyncedAt = Date.now();
    saveState(state);
  }

  async function resolveConflict(state, local, remote) {
    var keepMiya = global.confirm('Miya 和 House 都改过角色卡或世界书。\n\n确定：保留 Miya\n取消：保留 House');
    if (keepMiya) {
      var pushed = await push(state, local, remote.revision);
      if (!pushed) throw new Error('House 又有新修改，请再同步一次');
      toast('已用 Miya 版本更新 House');
    } else {
      await pull(state, remote);
      toast('已取回 House 上的修改');
    }
  }

  async function sync(options) {
    options = options || {};
    var state = loadState();
    if (!state.token || !state.houseUrl || running) return false;
    running = true;
    try {
      var local = await readLocal();
      var remote = await request(state, 'GET');
      var remoteLocal = { characters: remote.characters, worldbooks: remote.worldbooks };
      var localHash = hash(local);
      var remoteHash = hash(remoteLocal);

      if (!state.fingerprint) {
        if (remote.revision === 0 && isEmpty(remoteLocal)) {
          await push(state, local, 0);
          toast('Miya 已连接 House');
        } else if (isEmpty(local)) {
          await pull(state, remote);
          toast('已从 House 取回 Miya 内容');
        } else if (localHash === remoteHash) {
          state.revision = remote.revision;
          state.fingerprint = localHash;
          state.lastSyncedAt = Date.now();
          saveState(state);
          toast('Miya 和 House 已连接');
        } else {
          await resolveConflict(state, local, remote);
        }
        return true;
      }

      if (remote.revision > state.revision) {
        if (localHash === state.fingerprint) {
          await pull(state, remote);
          if (!options.silent) toast('已取回 House 上的修改');
        } else await resolveConflict(state, local, remote);
      } else if (remote.revision < state.revision) {
        throw new Error('House 版本发生回退，已停止自动覆盖');
      } else if (localHash !== state.fingerprint) {
        var result = await push(state, local, remote.revision);
        if (!result) await resolveConflict(state, local, await request(state, 'GET'));
        else if (!options.silent) toast('Miya 修改已同步到 House');
      } else if (remoteHash !== state.fingerprint) {
        await pull(state, remote);
        if (!options.silent) toast('已取回 House 上的修改');
      } else if (!options.silent) toast('Miya 和 House 已同步');
      return true;
    } catch (error) {
      if (!options.silent) toast(error && error.message ? error.message : String(error));
      return false;
    } finally {
      running = false;
      refreshSettingsUi();
    }
  }

  function acceptPairingLink() {
    if (location.hash.indexOf('house-content-source=') < 0) return false;
    try { saveState(pairingState(location.href)); }
    catch (error) { toast(error.message || String(error)); return false; }
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(function () { sync({ silent: false }); }, 1200);
    return true;
  }

  function statusText() {
    var state = loadState();
    if (!state.token) return '未连接';
    if (!state.lastSyncedAt) return '已配对 · 等待首次同步';
    return '已连接 · ' + new Date(state.lastSyncedAt).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function refreshSettingsUi() {
    var status = statusText();
    document.querySelectorAll('[data-miya-house-sync-status]').forEach(function (el) {
      el.textContent = status;
    });
    var paired = !!loadState().token;
    document.querySelectorAll('[data-miya-house-sync-action="sync"], [data-miya-house-sync-action="disconnect"]').forEach(function (el) {
      el.disabled = !paired || running;
    });
  }

  function injectSettingsEntry() {
    var app = document.getElementById('miya-settings-app');
    if (!app || app.querySelector('[data-miya-house-sync-row]')) return;
    var interfaceList = app.querySelector('#miya-st-main .st-feature-card .st-inner-card');
    var drawer = app.querySelector('.ins-vault-drawer');
    if (!interfaceList || !drawer) return;

    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'st-card-row';
    row.setAttribute('data-miya-house-sync-row', '');
    row.innerHTML =
      '<div class="st-card-row-left"><div class="st-card-icon st-card-icon--green">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg></div>' +
        '<div><div class="st-card-label">House 同步</div><div class="st-card-desc" data-miya-house-sync-status></div></div></div>' +
      '<svg class="st-chevron" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    interfaceList.appendChild(row);

    var panel = document.createElement('div');
    panel.className = 'ins-vault-panel';
    panel.id = 'miya-st-panel-house-sync';
    panel.setAttribute('data-panel-title', 'House 同步');
    panel.innerHTML =
      '<div class="st-form">' +
        '<section class="st-form-section"><h4 class="st-form-section__title">连接 House</h4>' +
          '<div class="st-form-card ins-form-block">' +
            '<label class="ins-field-label" for="miya-house-pairing-link">配对链接</label>' +
            '<textarea class="ins-text-input" id="miya-house-pairing-link" rows="5" autocomplete="off" spellcheck="false" placeholder="把爸爸发来的 Miya 配对链接粘贴到这里"></textarea>' +
            '<p class="st-card-desc">只需粘贴一次；密钥不会显示在状态里。</p>' +
            '<button type="button" class="st-action-btn st-action-btn--primary" data-miya-house-sync-action="pair">连接并同步</button>' +
          '</div></section>' +
        '<section class="st-form-section"><h4 class="st-form-section__title">同步状态</h4>' +
          '<div class="st-form-card ins-form-block">' +
            '<div class="st-card-label" data-miya-house-sync-status></div>' +
            '<div class="st-btn-row">' +
              '<button type="button" class="st-action-btn st-action-btn--primary" data-miya-house-sync-action="sync">立即同步</button>' +
              '<button type="button" class="st-action-btn" data-miya-house-sync-action="disconnect">断开连接</button>' +
            '</div>' +
          '</div></section>' +
      '</div>';
    drawer.appendChild(panel);

    row.addEventListener('click', function () {
      if (global.miyaSettingsApp && typeof global.miyaSettingsApp.open === 'function') {
        global.miyaSettingsApp.open(panel.id);
        refreshSettingsUi();
      } else toast('设置模块还没有载入，请稍后再试');
    });
    panel.querySelector('[data-miya-house-sync-action="pair"]').addEventListener('click', async function () {
      var input = panel.querySelector('#miya-house-pairing-link');
      try { await pair(input.value); input.value = ''; }
      catch (error) { toast(error.message || String(error)); }
    });
    panel.querySelector('[data-miya-house-sync-action="sync"]').addEventListener('click', function () {
      sync({ silent: false });
    });
    panel.querySelector('[data-miya-house-sync-action="disconnect"]').addEventListener('click', function () {
      if (!global.confirm('断开 House 同步？Miya 里的数据不会删除。')) return;
      localStorage.removeItem(STATE_KEY);
      refreshSettingsUi();
      toast('已断开 House，Miya 数据没有删除');
    });
    refreshSettingsUi();
  }

  global.miyaHouseContentSync = {
    sync: sync,
    pair: pair,
    disconnect: function () {
      localStorage.removeItem(STATE_KEY);
      refreshSettingsUi();
      toast('已断开 House，Miya 数据没有删除');
    },
    state: loadState
  };

  function boot() {
    injectSettingsEntry();
    if (!acceptPairingLink() && loadState().token) {
      setTimeout(function () { sync({ silent: true }); }, 1800);
    }
    setInterval(function () {
      if (document.visibilityState === 'visible') sync({ silent: true });
    }, 120000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') sync({ silent: true });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);

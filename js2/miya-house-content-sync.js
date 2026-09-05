// House content bridge — mirrors Miya character cards + worldbooks for Adrian.
(function (global) {
  'use strict';

  var SOURCE = 'miya';
  var STATE_KEY = 'miya-house-content-bridge-v1';
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
    return state;
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
    }
  }

  function acceptPairingLink() {
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (params.get('house-content-source') !== SOURCE) return false;
    var token = params.get('house-content-token') || '';
    var houseUrl = params.get('house-content-url') || '';
    if (!token || !/^https:\/\//.test(houseUrl)) return false;
    saveState({ token: token, houseUrl: houseUrl.replace(/\/$/, ''), revision: 0, fingerprint: '' });
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(function () { sync({ silent: false }); }, 1200);
    return true;
  }

  global.miyaHouseContentSync = {
    sync: sync,
    disconnect: function () {
      localStorage.removeItem(STATE_KEY);
      toast('已断开 House，Miya 数据没有删除');
    },
    state: loadState
  };

  function boot() {
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

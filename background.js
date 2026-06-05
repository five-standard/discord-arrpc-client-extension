const DEFAULTS = { arpcUrl: 'ws://127.0.0.1:1337' };
const WS_RETRY_INTERVAL = 10000;

let cfg = { ...DEFAULTS };
let ws = null;
let wsReconnectTimer = null;
let wsNextRetryAt = null;
const tabPorts = new Map();          // tabId → port (모든 Discord 탭)
const tabListenerReady = new Set();  // MAIN world 리스너가 주입된 탭
let primaryTabId = null;
let wsErrorCount = 0;
let wsLastError  = null;
let lastSocketId = null;
let lastPresence = null;
const activeSocketIds = new Set(); // 현재 Discord에 등록된 socketId 목록

// ── 초기화 ──────────────────────────────────────────────────────────────────

chrome.storage.sync.get(DEFAULTS, data => { cfg = data; });

self.addEventListener('error', e => e.preventDefault());
self.addEventListener('unhandledrejection', e => e.preventDefault());

chrome.storage.onChanged.addListener(changes => {
  if (!('arpcUrl' in changes)) return;
  chrome.storage.sync.get(DEFAULTS, data => { cfg = data; restart(); });
});

function closeCodeToReason(code) {
  const map = { 1000: '정상 종료', 1001: '원격 종료', 1006: '비정상 종료 (네트워크 오류)', 1011: '서버 오류', 1015: 'TLS 오류' };
  return map[code] || `오류 코드 ${code}`;
}

function restart() {
  try { ws?.close(); } catch {}  ws = null;
  clearTimeout(wsReconnectTimer);  wsReconnectTimer = null;
  wsNextRetryAt = null;
  wsErrorCount = 0;
  wsLastError   = null;
  if (tabPorts.size > 0) connectRemote();
}

// ── Remote WebSocket ──────────────────────────────────────────────────────────

function scheduleRemoteReconnect() {
  if (tabPorts.size === 0 || wsReconnectTimer) return;
  wsNextRetryAt = Date.now() + WS_RETRY_INTERVAL;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsNextRetryAt    = null;
    connectRemote();
  }, WS_RETRY_INTERVAL);
}

function clearAllPresences() {
  const ids = activeSocketIds.size > 0
    ? [...activeSocketIds]
    : (lastSocketId ? [lastSocketId] : ['disconnect']);
  activeSocketIds.clear();
  lastPresence = null;
  for (const sid of ids) dispatch({ activity: null, pid: 0, socketId: sid }).catch(() => {});
}

function connectRemote() {
  if (ws || !cfg.arpcUrl || tabPorts.size === 0) return;
  try {
    const socket = new WebSocket(cfg.arpcUrl);
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      wsErrorCount  = 0;
      wsLastError   = null;
      wsNextRetryAt = null;
    };
    socket.onmessage = e => {
      if (ws !== socket) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.socketId) lastSocketId = msg.socketId;
        if (msg.activity) {
          activeSocketIds.add(msg.socketId);
          lastPresence = msg;
        } else {
          activeSocketIds.delete(msg.socketId);
          lastPresence = null;
        }
        dispatch(msg).catch(() => {});
      } catch {}
    };
    socket.onclose = ev => {
      if (ws !== socket) return;
      ws = null;
      wsErrorCount++;
      wsLastError = ev.reason || closeCodeToReason(ev.code);
      clearAllPresences();
      scheduleRemoteReconnect();
    };
    socket.onerror = () => {};
  } catch (e) {
    wsErrorCount++;
    wsLastError = e?.message || '연결 실패';
    scheduleRemoteReconnect();
  }
}

// ── MAIN world 리스너 주입 (primary 탭 전용, 1회) ───────────────────────────

async function setupListenerForTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (window.__rpcListener) return;
        window.__rpcListener = true;

        const eachCand = (mod, fn) => {
          if (!mod) return;
          try { fn(mod); } catch {}
          try { if (mod.default) fn(mod.default); } catch {}
          try { for (const k of Reflect.ownKeys(mod)) { try { fn(mod[k]); } catch {} } } catch {}
        };

        const discoverRpc = () => {
          if (!window.webpackChunkdiscord_app) return null;
          const seen = new Set(), reqs = [];
          window.webpackChunkdiscord_app.push([[Symbol()], {}, r => {
            if (r && !seen.has(r)) { seen.add(r); reqs.push(r); }
          }]);
          window.webpackChunkdiscord_app.pop();

          const hasSource = (req, ...needles) => {
            for (const id in req?.m) {
              try {
                const src = req.m[id]?.toString?.();
                if (src && needles.every(n => src.includes(n))) return true;
              } catch {}
            }
            return false;
          };
          const wp = reqs.find(r =>
            hasSource(r, 'getAssetImage: size must === [') &&
            hasSource(r, 'Invalid Origin', 'coverImage', '.application')
          ) || reqs.at(-1);
          if (!wp) return null;

          const vis = new WeakSet();
          let dispatcher;
          const walk = (v, d) => {
            if (dispatcher || !v || (typeof v !== 'object' && typeof v !== 'function')) return;
            if (v === window || v === document || v === globalThis || vis.has(v)) return;
            vis.add(v);
            try {
              if (typeof v.dispatch === 'function' && typeof v.subscribe === 'function') {
                dispatcher = v; return;
              }
            } catch {}
            if (!d) return;
            eachCand(v, c => walk(c, d - 1));
          };
          for (const id in wp.c) { walk(wp.c[id]?.exports, 4); if (dispatcher) break; }

          const findModule = (...needles) => {
            for (const id in wp.m) {
              try {
                const src = wp.m[id]?.toString?.();
                if (!src || !needles.every(n => src.includes(n))) continue;
                return wp(id);
              } catch {}
            }
          };

          let lookupAsset, lookupApp;
          const assetMod = findModule('getAssetImage: size must === [');
          eachCand(assetMod, c => {
            if (lookupAsset || typeof c !== 'function') return;
            const s = c.toString();
            if (s.includes('APPLICATION_ASSETS_FETCH_SUCCESS') && s.includes('startsWith("http:")'))
              lookupAsset = async (appId, name) => (await c(appId, [name]))[0];
          });
          const appMod = findModule('Invalid Origin', 'coverImage', '.application');
          eachCand(appMod, c => {
            if (lookupApp || typeof c !== 'function') return;
            const s = c.toString();
            if (s.includes('Invalid Origin') && s.includes('coverImage') && s.includes('.application'))
              lookupApp = async appId => { const sock = {}; await c(sock, appId); return sock.application; };
          });

          return { dispatcher, lookupAsset, lookupApp };
        };

        const el = document.documentElement;
        if (!window.__rpcDispatchGen) window.__rpcDispatchGen = 0;
        const handleDispatch = async payload => {
          const gen = ++window.__rpcDispatchGen;
          const { activity, pid, socketId } = payload;
          try {
            if (!window.__rpcReady?.dispatcher) window.__rpcReady = discoverRpc();
            const { dispatcher, lookupAsset, lookupApp } = window.__rpcReady ?? {};
            if (!dispatcher) return;
            if (activity) {
              if (lookupAsset) {
                if (activity.assets?.large_image)
                  activity.assets.large_image = await lookupAsset(activity.application_id, activity.assets.large_image);
                if (activity.assets?.small_image)
                  activity.assets.small_image = await lookupAsset(activity.application_id, activity.assets.small_image);
              }
              if (!activity.name && lookupApp) {
                const app = await lookupApp(activity.application_id);
                if (app?.name) activity.name = app.name;
              }
            }
            if (gen !== window.__rpcDispatchGen) return;
            dispatcher.dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', activity, pid, socketId });
          } catch {}
        };
        const observer = new MutationObserver(() => {
          const raw = el.dataset.rpcDispatch;
          if (!raw) return;
          el.removeAttribute('data-rpc-dispatch');
          try { handleDispatch(JSON.parse(raw)); } catch {}
        });
        observer.observe(el, { attributes: true, attributeFilter: ['data-rpc-dispatch'] });
      },
    });
    tabListenerReady.add(tabId);
  } catch {}
}

// ── Discord 탭에 디스패치 ────────────────────────────────────────────────────

// executeScript 폴백용 (리스너 미준비 시 또는 포트 실패 시)
async function rpcInjected(activity, pid, socketId) {
  try {
    if (!window.webpackChunkdiscord_app) return 'no_webpack';
    if (!window.__rpcDispatchGen) window.__rpcDispatchGen = 0;
    const gen = ++window.__rpcDispatchGen;
    if (!window.__rpcReady) {
      const eachCand = (mod, fn) => {
        if (!mod) return;
        try { fn(mod); } catch {}
        try { if (mod.default) fn(mod.default); } catch {}
        try { for (const k of Reflect.ownKeys(mod)) { try { fn(mod[k]); } catch {} } } catch {}
      };
      const seen = new Set(), reqs = [];
      window.webpackChunkdiscord_app.push([[Symbol()], {}, r => {
        if (r && !seen.has(r)) { seen.add(r); reqs.push(r); }
      }]);
      window.webpackChunkdiscord_app.pop();
      const hasSource = (req, ...needles) => {
        for (const id in req?.m) {
          try {
            const src = req.m[id]?.toString?.();
            if (src && needles.every(n => src.includes(n))) return true;
          } catch {}
        }
        return false;
      };
      const wp = reqs.find(r =>
        hasSource(r, 'getAssetImage: size must === [') &&
        hasSource(r, 'Invalid Origin', 'coverImage', '.application')
      ) || reqs.at(-1);
      if (!wp) return 'no_wp_require';
      const vis = new WeakSet();
      let dispatcher;
      const walk = (v, d) => {
        if (dispatcher || !v || (typeof v !== 'object' && typeof v !== 'function')) return;
        if (v === window || v === document || v === globalThis || vis.has(v)) return;
        vis.add(v);
        try {
          if (typeof v.dispatch === 'function' && typeof v.subscribe === 'function') {
            dispatcher = v; return;
          }
        } catch {}
        if (!d) return;
        eachCand(v, c => walk(c, d - 1));
      };
      for (const id in wp.c) { walk(wp.c[id]?.exports, 4); if (dispatcher) break; }
      const findModule = (...needles) => {
        for (const id in wp.m) {
          try {
            const src = wp.m[id]?.toString?.();
            if (!src || !needles.every(n => src.includes(n))) continue;
            return wp(id);
          } catch {}
        }
      };
      let lookupAsset, lookupApp;
      const assetMod = findModule('getAssetImage: size must === [');
      eachCand(assetMod, c => {
        if (lookupAsset || typeof c !== 'function') return;
        const s = c.toString();
        if (s.includes('APPLICATION_ASSETS_FETCH_SUCCESS') && s.includes('startsWith("http:")'))
          lookupAsset = async (appId, name) => (await c(appId, [name]))[0];
      });
      const appMod = findModule('Invalid Origin', 'coverImage', '.application');
      eachCand(appMod, c => {
        if (lookupApp || typeof c !== 'function') return;
        const s = c.toString();
        if (s.includes('Invalid Origin') && s.includes('coverImage') && s.includes('.application'))
          lookupApp = async appId => { const sock = {}; await c(sock, appId); return sock.application; };
      });
      window.__rpcReady = { dispatcher, lookupAsset, lookupApp };
    }
    const { dispatcher, lookupAsset, lookupApp } = window.__rpcReady;
    if (!dispatcher) return 'no_dispatcher';
    if (activity) {
      if (lookupAsset) {
        if (activity.assets?.large_image)
          activity.assets.large_image = await lookupAsset(activity.application_id, activity.assets.large_image);
        if (activity.assets?.small_image)
          activity.assets.small_image = await lookupAsset(activity.application_id, activity.assets.small_image);
      }
      if (!activity.name && lookupApp) {
        const app = await lookupApp(activity.application_id);
        if (app?.name) activity.name = app.name;
      }
    }
    if (gen !== window.__rpcDispatchGen) return 'cancelled';
    dispatcher.dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', activity, pid, socketId });
    return 'ok';
  } catch (e) {
    return 'error:' + (e?.message ?? 'unknown');
  }
}

async function dispatchToTab(tabId, msg) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: rpcInjected,
    args: [msg.activity ?? null, msg.pid ?? 0, msg.socketId ?? 'bridge'],
  });
}

async function dispatch(msg) {
  if (!primaryTabId) return;
  const payload = {
    activity: msg.activity ?? null,
    pid:      msg.pid      ?? 0,
    socketId: msg.socketId ?? 'bridge',
  };

  // 빠른 경로: 포트 → content script → window.postMessage → MAIN world 리스너
  if (tabListenerReady.has(primaryTabId)) {
    const port = tabPorts.get(primaryTabId);
    if (port) {
      try { port.postMessage({ __rpcDispatch: payload }); return; } catch {
        tabListenerReady.delete(primaryTabId); // 포트 실패 시 준비 상태 초기화
      }
    }
  }

  // 폴백: executeScript
  try { await dispatchToTab(primaryTabId, msg); } catch {}
}

// ── 메시지 핸들러 ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getWsStatus') {
    sendResponse({
      connected:   ws?.readyState === 1,
      errorCount:  wsErrorCount,
      lastError:   wsLastError,
      nextRetryAt: wsNextRetryAt,
    });
    return true;
  }

  if (msg.type === 'forceReconnect') {
    try { ws?.close(); } catch {}  ws = null;
    clearTimeout(wsReconnectTimer);  wsReconnectTimer = null;
    wsNextRetryAt = null;
    wsErrorCount  = 0;
    wsLastError   = null;
    connectRemote();
    sendResponse({ ok: true });
    return true;
  }
});

// ── Content Script 포트 관리 ─────────────────────────────────────────────────

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'discord-tab') return;
  const tabId = port.sender?.tab?.id;
  if (!tabId) return;
  tabPorts.set(tabId, port);

  if (tabPorts.size === 1) {
    // 첫 탭: primary 지정 + 리스너 주입 + 소켓 연결
    primaryTabId = tabId;
    setupListenerForTab(tabId);
    connectRemote();
  }
  // 이후 탭: tabPorts에만 등록, 비활성 대기

  port.onDisconnect.addListener(() => {
    tabPorts.delete(tabId);
    tabListenerReady.delete(tabId);

    if (tabPorts.size === 0) {
      // 모든 탭 닫힘
      primaryTabId = null;
      lastPresence = null;
      activeSocketIds.clear();
      try { ws?.close(); } catch {}  ws = null;
      clearTimeout(wsReconnectTimer);  wsReconnectTimer = null;
      wsNextRetryAt = null;
      wsErrorCount  = 0;
      wsLastError   = null;
    } else if (tabId === primaryTabId) {
      // primary 탭 닫힘 → 다음 탭 승격
      primaryTabId = tabPorts.keys().next().value;
      // 리스너 주입 후 lastPresence 복원
      setupListenerForTab(primaryTabId).then(() => {
        if (lastPresence) dispatch(lastPresence).catch(() => {});
      });
    }
  });
});

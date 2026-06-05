const DEFAULTS = { arpcUrl: 'ws://127.0.0.1:1337' };

const $ = id => document.getElementById(id);
const status = $('status');

const setStatus = (msg, cls = '') => {
  status.className = cls;
  status.textContent = msg;
};

// ── 설정 로드 ────────────────────────────────────────────────────────────────

chrome.storage.sync.get(DEFAULTS, cfg => {
  $('arpcUrl').value = cfg.arpcUrl;
  updateWsStatus();
});

chrome.storage.onChanged.addListener(changes => {
  if ('arpcUrl' in changes) $('arpcUrl').value = changes.arpcUrl.newValue;
});

// ── 저장 ────────────────────────────────────────────────────────────────────

$('btnSave').addEventListener('click', () => {
  const cfg = {
    arpcUrl: $('arpcUrl').value.trim() || 'ws://127.0.0.1:1337',
  };

  if (!/^wss?:\/\/.+/.test(cfg.arpcUrl)) {
    setStatus('URL은 ws:// 또는 wss:// 로 시작해야 합니다.', 'err');
    return;
  }

  chrome.storage.sync.set(cfg, () => {
    setStatus('저장되었습니다.', 'ok');
    setTimeout(() => setStatus(''), 2000);
  });
});

// ── arRPC 연결 오류 상태 실시간 표시 ────────────────────────────────────────

async function updateWsStatus() {
  const box = $('wsStatus');
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: 'getWsStatus' });
  } catch {
    box.style.display = 'none';
    return;
  }

  if (s.connected || s.errorCount === 0) { box.style.display = 'none'; return; }

  box.style.display = '';
  $('wsErrCount').textContent = s.errorCount;
  const sec = s.nextRetryAt ? Math.max(0, Math.ceil((s.nextRetryAt - Date.now()) / 1000)) : null;
  $('wsRetryIn').textContent  = sec !== null ? `${sec}초 후` : '연결 중...';
}

setInterval(updateWsStatus, 1000);

$('btnReconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'forceReconnect' });
});

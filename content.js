// Isolated world — SW 생존 유지 + 디스패치 릴레이
function connect() {
  const port = chrome.runtime.connect({ name: 'discord-tab' });
  port.onMessage.addListener(msg => {
    if (msg.__rpcDispatch) document.documentElement.dataset.rpcDispatch = JSON.stringify(msg.__rpcDispatch);
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
}
connect();

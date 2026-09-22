// Probe the MAIN world (where the Kruz content script actually runs)
// via scripting.executeScript — tabs.sendMessage only reaches the
// isolated world, which Kruz intentionally does not populate.
function setStatus(connected) {
  const el = document.getElementById('status');
  const txt = document.getElementById('status-text');
  if (connected) {
    el.className = 'status connected';
    txt.textContent = 'Connected to Kruz';
  } else {
    el.className = 'status disconnected';
    txt.textContent = 'No Kruz tab detected';
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) {
    setStatus(false);
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    world: 'MAIN',
    func: () => ({ ok: !!(window.__kruz__ && window.__kruz__.ping) }),
  }).then((results) => {
    setStatus(results && results[0] && results[0].result && results[0].result.ok === true);
  }).catch(() => {
    setStatus(false);
  });
});
// background.js — PixelGuard service worker (MV3 module)
// On action click: toggle the overlay panel in the current tab.
// Handles PG_CAPTURE (hides overlay during capture) and PG_GET_SOURCE_TAB.

let sourceTabId = null;

chrome.action.onClicked.addListener(async (tab) => {
  sourceTabId = tab.id;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PG_TOGGLE_OVERLAY" });
  } catch {
    // Content script not loaded yet — inject it, then toggle
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "PG_TOGGLE_OVERLAY" });
    } catch (err) {
      console.error("PixelGuard: could not inject content script:", err);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PG_CAPTURE") {
    handleCapture(msg.tabId ?? sourceTabId ?? sender.tab?.id, sendResponse);
    return true; // async
  }
  if (msg.type === "PG_GET_SOURCE_TAB") {
    sendResponse({ tabId: sourceTabId ?? sender.tab?.id });
    return false;
  }
  return false;
});

async function handleCapture(tabId, sendResponse) {
  if (!tabId) {
    sendResponse({ error: "No source tab id" });
    return;
  }
  try {
    // Hide overlay before capture so it doesn't appear in the screenshot
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PG_HIDE_OVERLAY" });
    } catch {}
    // Small delay to let the DOM update before captureVisibleTab reads pixels
    await new Promise((r) => setTimeout(r, 80));
    const dataUrl = await chrome.tabs.captureVisibleTab(tabId, { format: "png" });
    // Restore overlay after capture
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PG_SHOW_OVERLAY" });
    } catch {}
    sendResponse({ screenshotDataUrl: dataUrl });
  } catch (err) {
    // Restore overlay even on error
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PG_SHOW_OVERLAY" });
    } catch {}
    sendResponse({ error: `captureVisibleTab failed: ${String(err)}` });
  }
}

// browser-polyfill.js — Cross-browser API compatibility layer
// Provides a unified `pg` namespace that works in both Chrome (MV3) and Firefox.
// Usage: const api = window.pg; api.tabs.query(...); api.runtime.sendMessage(...);

(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;

  // Firefox uses callbacks by default; wrap in promises if needed
  // (browser.* already returns promises in Firefox WebExtension polyfill mode)
  const pg = {
    tabs: api.tabs,
    runtime: api.runtime,
    scripting: api.scripting,
    storage: api.storage,
    action: api.action || api.browserAction,
    // Firefox doesn't have chrome.runtime.getURL in content scripts context
    getURL: (path) => (api.runtime ? api.runtime.getURL(path) : path),
  };

  // Promisify callback-based APIs (Chrome MV3 service worker uses callbacks)
  if (typeof browser === "undefined") {
    // Chrome: wrap messaging in promises
    pg.runtime.sendMessage = function (msg) {
      return new Promise((resolve, reject) => {
        api.runtime.sendMessage(msg, (response) => {
          if (api.runtime.lastError) {
            reject(new Error(api.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    };

    pg.tabs.sendMessage = function (tabId, msg) {
      return new Promise((resolve, reject) => {
        api.tabs.sendMessage(tabId, msg, (response) => {
          if (api.runtime.lastError) {
            reject(new Error(api.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    };

    pg.tabs.query = function (query) {
      return new Promise((resolve, reject) => {
        api.tabs.query(query, (tabs) => {
          if (api.runtime.lastError) {
            reject(new Error(api.runtime.lastError.message));
          } else {
            resolve(tabs);
          }
        });
      });
    };

    pg.tabs.captureVisibleTab = function (tabId, options) {
      return new Promise((resolve, reject) => {
        api.tabs.captureVisibleTab(tabId, options, (dataUrl) => {
          if (api.runtime.lastError) {
            reject(new Error(api.runtime.lastError.message));
          } else {
            resolve(dataUrl);
          }
        });
      });
    };

    pg.scripting.executeScript = function (params) {
      return new Promise((resolve, reject) => {
        api.scripting.executeScript(params, (result) => {
          if (api.runtime.lastError) {
            reject(new Error(api.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
    };

    pg.storage.local.get = function (keys) {
      return new Promise((resolve) => {
        api.storage.local.get(keys, resolve);
      });
    };

    pg.storage.local.set = function (items) {
      return new Promise((resolve) => {
        api.storage.local.set(items, resolve);
      });
    };
  }

  window.pg = pg;
})();

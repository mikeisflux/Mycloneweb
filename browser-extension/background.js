// Background service worker
// Keeps the extension alive and handles any cross-tab messaging.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Mycloneweb extension installed.');
});

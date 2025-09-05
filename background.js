const DEBUG = false; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

// YouTube Video Blocker Background Script
chrome.runtime.onInstalled.addListener(() => {
  logDebug('YouTube Video Blocker: Setting up context menu');
  // Remove existing menu to prevent duplicate ID error
  chrome.contextMenus.remove('block-youtube-video', () => {
    // Ignore error if menu doesn't exist
    if (chrome.runtime.lastError) {
      logDebug('YouTube Video Blocker: No existing context menu to remove');
    }
    // Create or recreate the context menu
    chrome.contextMenus.create({
      id: 'block-youtube-video',
      title: 'Block video',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/watch*'],
      targetUrlPatterns: ['*://*.youtube.com/watch?v=*']
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error creating context menu:', chrome.runtime.lastError);
      } else {
        logDebug('YouTube Video Blocker: Context menu created successfully');
      }
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-youtube-video') {
    logDebug('YouTube Video Blocker: Context menu clicked for URL:', info.linkUrl);
    chrome.tabs.sendMessage(tab.id, {
      action: 'blockVideo',
      url: info.linkUrl
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending blockVideo message:', chrome.runtime.lastError);
      } else if (response && response.success) {
        logDebug('YouTube Video Blocker: Video blocked successfully:', response);
      } else {
        console.warn('YouTube Video Blocker: Failed to block video, response:', response);
      }
    });
  }
});
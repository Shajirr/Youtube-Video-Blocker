// YouTube Video Blocker Background Script
chrome.runtime.onInstalled.addListener(() => {
  console.log('YouTube Video Blocker: Creating context menu');
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
      console.log('YouTube Video Blocker: Context menu created successfully');
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-youtube-video') {
    console.log('YouTube Video Blocker: Context menu clicked for URL:', info.linkUrl);
    chrome.tabs.sendMessage(tab.id, {
      action: 'blockVideo',
      url: info.linkUrl
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending blockVideo message:', chrome.runtime.lastError);
      } else if (response && response.success) {
        console.log('YouTube Video Blocker: Video blocked successfully:', response);
      } else {
        console.warn('YouTube Video Blocker: Failed to block video, response:', response);
      }
    });
  }
});
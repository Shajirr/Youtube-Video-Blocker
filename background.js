//chrome.storage.local.set({
//    DEBUG: true
//}); // DEBUG value on initial load, only for testing

let DEBUG = false; // default fallback
let removeShorts = false; // Default fallback for Shorts removal
let removeIrrelevantElements = false; // Default fallback

// Load initial settings
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get(['removeShorts', 'removeIrrelevantElements']);
		const debugResult = await chrome.storage.local.get(['DEBUG']);
		
        removeShorts = result.removeShorts === true || result.removeShorts === false ? result.removeShorts : false;
        removeIrrelevantElements = result.removeIrrelevantElements === true || result.removeIrrelevantElements === false ? result.removeIrrelevantElements : false;
        DEBUG = debugResult.DEBUG === true || debugResult.DEBUG === false ? debugResult.DEBUG : false;
        logDebug('YouTube Video Blocker: Loaded settings:', {
            removeShorts,
            removeIrrelevantElements,
            DEBUG
        });
    } catch (error) {
        console.error('YouTube Video Blocker: Error loading settings:', error);
    }
}

// Initialize settings on startup
logDebug('YouTube Video Blocker: Background script initialized');
loadSettings();

function logDebug(...args) {
    if (DEBUG)
        console.log(...args);
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.DEBUG) {
        DEBUG = changes.DEBUG.newValue === true || changes.DEBUG.newValue === false ? changes.DEBUG.newValue : false;
        logDebug('YouTube Video Blocker: Debug mode changed to:', DEBUG);
    }
    if (namespace === 'sync' && changes.removeShorts) {
        removeShorts = changes.removeShorts.newValue === true || changes.removeShorts.newValue === false ? changes.removeShorts.newValue : false;
        logDebug('YouTube Video Blocker: Remove Shorts changed to:', removeShorts);
    }
    if (namespace === 'sync' && changes.removeIrrelevantElements) {
        removeIrrelevantElements = changes.removeIrrelevantElements.newValue === true || changes.removeIrrelevantElements.newValue === false ? changes.removeIrrelevantElements.newValue : false;
        logDebug('YouTube Video Blocker: Clean Search Results changed to:', removeIrrelevantElements);
    }
});

// YouTube Video Blocker Background Script
chrome.runtime.onInstalled.addListener(() => {
    logDebug('YouTube Video Blocker: Setting up context menus');
	
	// Remove only our specific menus to prevent duplicate ID errors
	chrome.contextMenus.remove('block-youtube-video', () => {});
	chrome.contextMenus.remove('block-youtube-channel', () => {});
	chrome.contextMenus.remove('unblock-youtube-channel', () => {});
	chrome.contextMenus.remove('block-youtube-channel-link', () => {});
    chrome.contextMenus.remove('unblock-youtube-channel-link', () => {});

	// Create menus
	setTimeout(() => {
		chrome.contextMenus.create({
			id: 'block-youtube-video',
			title: '\u200BBlock Video',
			contexts: ['link'],
			documentUrlPatterns: [
				'*://*.youtube.com/*' // Allow context menu on all YouTube pages
			],
			targetUrlPatterns: [
				'*://*.youtube.com/watch?v=*', // Watch URLs
				'*://*.youtube.com/shorts/*' // Shorts URLs
			]
		}, () => {
			if (chrome.runtime.lastError) {
				console.error('YouTube Video Blocker: Error creating block video menu:', chrome.runtime.lastError);
			}
		});
		
		chrome.contextMenus.create({
			id: 'block-youtube-channel-from-video',
			title: 'Block Channel',
			contexts: ['link'],
			documentUrlPatterns: [
				'*://*.youtube.com/*'
			],
			targetUrlPatterns: [
				'*://*.youtube.com/watch?v=*',
				'*://*.youtube.com/shorts/*'
			]
		}, () => {
			if (chrome.runtime.lastError) {
				console.error('YouTube Video Blocker: Error creating channel block from video menu:', chrome.runtime.lastError);
			}
		});
		
		chrome.contextMenus.create({
            id: 'block-youtube-channel',
            title: 'Block Channel',
            contexts: ['page', 'selection', 'image', 'link'],
            documentUrlPatterns: ['*://*.youtube.com/@*']
        }, () => {
            if (chrome.runtime.lastError) {
                logDebug('YouTube Video Blocker: Error creating channel block menu:', chrome.runtime.lastError);
            }
        });
		
		chrome.contextMenus.create({
            id: 'unblock-youtube-channel',
            title: 'Unblock Channel',
            contexts: ['page', 'selection', 'image', 'link'],
            documentUrlPatterns: ['*://*.youtube.com/@*']
        }, () => {
            if (chrome.runtime.lastError) {
                logDebug('YouTube Video Blocker: Error creating channel unblock menu:', chrome.runtime.lastError);
            } else {
                logDebug('YouTube Video Blocker: Context menus created successfully');
            }
        });
		
		chrome.contextMenus.create({
                id: 'block-youtube-channel-link',
                title: 'Block Channel',
                contexts: ['link'],
                documentUrlPatterns: ['*://*.youtube.com/*'],
                targetUrlPatterns: ['*://*.youtube.com/@*']
            }, () => {
                if (chrome.runtime.lastError) {
                    logDebug('YouTube Video Blocker: Error creating channel block link menu:', chrome.runtime.lastError);
                }
            });

		chrome.contextMenus.create({
			id: 'unblock-youtube-channel-link',
			title: 'Unblock Channel',
			contexts: ['link'],
			documentUrlPatterns: ['*://*.youtube.com/*'],
			targetUrlPatterns: ['*://*.youtube.com/@*']
		}, () => {
			if (chrome.runtime.lastError) {
				logDebug('YouTube Video Blocker: Error creating channel unblock link menu:', chrome.runtime.lastError);
			} else {
				logDebug('YouTube Video Blocker: Context menus created successfully');
			}
		});
	}, 100); // Small delay to ensure removal completes first
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
    } else if (info.menuItemId === 'block-youtube-channel' || info.menuItemId === 'unblock-youtube-channel') {
        chrome.tabs.sendMessage(tab.id, {
            action: 'getChannelNameFromPage'
        }, (response) => {
            if (response && response.channelName) {
                const action = info.menuItemId === 'block-youtube-channel' ? 'blockChannel' : 'unblockChannel';
                chrome.tabs.sendMessage(tab.id, {
                    action: action,
                    channelName: response.channelName
                });
            } else {
				console.warn('YouTube Video Blocker: Failed to get channel name from channel page:', response);
			}
        });
    } else if (info.menuItemId === 'block-youtube-channel-link' || info.menuItemId === 'unblock-youtube-channel-link') {
		logDebug('YouTube Video Blocker: Context menu clicked for channel URL:', info.linkUrl);
		chrome.tabs.sendMessage(tab.id, {
			action: 'getChannelNameFromLink',
			url: info.linkUrl
		}, (response) => {
			if (response && response.channelName) {
				const action = info.menuItemId === 'block-youtube-channel-link' ? 'blockChannel' : 'unblockChannel';
				chrome.tabs.sendMessage(tab.id, {
					action: action,
					channelName: response.channelName
				});
			} else {
				console.warn('YouTube Video Blocker: Failed to get channel name from link:', response);
			}
		});
    } else if (info.menuItemId === 'block-youtube-channel-from-video') {
		logDebug('YouTube Video Blocker: Block channel from video context menu clicked for URL:', info.linkUrl);
		chrome.tabs.sendMessage(tab.id, {
			action: 'getChannelNameFromVideoLink',
			url: info.linkUrl
		}, (response) => {
			if (response && response.channelName) {
				chrome.tabs.sendMessage(tab.id, {
					action: 'blockChannel',
					channelName: response.channelName
				}, (blockResponse) => {
					if (chrome.runtime.lastError) {
						console.error('Error blocking channel:', chrome.runtime.lastError);
					} else if (blockResponse && blockResponse.success) {
						logDebug('YouTube Video Blocker: Channel blocked successfully:', blockResponse);
					}
				});
			} else {
				console.warn('YouTube Video Blocker: Failed to get channel name from video link:', response);
			}
		});
	}
});

// Redirect from Shorts URLs and Subscriptions Shorts to Subscriptions
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (!removeShorts) {
        logDebug('YouTube Video Blocker: Shorts redirect skipped, removeShorts is false');
        return;
    }
    if (details.url.includes('youtube.com/shorts/')) {
        logDebug('YouTube Video Blocker: Detected Shorts URL, redirecting to Subscriptions:', details.url);
        chrome.tabs.update(details.tabId, {
            url: 'https://www.youtube.com/feed/subscriptions'
        });
    } else if (details.url.includes('youtube.com/feed/subscriptions/shorts')) {
        logDebug('YouTube Video Blocker: Detected Subscriptions Shorts URL, redirecting to Subscriptions:', details.url);
        chrome.tabs.update(details.tabId, {
            url: 'https://www.youtube.com/feed/subscriptions'
        });
    }
}, {
    url: [
        { urlMatches: 'https://www.youtube.com/shorts/*' },
        { urlMatches: 'https://www.youtube.com/feed/subscriptions/shorts*' }
    ]
});
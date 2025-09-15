//chrome.storage.local.set({
//    DEBUG: true
//}); // DEBUG value on initial load, only for testing

let DEBUG = false; // default fallback
let removeShorts = false; // Default fallback for Shorts removal
let cleanSearchResults = false; // Default fallback for Clean Search Results

// Load initial settings
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get(['removeShorts', 'cleanSearchResults']);
		const debugResult = await chrome.storage.local.get(['DEBUG']);
		
        removeShorts = result.removeShorts === true || result.removeShorts === false ? result.removeShorts : false;
        cleanSearchResults = result.cleanSearchResults === true || result.cleanSearchResults === false ? result.cleanSearchResults : false;
        DEBUG = debugResult.DEBUG === true || debugResult.DEBUG === false ? debugResult.DEBUG : false;
        logDebug('YouTube Video Blocker: Loaded settings:', {
            removeShorts,
            cleanSearchResults,
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
    if (namespace === 'sync' && changes.cleanSearchResults) {
        cleanSearchResults = changes.cleanSearchResults.newValue === true || changes.cleanSearchResults.newValue === false ? changes.cleanSearchResults.newValue : false;
        logDebug('YouTube Video Blocker: Clean Search Results changed to:', cleanSearchResults);
    }
});

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
            documentUrlPatterns: [
                '*://*.youtube.com/*' // Allow context menu on all YouTube pages
            ],
            targetUrlPatterns: [
                '*://*.youtube.com/watch?v=*', // Watch URLs
                '*://*.youtube.com/shorts/*' // Shorts URLs
            ]
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
// YouTube Video Blocker Content Script

let DEBUG = false; // default fallback

// Load debug setting asynchronously
chrome.storage.local.get(['DEBUG'], (result) => {
  DEBUG = result.DEBUG !== undefined ? result.DEBUG : false;
});

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.DEBUG) {
    DEBUG = changes.DEBUG.newValue;
    console.log('Debug mode changed to:', DEBUG);
  }
});

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

class YouTubeVideoBlocker {
	
constructor() {
  this.rules = [];
  this.blockedVideoIds = []; // Array of { id: string, title: string }
  this.showPlaceholders = true;
  this.theme = 'light';
  this.extensionEnabled = true;
  this.observer = null;
  this.parentObserver = null;
  this.instanceId = Date.now() + '-' + Math.random().toString(36).substring(2, 9); // Unique instance ID
  this.unblockedVideoIds = new Set(); // Per-tab list of unblocked video IDs
  this.currentUrl = location.href;
  this.init();
}

async init() {
  await this.loadSettings();
  this.setupMessageListener();
  this.setupContextMenu();
  this.startBlocking();
  
  // Listen for storage changes (rules, placeholders, theme, video IDs)
  const debouncedOnStorageChange = debounce((changes, namespace) => {
    if (namespace === 'sync') {
      if (changes.blockingRules) {
        this.rules = changes.blockingRules.newValue || [];
        logDebug('YouTube Video Blocker: Rules updated:', this.rules);
        this.processVideos();
      }
      if (changes.blockedVideoIds && changes.lastUpdateInstance?.newValue !== this.instanceId) {
        this.blockedVideoIds = changes.blockedVideoIds.newValue || [];
        logDebug('YouTube Video Blocker: Blocked video IDs updated:', this.blockedVideoIds);
        this.processVideos();
      }
      if (changes.showPlaceholders) {
        this.showPlaceholders = changes.showPlaceholders.newValue !== false;
        logDebug('YouTube Video Blocker: Show placeholders updated:', this.showPlaceholders);
        this.processVideos();
      }
      if (changes.theme) {
        this.theme = changes.theme.newValue || 'light';
        logDebug('YouTube Video Blocker: Theme updated:', this.theme);
      }
      if (changes.extensionEnabled) {
        this.extensionEnabled = changes.extensionEnabled.newValue !== false;
        logDebug('YouTube Video Blocker: Extension enabled updated:', this.extensionEnabled);
        if (!this.extensionEnabled) {
          this.unblockAllVideos();
          this.stop();
        } else {
          this.startBlocking();
          this.processVideos();
        }
      }
    }
  }, 100);

  chrome.storage.onChanged.addListener(debouncedOnStorageChange);
}

async loadSettings() {
  try {
    const result = await chrome.storage.sync.get(['blockingRules', 'blockedVideoIds', 'showPlaceholders', 'theme', 'extensionEnabled']);
    this.rules = result.blockingRules || [];
    this.blockedVideoIds = result.blockedVideoIds || [];
    this.showPlaceholders = result.showPlaceholders !== false; // Default to true
    this.theme = result.theme || 'light';
    this.extensionEnabled = result.extensionEnabled !== false; // Default to true
    logDebug('YouTube Video Blocker: Loaded settings:', {
      rules: this.rules,
      blockedVideoIds: this.blockedVideoIds,
      showPlaceholders: this.showPlaceholders,
      theme: this.theme,
      extensionEnabled: this.extensionEnabled
    });
  } catch (error) {
    console.error('Error loading settings:', error);
    this.rules = [];
    this.blockedVideoIds = [];
    this.showPlaceholders = true;
    this.theme = 'light';
    this.extensionEnabled = true;
  }
}

// method to extract video ID:
extractVideoId(videoElement) {
  const linkElement = videoElement.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
  logDebug('YouTube Video Blocker: Found link element:', linkElement);
  
  if (linkElement) {
    const href = linkElement.getAttribute('href');
    logDebug('YouTube Video Blocker: Link href:', href);
    const match = href.match(/v=([a-zA-Z0-9_-]{11})|\/shorts\/([a-zA-Z0-9_-]{11})/);
    const videoId = match ? (match[1] || match[2]) : null;
    logDebug('YouTube Video Blocker: Extracted video ID:', videoId);
    return videoId;
  }
  logDebug('YouTube Video Blocker: No link element found in:', videoElement);
  return null;
}

setupContextMenu() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'blockVideo' && message.url) {
      logDebug('YouTube Video Blocker: Received blockVideo message for URL:', message.url);
      const videoIdMatch = message.url.match(/v=([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) {
        console.warn('YouTube Video Blocker: Invalid video ID in URL:', message.url);
        sendResponse({ success: false, error: 'Invalid video ID' });
        return;
      }
      
      const videoId = videoIdMatch[1];
      if (this.blockedVideoIds.some(entry => entry.id === videoId)) {
        logDebug('YouTube Video Blocker: Video ID already blocked:', videoId);
        sendResponse({ success: false, error: 'Video already blocked' });
        return;
      }

      const linkElements = document.querySelectorAll(`a[href*="${message.url}"], a[href*="/watch?v=${videoId}"]`);
      let title = null;
      for (const link of linkElements) {
        const parent = link.closest('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer');
        if (parent) {
          const titleElement = parent.querySelector(
            '.yt-lockup-metadata-view-model__title span[role="text"], ' +
            '.yt-lockup-metadata-view-model__title, ' +
            'h3 a, #video-title, ' +
            'a.yt-lockup-metadata-view-model__title, ' +
            '#title-wrapper h3, .title, ' +
            'span.title, [id="video-title"]'
          );
          if (titleElement) {
            title = titleElement.textContent.trim();
            logDebug('YouTube Video Blocker: Found title:', title);
            break;
          }
        }
      }

      this.blockedVideoIds.push({ id: videoId, title: title || 'Unknown Title' });
      chrome.storage.sync.set({ 
        blockedVideoIds: this.blockedVideoIds,
        lastUpdateInstance: this.instanceId
      }, () => {
        logDebug('YouTube Video Blocker: Blocked video:', { id: videoId, title: title || 'Unknown Title' });
        // Process immediately and retry if needed
        const attemptProcess = (attempt = 1, maxAttempts = 5) => {
          const processed = this.processVideos({ targetVideoId: videoId, force: true });
          if (!processed && attempt < maxAttempts) {
            logDebug(`YouTube Video Blocker: Video ID ${videoId} not found, retrying (${attempt}/${maxAttempts})`);
            requestAnimationFrame(() => attemptProcess(attempt + 1, maxAttempts));
          }
        };
        attemptProcess();
        sendResponse({ success: true, id: videoId, title: title || 'Unknown Title' });
      });

      // Keep message channel open for async storage
      return true;
    }
  });
}

setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'toggleExtension') {
        this.extensionEnabled = message.enabled !== false;
        logDebug('YouTube Video Blocker: Received toggle message, enabled:', this.extensionEnabled);
        if (!this.extensionEnabled) {
          this.unblockAllVideos();
          this.stop();
        } else {
          this.startBlocking();
          this.processVideos();
        }
      }
    });
  }

startBlocking() {
  if (!this.extensionEnabled) return;
  logDebug('YouTube Video Blocker: Starting with', this.rules.length, 'rules, enabled:', this.extensionEnabled);

  // Initial check
  this.processVideos();

  // Add temporary CSS to hide videos before processing when placeholders are disabled
  if (!this.showPlaceholders) {
    const style = document.createElement('style');
    style.id = 'youtube-video-blocker-temp';
    style.textContent = 'yt-lockup-view-model:not([data-blocker-processed]), yt-lockup-view-model[data-blocker-processed="checked"], ytd-video-renderer:not([data-blocker-processed]), ytd-video-renderer[data-blocker-processed="checked"], ytd-compact-video-renderer:not([data-blocker-processed]), ytd-compact-video-renderer[data-blocker-processed="checked"], ytd-rich-item-renderer:not([data-blocker-processed]), ytd-rich-item-renderer[data-blocker-processed="checked"] { display: none; }';
    document.head.appendChild(style);
  }

  // Set up primary observer for all video containers
  this.observer = new MutationObserver((mutations) => {
    if (!this.extensionEnabled) return;
    
    const addedVideos = new Set();
    mutations.forEach(mutation => {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            // Check for video containers
            if (node.matches('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer')) {
              addedVideos.add(node);
            }
            // Check within added nodes
            node.querySelectorAll('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer')
              .forEach(el => addedVideos.add(el));
          }
        });
      }
    });

    if (addedVideos.size > 0) {
      logDebug('YouTube Video Blocker: Detected', addedVideos.size, 'new video elements, processing');
      addedVideos.forEach(video => this.checkAndBlockVideo(video));
    }
  });

// Set up parent observer to detect container replacements
  this.parentObserver = new MutationObserver((mutations) => {
    if (!this.extensionEnabled) return;
    let containerChanged = false;
    mutations.forEach(mutation => {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 && (
              // Watch page containers
              node.matches('#related, ytd-watch-next-secondary-results-renderer') ||
              node.querySelector('#related, ytd-watch-next-secondary-results-renderer') ||
              // Home page containers
              node.matches('#contents, ytd-rich-grid-renderer') ||
              node.querySelector('#contents, ytd-rich-grid-renderer') ||
              // Subscription page containers
              node.matches('ytd-section-list-renderer, ytd-item-section-renderer') ||
              node.querySelector('ytd-section-list-renderer, ytd-item-section-renderer')
          )) {
            containerChanged = true;
            break;
          }
        }
      }
    });

    if (containerChanged) {
      logDebug('YouTube Video Blocker: Detected container change, re-attaching observer');
      this.observer.disconnect();
      this.findTargetNode();
      this.processVideos();
    }
  });

  // Start observing parent for container changes
  this.parentObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Find and observe recommendation section
  this.findTargetNode();
}

	findTargetNode() {
	  // Priority order: try specific containers first, then fallback to document.body
	  const targetSelectors = [
		// Search page - results
		'#contents.ytd-item-section-renderer',
		'ytd-item-section-renderer #contents',
		// Watch page - recommendations
		'#related',
		'ytd-watch-next-secondary-results-renderer',
		// Home page - main grid
		'#contents.ytd-rich-grid-renderer',
		'ytd-rich-grid-renderer #contents',
		// Subscriptions page
		'ytd-section-list-renderer',
		'ytd-item-section-renderer',
		// General fallback
		'ytd-page-manager'
	  ];

	  let targetNode = null;
	  for (const selector of targetSelectors) {
		targetNode = document.querySelector(selector);
		if (targetNode) {
		  logDebug('YouTube Video Blocker: Found target node with selector:', selector);
		  break;
		}
	  }
	  
	  if (targetNode && targetNode !== document.body) {
		logDebug('YouTube Video Blocker: Observing target node:', targetNode.id || targetNode.tagName);
		this.observer.observe(targetNode, {
		  childList: true,
		  subtree: true
		});
		this.processVideos(); // Immediate check when target is found
	  } else {
		console.warn('YouTube Video Blocker: No specific target found, observing document.body');
		this.observer.observe(document.body, {
		  childList: true,
		  subtree: true
		});
		// Retry finding the target node after a delay (one-time)
		setTimeout(() => {
		  if (!this.observer || !this.extensionEnabled) return;
		  for (const selector of targetSelectors) {
			const retryNode = document.querySelector(selector);
			if (retryNode && retryNode !== document.body) {
			  logDebug('YouTube Video Blocker: Retry found target node:', selector);
			  this.observer.disconnect();
			  this.observer.observe(retryNode, {
				childList: true,
				subtree: true
			  });
			  this.processVideos();
			  return;
			}
		  }
		}, 1000);
	  }
	}

processVideos(options = {}) {
  if (!this.extensionEnabled || (this.rules.length === 0 && this.blockedVideoIds.length === 0)) return false;

  // Target recommendation section videos
  const { targetVideoId, force = false } = options;
  
  // Comprehensive selectors for all page types
  const selectors = [
	// Search page - results
	'#contents.ytd-item-section-renderer ytd-video-renderer',
	'ytd-item-section-renderer #contents ytd-video-renderer',
	'#contents.ytd-item-section-renderer yt-lockup-view-model',
	'ytd-item-section-renderer #contents yt-lockup-view-model',
    // Watch page - recommendations section
    '#related yt-lockup-view-model',
    '#items yt-lockup-view-model',
    'ytd-watch-next-secondary-results-renderer yt-lockup-view-model',
    'ytd-item-section-renderer yt-lockup-view-model',
    '#related ytd-video-renderer',
    '#items ytd-video-renderer',
    'ytd-watch-next-secondary-results-renderer ytd-video-renderer',
    'ytd-item-section-renderer ytd-video-renderer',
    '#related ytd-compact-video-renderer',
    '#items ytd-compact-video-renderer',
    'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer',
    'ytd-item-section-renderer ytd-compact-video-renderer',
    
    // Home page - main grid
    '#contents ytd-rich-item-renderer',
    'ytd-rich-grid-renderer ytd-rich-item-renderer',
    '#contents yt-lockup-view-model',
    'ytd-rich-grid-renderer yt-lockup-view-model',
    
    // Subscriptions page
    'ytd-section-list-renderer ytd-video-renderer',
    'ytd-section-list-renderer yt-lockup-view-model',
    'ytd-section-list-renderer ytd-rich-item-renderer',
    
    // General fallbacks
    'ytd-grid-video-renderer',
    'ytd-rich-grid-video-renderer'
  ].join(', ');

  let videoElements = Array.from(document.querySelectorAll(selectors))
    .filter(el => el.dataset?.blockerProcessed !== 'permanently-unblocked')
    .filter(el => targetVideoId ? 
      (el.querySelector(`a[href*="/watch?v=${targetVideoId}"]`) && 
       (!el.dataset.blockerProcessed || el.dataset.blockerProcessed === 'checked')) :
      (!el.dataset.blockerProcessed || el.dataset.blockerProcessed === 'checked'));

  logDebug('YouTube Video Blocker: Found', videoElements.length, 'video elements');
  if (videoElements.length === 0 && !targetVideoId) {
    // Enhanced debugging info for multiple page types
    logDebug('YouTube Video Blocker: Debugging DOM state:', {
	  // Search page elements
	  searchContents: !!document.querySelector('#contents.ytd-item-section-renderer'),
	  searchItemSection: !!document.querySelector('ytd-item-section-renderer'),
	  searchVideoRenderers: document.querySelectorAll('ytd-item-section-renderer ytd-video-renderer').length,
      // Watch page elements
      related: !!document.querySelector('#related'),
      items: !!document.querySelector('#items'),
      renderer: !!document.querySelector('ytd-watch-next-secondary-results-renderer'),
      itemSection: !!document.querySelector('ytd-item-section-renderer'),
      
      // Home page elements
      contents: !!document.querySelector('#contents'),
      richGrid: !!document.querySelector('ytd-rich-grid-renderer'),
      richItems: document.querySelectorAll('ytd-rich-item-renderer').length,
      
      // Subscriptions page elements
      sectionList: !!document.querySelector('ytd-section-list-renderer'),
      
      // Current URL for context
      currentUrl: location.href,
      currentPath: location.pathname,
      
      sampleElements: Array.from(document.querySelectorAll(
        'yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer'
      )).map(el => el.tagName).slice(0, 5),
      sampleTitles: Array.from(document.querySelectorAll(
        '.yt-lockup-metadata-view-model__title span[role="text"], h3 a, #video-title, a.yt-lockup-metadata-view-model__title'
      )).map(el => el.textContent.trim()).slice(0, 3)
    });
  }

  let processed = false;
  videoElements.forEach(videoElement => {
    // Skip permanently unblocked videos
    if (videoElement.dataset?.blockerProcessed === 'permanently-unblocked') {
      return;
    }  
    // Skip if already processed and blocked
    if (videoElement.dataset?.blockerProcessed === 'blocked') return;
    
    this.checkAndBlockVideo(videoElement);
    if (targetVideoId && videoElement.querySelector(`a[href*="/watch?v=${targetVideoId}"]`)) {
      processed = true;
    }
  });
  return processed;
}

checkAndBlockVideo(videoElement) {
  // Find the title element with fallback selectors
  const titleElement = videoElement.querySelector(
	// Search page
	'a#video-title, #video-title, ' +
	'h3.ytd-video-renderer a, ' +
	'.ytd-video-meta-block #video-title, ' +
    // Home page (ytd-rich-item-renderer)
    '.yt-lockup-metadata-view-model__title span[role="text"], ' +
    '.yt-lockup-metadata-view-model__title, ' +
    // Watch page recommendations
    'h3 a, #video-title, ' +
    'a.yt-lockup-metadata-view-model__title, ' +
    '#title-wrapper h3, .title, ' +
    'span.title, [id="video-title"], ' +
    // Subscriptions page
    'a#video-title-link, ' +
    '.ytd-video-meta-block #video-title, ' +
    // Additional fallbacks
    'h3.ytd-video-renderer, ' +
    'a[aria-label*="minutes"]'
  );
  
  if (!titleElement) {
    logDebug('YouTube Video Blocker: Title element not found for video', videoElement);
    logDebug('YouTube Video Blocker: Video element structure:', {
      tagName: videoElement.tagName,
      classList: Array.from(videoElement.classList),
      innerHTML: videoElement.innerHTML.substring(0, 200) + '...'
    });
    videoElement.dataset.blockerProcessed = 'no-title';
    return;
  }

  const title = titleElement.textContent.trim();
  if (!title) {
    console.warn('YouTube Video Blocker: Empty title found for video', videoElement);
    videoElement.dataset.blockerProcessed = 'no-title';
    return;
  }

  // Extract video ID from href
  const linkElement = videoElement.querySelector(
    'a[href*="/watch?v="], a[href*="/shorts/"], ' +
    '.yt-lockup-view-model__content-image[href*="/watch?v="]'
  );
  let videoId = null;
  if (linkElement) {
    const href = linkElement.getAttribute('href');
    const videoIdMatch = href.match(/v=([a-zA-Z0-9_-]{11})|\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch) videoId = videoIdMatch[1] || videoIdMatch[2];
  }

	// Check unblocked list first
	if (videoId) {
	  //logDebug('YouTube Video Blocker: Checking video ID:', videoId);
	  //logDebug('YouTube Video Blocker: Current unblocked list:', Array.from(this.unblockedVideoIds));
	  //logDebug('YouTube Video Blocker: Is video ID in unblocked list?', this.unblockedVideoIds.has(videoId));
	  
	  if (this.unblockedVideoIds.has(videoId)) {
		logDebug('YouTube Video Blocker: Skipping unblocked video ID:', videoId);
		videoElement.dataset.blockerProcessed = 'checked'; // Update the status
		return;
	  }
	} else {
	  logDebug('YouTube Video Blocker: No video ID found for element:', videoElement);
	}
	
	// Skip if already processed and blocked (but allow re-processing if unblocked)
	if (videoElement.dataset?.blockerProcessed === 'blocked') return;

  // Check if title matches any blocking rule or video ID is blocked
  const shouldBlock = this.rules.some(rule => {
    const trimmedRule = rule.trim();
    return trimmedRule && title.toLowerCase().includes(trimmedRule.toLowerCase());
  }) || (videoId && this.blockedVideoIds.some(entry => entry.id === videoId));

  if (shouldBlock) {
    logDebug(`YouTube Video Blocker: Blocking video with title: "${title}"${videoId ? `, ID: ${videoId}` : ''}`);
    if (!this.showPlaceholders) {
      videoElement.style.display = 'none';
      this.removeVideo(videoElement, title);
    } else {
      this.blockVideoWithPlaceholder(videoElement, title);
    }
    videoElement.dataset.blockerProcessed = 'blocked'; // Mark as blocked
  } else {
    videoElement.dataset.blockerProcessed = 'checked'; // Mark as checked but not blocked
  }
}

  blockVideoWithPlaceholder(videoElement, title) {
	const originalParent = videoElement.parentNode;
	const originalNextSibling = videoElement.nextSibling;

	// Extract video ID BEFORE processing changes the DOM structure
	const videoId = this.extractVideoId(videoElement);
	logDebug('YouTube Video Blocker: Extracted video ID during blocking:', videoId);

	  // Get the computed dimensions and styles before removing the element
	  const computedStyle = window.getComputedStyle(videoElement);
	  const elementRect = videoElement.getBoundingClientRect();
	  
	  // Determine if this is a grid layout by checking parent classes or styles
	  const isGridLayout = videoElement.closest('ytd-rich-grid-renderer') || 
						  videoElement.closest('[class*="grid"]') ||
						  computedStyle.display === 'flex' ||
						  computedStyle.display === 'inline-block';
	// Create blocked video placeholder
	const blockedDiv = document.createElement('div');
	blockedDiv.className = 'youtube-video-blocked';
	
	
	// Base styles
	let placeholderStyles = `
		padding: 16px;
		margin: ${computedStyle.margin};
		background: ${this.theme === 'dark' ? '#2a2a2a' : '#f0f0f0'};
		border: 2px dashed ${this.theme === 'dark' ? '#555' : '#ccc'};
		border-radius: 8px;
		text-align: center;
		color: ${this.theme === 'dark' ? '#ccc' : '#666'};
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
		position: relative;
		box-sizing: border-box;
	  `;

	  // Handle width based on layout type
	  if (isGridLayout && elementRect.width > 0) {
		// For grid layouts, match the exact width and maintain flex properties
		placeholderStyles += `
		  width: ${elementRect.width}px;
		  min-width: ${computedStyle.minWidth};
		  max-width: ${computedStyle.maxWidth};
		  flex: ${computedStyle.flex};
		  flex-basis: ${computedStyle.flexBasis};
		  flex-grow: ${computedStyle.flexGrow};
		  flex-shrink: ${computedStyle.flexShrink};
		`;
	  } else {
		// For list layouts, use full width
		placeholderStyles += `
		  width: 100%;
		`;
	  }

	  blockedDiv.style.cssText = placeholderStyles;	

	// Create container for blocked message
	const messageDiv = document.createElement('div');
	messageDiv.style.fontWeight = '500';
	messageDiv.style.marginBottom = '4px';
	messageDiv.textContent = '🚫 Video Blocked';

	// Create title div
	const titleDiv = document.createElement('div');
	titleDiv.style.fontSize = '12px';
	titleDiv.style.opacity = '0.7';
	titleDiv.style.wordBreak = 'break-word';
	titleDiv.style.lineHeight = '1.3';
	titleDiv.textContent = `Title: "${title}"`;

	// Create unblock button
	const unblockButton = document.createElement('button');
	unblockButton.className = 'unblock-btn';
	unblockButton.style.marginTop = '8px';
	unblockButton.style.padding = '4px 8px';
	unblockButton.style.background = 'transparent';
	unblockButton.style.border = '1px solid currentColor';
	unblockButton.style.borderRadius = '4px';
	unblockButton.style.color = 'inherit';
	unblockButton.style.cursor = 'pointer';
	unblockButton.style.fontSize = '11px';
	unblockButton.textContent = 'Show anyway';

	// Append elements to blockedDiv
	blockedDiv.appendChild(messageDiv);
	blockedDiv.appendChild(titleDiv);
	blockedDiv.appendChild(unblockButton);

	// Store original video element in the placeholder for restoration
	blockedDiv._originalVideo = videoElement;
	blockedDiv._originalParent = originalParent;
	blockedDiv._originalNextSibling = originalNextSibling;
	blockedDiv._videoId = videoId; // Store the video ID

	// Click handler for unblock button
	const unblockBtn = blockedDiv.querySelector('.unblock-btn');
	const self = this; // Capture reference to YouTubeVideoBlocker instance
	
	unblockBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		
		const originalVideo = blockedDiv._originalVideo;
		const parent = blockedDiv._originalParent;
		const nextSibling = blockedDiv._originalNextSibling;
		const videoId = blockedDiv._videoId; // Use stored video ID
		
		logDebug('YouTube Video Blocker: Button clicked, starting restoration');
		logDebug('YouTube Video Blocker: Original video:', originalVideo);
		logDebug('YouTube Video Blocker: Parent:', parent, 'Is connected:', parent?.isConnected);
		logDebug('YouTube Video Blocker: Next sibling:', nextSibling, 'Is connected:', nextSibling?.isConnected);
		logDebug('YouTube Video Blocker: Using stored video ID for unblocking:', videoId);
		
		if (videoId) {
		  self.unblockedVideoIds.add(videoId);
		  logDebug('YouTube Video Blocker: Added to unblocked list:', videoId);
		  logDebug('YouTube Video Blocker: Updated unblocked list:', Array.from(this.unblockedVideoIds));
		}
		
		// Reset video element state before restoration
		originalVideo.dataset.blockerProcessed = 'checked';
		originalVideo.style.display = '';
		originalVideo.style.visibility = '';
		originalVideo.style.opacity = '';
		originalVideo.hidden = false;
		
		// Get the placeholder's position for proper insertion
		const placeholderParent = blockedDiv.parentNode;
		const placeholderNextSibling = blockedDiv.nextSibling;
		
		// Remove placeholder
		blockedDiv.remove();
		logDebug('YouTube Video Blocker: Placeholder removed');
		
		// Restore video to the exact position where the placeholder was
		if (placeholderParent && placeholderParent.isConnected) {
			if (placeholderNextSibling) {
				placeholderParent.insertBefore(originalVideo, placeholderNextSibling);
				logDebug('YouTube Video Blocker: Inserted before placeholder next sibling');
			} else {
				placeholderParent.appendChild(originalVideo);
				logDebug('YouTube Video Blocker: Appended to placeholder parent');
			}
		} else {
			// Fallback to original parent if placeholder parent is invalid
			if (parent && parent.isConnected) {
				if (nextSibling && nextSibling.parentNode === parent) {
				  parent.insertBefore(originalVideo, nextSibling);
				logDebug('YouTube Video Blocker: Inserted before original next sibling');
				} else {
				  parent.appendChild(originalVideo);
				logDebug('YouTube Video Blocker: Appended to original parent');
				}
			} else {
				// Last resort fallback
				const fallbackParent = document.querySelector('#related, ytd-watch-next-secondary-results-renderer, #items');
				if (fallbackParent) {
					fallbackParent.appendChild(originalVideo);
					logDebug('YouTube Video Blocker: Appended to fallback parent:', fallbackParent);
				} else {
					logDebug('YouTube Video Blocker: No valid parent found');
					return;
				}
			}
		}
		logDebug('YouTube Video Blocker: Video restored. Visible:', originalVideo.offsetParent !== null);
		logDebug('YouTube Video Blocker: Video parent after restoration:', originalVideo.parentNode);
		logDebug('YouTube Video Blocker: Video display style:', originalVideo.style.display);		
		logDebug('YouTube Video Blocker: Video manually unblocked:', title);
	});

  // Remove video element and insert placeholder
  videoElement.remove();
  if (originalParent.isConnected) {
    originalParent.insertBefore(blockedDiv, originalNextSibling);
  } else {
    const fallbackParent = document.querySelector('#related, ytd-watch-next-secondary-results-renderer') || document.body;
    fallbackParent.appendChild(blockedDiv);
    logDebug('YouTube Video Blocker: Parent node disconnected, inserted placeholder to fallback parent:', fallbackParent);
  }

	chrome.storage.sync.get(['blockedVideosCount'], (result) => {
		const count = (result.blockedVideosCount || 0) + 1;
		chrome.storage.sync.set({ blockedVideosCount: count });
	  });
	}

	// Update blocked videos count
	removeVideo(videoElement, title) {
	  videoElement.remove();
	  chrome.storage.sync.get(['blockedVideosCount'], (result) => {
		const count = (result.blockedVideosCount || 0) + 1;
		chrome.storage.sync.set({ blockedVideosCount: count });
	  });
	}

	unblockAllVideos() {
	  logDebug('YouTube Video Blocker: Unblocking all videos');
	  
	  // Check if placeholders are enabled
	  const blockedPlaceholders = document.querySelectorAll('.youtube-video-blocked');
	  const hasRemovedVideos = document.querySelectorAll('yt-lockup-view-model[data-blocker-processed="blocked"], ytd-video-renderer[data-blocker-processed="blocked"], ytd-compact-video-renderer[data-blocker-processed="blocked"]').length > 0;
	  
	  logDebug('YouTube Video Blocker: Found', blockedPlaceholders.length, 'placeholders');
	  logDebug('YouTube Video Blocker: Has removed videos:', hasRemovedVideos);
	  
	  if (blockedPlaceholders.length > 0) {
		  // Restore videos from placeholders (when showPlaceholders is enabled)
		  logDebug('YouTube Video Blocker: Restoring videos from placeholders');
		  
		  blockedPlaceholders.forEach(blockedDiv => {
			const originalVideo = blockedDiv._originalVideo;
			if (originalVideo) {
			  // Reset video element state
			  originalVideo.dataset.blockerProcessed = 'checked';
			  originalVideo.style.display = '';
			  originalVideo.style.visibility = '';
			  originalVideo.style.opacity = '';
			  originalVideo.hidden = false;
			  
			  // Get the placeholder's position for proper insertion
			  const placeholderParent = blockedDiv.parentNode;
			  const placeholderNextSibling = blockedDiv.nextSibling;
			  
			  // Remove placeholder
			  blockedDiv.remove();
			  
			  // Restore video to the exact position where the placeholder was
			  if (placeholderParent && placeholderParent.isConnected) {
				if (placeholderNextSibling) {
				  placeholderParent.insertBefore(originalVideo, placeholderNextSibling);
				} else {
				  placeholderParent.appendChild(originalVideo);
				}
				logDebug('YouTube Video Blocker: Video restored to placeholder position');
			  } else {
				// Fallback to a valid container
				const fallbackParent = document.querySelector('#related, ytd-watch-next-secondary-results-renderer, #items');
				if (fallbackParent) {
				  fallbackParent.appendChild(originalVideo);
				  logDebug('YouTube Video Blocker: Video restored to fallback parent');
				}
			  }
			} else {
			  logDebug('YouTube Video Blocker: No original video found for placeholder, just removing');
			  blockedDiv.remove();
			}
		  });
	  } else if (!this.showPlaceholders && (this.rules.length > 0 || this.blockedVideoIds.length > 0)) {
		// When placeholders are disabled and we have blocking rules, videos were likely removed
		// The only way to restore them is to refresh the page content
		logDebug('YouTube Video Blocker: Placeholders disabled and blocking rules exist, refreshing page to restore removed videos');
		location.reload();
		return; // Exit early since page is reloading
	  }

	  // Reset processed markers on any remaining videos
	  const videoElements = document.querySelectorAll('yt-lockup-view-model[data-blocker-processed], ytd-video-renderer[data-blocker-processed], ytd-compact-video-renderer[data-blocker-processed]');
	  logDebug('YouTube Video Blocker: Resetting', videoElements.length, 'processed markers');
	  
	  videoElements.forEach(el => {
		if (el.dataset.blockerProcessed === 'blocked' || el.dataset.blockerProcessed === 'checked') {
		  delete el.dataset.blockerProcessed;
		  el.style.display = '';
		  el.style.visibility = '';
		  el.style.opacity = '';
		  el.hidden = false;
		  logDebug('YouTube Video Blocker: Reset video element');
		}
	  });

	  // Remove temporary CSS
	  const tempStyle = document.getElementById('youtube-video-blocker-temp');
	  if (tempStyle) {
		tempStyle.remove();
		logDebug('YouTube Video Blocker: Removed temporary CSS');
	  }
	  
	  // Clear the unblocked video IDs since we're pausing the extension
	  this.unblockedVideoIds.clear();
	  logDebug('YouTube Video Blocker: Cleared unblocked video IDs');
	}
	stop() {
	  if (this.observer) {
		this.observer.disconnect();
	  }
	  if (this.parentObserver) {
		this.parentObserver.disconnect();
	  }
	  // Remove temporary CSS
	  const tempStyle = document.getElementById('youtube-video-blocker-temp');
	  if (tempStyle) tempStyle.remove();
	}
}

// Initialize the blocker
let videoBlocker;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    videoBlocker = new YouTubeVideoBlocker();
  });
} else {
  videoBlocker = new YouTubeVideoBlocker();
}

let currentUrl = location.href;
new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    if (videoBlocker) {
      // Clear unblocked list on URL change
      videoBlocker.unblockedVideoIds.clear();
      logDebug('YouTube Video Blocker: URL changed, cleared unblocked list');
      
      if (currentUrl.includes('/watch')) {
        logDebug('YouTube Video Blocker: Navigation detected, resetting observer');
        videoBlocker.stop();
        videoBlocker.startBlocking();
        videoBlocker.processVideos();
      }
    }
  }
}).observe(document, { subtree: true, childList: true });
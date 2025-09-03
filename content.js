// YouTube Video Blocker Content Script
class YouTubeVideoBlocker {
  constructor() {
    this.rules = [];
    this.showPlaceholders = true;
    this.theme = 'light';
    this.extensionEnabled = true;
    this.observer = null;
    this.parentObserver = null;
    this.init();
  }

  async init() {
    await this.loadSettings();
    this.setupMessageListener();
    this.startBlocking();

    // Listen for storage changes (rules, placeholders, theme)
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync') {
        if (changes.blockingRules) {
          this.rules = changes.blockingRules.newValue || [];
          console.log('YouTube Video Blocker: Rules updated:', this.rules);
          this.processVideos();
        }
        if (changes.showPlaceholders) {
          this.showPlaceholders = changes.showPlaceholders.newValue !== false;
          console.log('YouTube Video Blocker: Show placeholders updated:', this.showPlaceholders);
          this.processVideos();
        }
        if (changes.theme) {
          this.theme = changes.theme.newValue || 'light';
          console.log('YouTube Video Blocker: Theme updated:', this.theme);
        }
        if (changes.extensionEnabled) {
          this.extensionEnabled = changes.extensionEnabled.newValue !== false;
          console.log('YouTube Video Blocker: Extension enabled updated:', this.extensionEnabled);
          if (!this.extensionEnabled) {
            this.unblockAllVideos();
            this.stop();
          } else {
            this.startBlocking();
            this.processVideos();
          }
        }
      }
    });
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.sync.get(['blockingRules', 'showPlaceholders', 'theme', 'extensionEnabled']);
      this.rules = result.blockingRules || [];
      this.showPlaceholders = result.showPlaceholders !== false; // Default to true
      this.theme = result.theme || 'light';
      this.extensionEnabled = result.extensionEnabled !== false; // Default to true 
      console.log('YouTube Video Blocker: Loaded settings:', {
        rules: this.rules,
        showPlaceholders: this.showPlaceholders,
        theme: this.theme,
        extensionEnabled: this.extensionEnabled
      });
    } catch (error) {
      console.error('Error loading settings:', error);
      this.rules = [];
      this.showPlaceholders = true;
      this.theme = 'light';
	  this.extensionEnabled = true;
    }
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'toggleExtension') {
        this.extensionEnabled = message.enabled !== false;
        console.log('YouTube Video Blocker: Received toggle message, enabled:', this.extensionEnabled);
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
  console.log('YouTube Video Blocker: Starting with', this.rules.length, 'rules, enabled:', this.extensionEnabled);

  // Initial check
  this.processVideos();

  // Add temporary CSS to hide videos before processing when placeholders are disabled
  if (!this.showPlaceholders) {
    const style = document.createElement('style');
    style.id = 'youtube-video-blocker-temp';
    style.textContent = 'yt-lockup-view-model:not([data-blocker-processed]) { display: none; }';
    document.head.appendChild(style);
  }

  // Set up primary observer for recommendation section
  this.observer = new MutationObserver((mutations) => {
    if (!this.extensionEnabled) return;
    
    // Batch process added nodes to avoid redundant calls
    const addedVideos = new Set();
    mutations.forEach(mutation => {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            if (node.matches('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer')) {
              addedVideos.add(node);
            }
            node.querySelectorAll('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer')
              .forEach(el => addedVideos.add(el));
          }
        });
      }
    });

    if (addedVideos.size > 0) {
      console.log('YouTube Video Blocker: Detected', addedVideos.size, 'new video elements, processing');
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
              node.matches('#related, ytd-watch-next-secondary-results-renderer') ||
              node.querySelector('#related, ytd-watch-next-secondary-results-renderer')
          )) {
            containerChanged = true;
            break;
          }
        }
      }
    });

    if (containerChanged) {
      console.log('YouTube Video Blocker: Detected container change, re-attaching observer');
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
	  const targetNode = document.querySelector('#related, ytd-watch-next-secondary-results-renderer');
	  if (targetNode) {
		console.log('YouTube Video Blocker: Observing target node:', targetNode.id || targetNode.tagName);
		this.observer.observe(targetNode, {
		  childList: true,
		  subtree: true
		});
		this.processVideos(); // Immediate check when target is found
	  } else {
		console.warn('YouTube Video Blocker: Recommendation section not found, observing body');
		this.observer.observe(document.body, {
		  childList: true,
		  subtree: true
		});
		// Retry finding the target node after a delay (one-time)
		setTimeout(() => {
		  if (!this.observer || !this.extensionEnabled) return;
		  const retryNode = document.querySelector('#related, ytd-watch-next-secondary-results-renderer');
		  if (retryNode && retryNode !== document.body) {
			console.log('YouTube Video Blocker: Retry found target node:', retryNode.id || retryNode.tagName);
			this.observer.disconnect();
			this.observer.observe(retryNode, {
			  childList: true,
			  subtree: true
			});
			this.processVideos();
		  }
		}, 1000);
	  }
	}

  processVideos() {
    if (!this.extensionEnabled || this.rules.length === 0) return;

    // Target recommendation section videos
    const videoElements = document.querySelectorAll(
      '#related yt-lockup-view-model, #items yt-lockup-view-model, ' +
      'ytd-watch-next-secondary-results-renderer yt-lockup-view-model, ' +
      'ytd-item-section-renderer yt-lockup-view-model, ' +
      '#related ytd-video-renderer, #items ytd-video-renderer, ' +
      'ytd-watch-next-secondary-results-renderer ytd-video-renderer, ' +
      'ytd-item-section-renderer ytd-video-renderer, ' +
      '#related ytd-compact-video-renderer, #items ytd-compact-video-renderer, ' +
      'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer, ' +
      'ytd-item-section-renderer ytd-compact-video-renderer'
    );

    console.log('YouTube Video Blocker: Found', videoElements.length, 'video elements');
    if (videoElements.length === 0) {
      console.log('YouTube Video Blocker: Debugging DOM state:', {
        related: !!document.querySelector('#related'),
        items: !!document.querySelector('#items'),
        renderer: !!document.querySelector('ytd-watch-next-secondary-results-renderer'),
        itemSection: !!document.querySelector('ytd-item-section-renderer'),
        continuation: !!document.querySelector('ytd-continuation-item-renderer'),
        sampleElements: Array.from(document.querySelectorAll(
          'yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer'
        )).map(el => el.tagName).slice(0, 3),
        sampleTitles: Array.from(document.querySelectorAll(
          '.yt-lockup-metadata-view-model__title span[role="text"], h3 a, #video-title, a.yt-lockup-metadata-view-model__title'
        )).map(el => el.textContent.trim()).slice(0, 3)
      });
    }
    videoElements.forEach(videoElement => {
      this.checkAndBlockVideo(videoElement);
    });
  }
	checkAndBlockVideo(videoElement) {
	  // Skip if already processed
	  if (videoElement.dataset.blockerProcessed) return;

	  // Find the title element with fallback selectors
	  // Try multiple title selectors to handle DOM variations
	  const titleElement = videoElement.querySelector(
		'.yt-lockup-metadata-view-model__title span[role="text"], ' +
		'.yt-lockup-metadata-view-model__title, ' +
		'h3 a, #video-title, ' +
		'a.yt-lockup-metadata-view-model__title'
	  );
	  if (!titleElement) {
		console.warn('YouTube Video Blocker: Title element not found for video', videoElement);
		videoElement.dataset.blockerProcessed = 'true';
		return;
	  }

	  const title = titleElement.textContent.trim();
	  if (!title) {
		console.warn('YouTube Video Blocker: Empty title found for video', videoElement);
		videoElement.dataset.blockerProcessed = 'true';
		return;
	  }

	  // Check if title matches any blocking rule
	  const shouldBlock = this.rules.some(rule => {
		const trimmedRule = rule.trim();
		return trimmedRule && title.toLowerCase().includes(trimmedRule.toLowerCase());
	  });

	  if (shouldBlock) {
		console.log(`YouTube Video Blocker: Blocking video with title: "${title}"`);
		if (!this.showPlaceholders) {
		  // Ensure video is hidden immediately
		  videoElement.style.display = 'none';
		  this.removeVideo(videoElement, title);
		} else {
		  this.blockVideoWithPlaceholder(videoElement, title);
		}
	  }

	  // Mark as processed
	  videoElement.dataset.blockerProcessed = 'true';
	}

  blockVideoWithPlaceholder(videoElement, title) {
    // Create blocked video placeholder
    const blockedDiv = document.createElement('div');
    blockedDiv.className = 'youtube-video-blocked';
    blockedDiv.style.cssText = `
      padding: 16px;
      margin: 8px 0;
      background: ${this.theme === 'dark' ? '#2a2a2a' : '#f0f0f0'};
      border: 2px dashed ${this.theme === 'dark' ? '#555' : '#ccc'};
      border-radius: 8px;
      text-align: center;
      color: ${this.theme === 'dark' ? '#ccc' : '#666'};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      position: relative;
    `;
	
    blockedDiv.innerHTML = `
      <div style="font-weight: 500; margin-bottom: 4px;">🚫 Video Blocked</div>
      <div style="font-size: 12px; opacity: 0.7;">Title: "${title}"</div>
      <button class="unblock-btn" style="
        margin-top: 8px;
        padding: 4px 8px;
        background: transparent;
        border: 1px solid currentColor;
        border-radius: 4px;
        color: inherit;
        cursor: pointer;
        font-size: 11px;
      ">Show anyway</button>
    `;

    // Add click handler for unblock button
    const unblockBtn = blockedDiv.querySelector('.unblock-btn');
    unblockBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      videoElement.style.display = '';
      blockedDiv.remove();
    });

    // Replace the video element
    videoElement.style.display = 'none';
    videoElement.parentNode.insertBefore(blockedDiv, videoElement);

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
    const blockedElements = document.querySelectorAll('.youtube-video-blocked');
    blockedElements.forEach(blockedDiv => {
      const nextElement = blockedDiv.nextElementSibling;
      if (nextElement && nextElement.tagName === 'YT-LOCKUP-VIEW-MODEL') {
        nextElement.style.display = '';
        blockedDiv.remove();
      }
    });

    // Reset processed markers
    const videoElements = document.querySelectorAll('yt-lockup-view-model[data-blocker-processed]');
    videoElements.forEach(el => {
    delete el.dataset.blockerProcessed;
    el.style.display = ''; // Restore visibility for unblocked videos
	});

	// Remove temporary CSS
	const tempStyle = document.getElementById('youtube-video-blocker-temp');
	if (tempStyle) tempStyle.remove();
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

// Modified: Navigation observer
let currentUrl = location.href;
new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    if (currentUrl.includes('/watch')) {
      console.log('YouTube Video Blocker: Navigation detected, resetting observer');
      if (videoBlocker) {
        videoBlocker.stop();
        videoBlocker.startBlocking();
        videoBlocker.processVideos();
      }
    }
  }
}).observe(document, { subtree: true, childList: true });
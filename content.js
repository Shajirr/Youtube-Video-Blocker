// YouTube Video Blocker Content Script

let DEBUG = false; // default fallback

// Load debug setting asynchronously
chrome.storage.local.get(['DEBUG'], (result) => {
    DEBUG = result.DEBUG !== undefined ? result.DEBUG : false;
});

function logDebug(...args) {
    if (DEBUG)
        console.log(...args);
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
		this.blockedChannelNames = [];
        this.showPlaceholders = true;
        this.removeShorts = false;
        this.removeIrrelevantElements = false;
        this.theme = 'light';
        this.extensionEnabled = true;
        this.observer = null;
        this.parentObserver = null;
        this.videoObserver = null;
        this.instanceId = Date.now() + '-' + Math.random().toString(36).substring(2, 9); // Unique instance ID
        this.unblockedVideoIds = new Set(); // Per-tab list of unblocked video IDs
        this.currentUrl = location.href;
        this.init();
    }

    async init() {
        await this.loadSettings();
        logDebug('YouTube Video Blocker: Initialized with DEBUG:', DEBUG);
        this.setupMessageListener();
        this.startBlocking();

        // Listen for storage changes
        const debouncedOnStorageChange = debounce((changes, namespace) => {
            if (namespace === 'sync') {
                if (changes.blockingRules) {
                    this.rules = changes.blockingRules.newValue || [];
                    logDebug('YouTube Video Blocker: Rules updated:', this.rules);
                    this.processAllVideos();
                }
                if (changes.blockedVideoIds && changes.lastUpdateInstance?.newValue !== this.instanceId) {
                    this.blockedVideoIds = changes.blockedVideoIds.newValue || [];
                    logDebug('YouTube Video Blocker: Blocked video IDs updated:', this.blockedVideoIds);
                    this.processAllVideos();
                }
				if (changes.blockedChannelNames && changes.lastUpdateInstance?.newValue !== this.instanceId) {
					this.blockedChannelNames = changes.blockedChannelNames.newValue || [];
					logDebug('YouTube Video Blocker: Blocked channel names updated:', this.blockedChannelNames);
					this.processAllVideos();
				}
                if (changes.showPlaceholders) {
                    this.showPlaceholders = changes.showPlaceholders.newValue !== false;
                    logDebug('YouTube Video Blocker: Show placeholders updated:', this.showPlaceholders);
                    this.processAllVideos();
                }
                if (changes.removeShorts) {
                    this.removeShorts = changes.removeShorts.newValue === true;
                    logDebug('YouTube Video Blocker: Remove shorts updated:', this.removeShorts);
                    if (this.removeShorts || this.removeIrrelevantElements) {
                        this.startElementsRemoval();
                    } else {
                        this.stopElementsRemoval();
                    }
                }
                if (changes.removeIrrelevantElements) {
                    this.removeIrrelevantElements = changes.removeIrrelevantElements.newValue === true;
                    logDebug('YouTube Video Blocker: removeIrrelevantElements updated:', this.removeIrrelevantElements);
                    if (this.removeIrrelevantElements || this.removeShorts) {
                        this.startElementsRemoval();
                    } else {
                        this.stopElementsRemoval();
                    }
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
                        this.processAllVideos();
                    }
                }
            } else if (namespace === 'local' && changes.DEBUG) {
                DEBUG = changes.DEBUG.newValue === true || changes.DEBUG.newValue === false ? changes.DEBUG.newValue : false;
                logDebug('YouTube Video Blocker: Debug mode changed in content script to:', DEBUG);
            }
        }, 100);

        chrome.storage.onChanged.addListener(debouncedOnStorageChange);
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                        'blockingRules',
                        'blockedVideoIds',
						'blockedChannelNames',
                        'unblockedVideoIds',
                        'showPlaceholders',
                        'removeShorts',
                        'removeIrrelevantElements',
                        'theme',
                        'extensionEnabled'
                    ]);
            const debugResult = await chrome.storage.local.get(['DEBUG']);

            this.rules = result.blockingRules || [];
            this.blockedVideoIds = result.blockedVideoIds || [];
			this.blockedChannelNames = result.blockedChannelNames || [];
            this.showPlaceholders = result.showPlaceholders !== false; // Default to true
            this.removeShorts = result.removeShorts === true || result.removeShorts === false ? result.removeShorts : false;
            this.removeIrrelevantElements = result.removeIrrelevantElements === true || result.removeIrrelevantElements === false ? result.removeIrrelevantElements : false; // Default to false
            this.theme = result.theme || 'light';
            this.extensionEnabled = result.extensionEnabled !== false; // Default to true
            DEBUG = debugResult.DEBUG === true || debugResult.DEBUG === false ? debugResult.DEBUG : false;
            logDebug('YouTube Video Blocker: Loaded settings in content script:', {
                rules: this.rules,
                blockedVideoIds: this.blockedVideoIds,
                showPlaceholders: this.showPlaceholders,
                removeShorts: this.removeShorts,
                removeIrrelevantElements: this.removeIrrelevantElements,
                theme: this.theme,
                extensionEnabled: this.extensionEnabled,
                DEBUG: DEBUG
            });
        } catch (error) {
            console.error('Error loading settings:', error);
            this.rules = [];
            this.blockedVideoIds = [];
            this.showPlaceholders = true;
            this.removeShorts = false;
            this.removeIrrelevantElements = false;
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

	// Method to extract channel name:
	extractChannelName(videoElement) {
		// First try the attributed string format (recommendations section)
		const attributedChannelElement = videoElement.querySelector(
			'.yt-core-attributed-string.yt-content-metadata-view-model__metadata-text'
		);
		
		if (attributedChannelElement) {
			// Get the text content before any child spans (icons, etc.)
			const textNodes = [];
			for (let node of attributedChannelElement.childNodes) {
				if (node.nodeType === Node.TEXT_NODE) {
					textNodes.push(node.textContent.trim());
				} else if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector('svg')) {
					// Include text from non-icon elements that don't contain icons
					const nodeText = node.textContent.trim();
					// Only add if it's not just whitespace and doesn't seem to be a handle/username
					if (nodeText && !nodeText.match(/^[@#]/)) {
						textNodes.push(nodeText);
					}
				}
			}
			const channelName = textNodes.join('').trim();
			if (channelName) {
				//logDebug('YouTube Video Blocker: Found channel name (attributed string):', channelName);
				return channelName;
			}
		}

		// Try the link format (Home page)
		const linkChannelElement = videoElement.querySelector(
			'a.yt-core-attributed-string__link'
		);
		
		if (linkChannelElement) {
			const channelName = linkChannelElement.textContent.trim();
			if (channelName) {
				logDebug('YouTube Video Blocker: Found channel name (link text):', channelName);
				return channelName;
			}
		}

		// Fallback selectors for other layouts
		const fallbackSelectors = [
			'.ytd-channel-name yt-formatted-string',
			'#channel-name yt-formatted-string', 
			'.ytd-video-meta-block #channel-name yt-formatted-string',
			'yt-formatted-string.ytd-channel-name'
		];

		for (const selector of fallbackSelectors) {
			const element = videoElement.querySelector(selector);
			if (element) {
				const channelName = element.textContent.trim();
				if (channelName) {
					logDebug('YouTube Video Blocker: Found channel name (fallback):', channelName);
					return channelName;
				}
			}
		}

		logDebug('YouTube Video Blocker: No channel name found for video', videoElement);
		return null;
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
                    this.processAllVideos();
                }
            } else if (message.action === 'blockVideo' && message.url) {
                logDebug('YouTube Video Blocker: Received blockVideo message for URL:', message.url);
                const videoIdMatch = message.url.match(/v=([a-zA-Z0-9_-]{11})/);
                if (!videoIdMatch) {
                    console.warn('YouTube Video Blocker: Invalid video ID in URL:', message.url);
                    sendResponse({
                        success: false,
                        error: 'Invalid video ID'
                    });
                    return;
                }

                const videoId = videoIdMatch[1];
                if (this.blockedVideoIds.some(entry => entry.id === videoId)) {
                    logDebug('YouTube Video Blocker: Video ID already blocked:', videoId);
                    sendResponse({
                        success: false,
                        error: 'Video already blocked'
                    });
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
                                'span.title, [id="video-title"]');
                        if (titleElement) {
                            title = titleElement.textContent.trim();
                            logDebug('YouTube Video Blocker: Found title:', title);
                            break;
                        }
                    }
                }

                this.blockedVideoIds.push({
                    id: videoId,
                    title: title || 'Unknown Title'
                });
                chrome.storage.sync.set({
                    blockedVideoIds: this.blockedVideoIds,
                    lastUpdateInstance: this.instanceId
                }, () => {
                    logDebug('YouTube Video Blocker: Blocked video:', {
                        id: videoId,
                        title: title || 'Unknown Title'
                    });
                    // Process immediately and retry if needed
                    const attemptProcess = (attempt = 1, maxAttempts = 5) => {
                        const processed = this.processAllVideos({
                            targetVideoId: videoId,
                            force: true
                        });
                        if (!processed && attempt < maxAttempts) {
                            logDebug(`YouTube Video Blocker: Video ID ${videoId} not found, retrying (${attempt}/${maxAttempts})`);
                            requestAnimationFrame(() => attemptProcess(attempt + 1, maxAttempts));
                        }
                    };
                    attemptProcess();
                    sendResponse({
                        success: true,
                        id: videoId,
                        title: title || 'Unknown Title'
                    });
                });

                // Keep message channel open for async storage
                return true;
            } else if (message.action === 'blockChannel' && message.channelName) {
				logDebug('YouTube Video Blocker: Received blockChannel message for channel:', message.channelName);
				
				if (this.blockedChannelNames.includes(message.channelName)) {
					logDebug('YouTube Video Blocker: Channel already blocked:', message.channelName);
					sendResponse({
						success: false,
						error: 'Channel already blocked'
					});
					return;
				}

				this.blockedChannelNames.push(message.channelName);
				chrome.storage.sync.set({
					blockedChannelNames: this.blockedChannelNames,
					lastUpdateInstance: this.instanceId
				}, () => {
					logDebug('YouTube Video Blocker: Blocked channel:', message.channelName);
					this.processAllVideos({ force: true });
					sendResponse({
						success: true,
						channelName: message.channelName
					});
				});

				return true;

			} else if (message.action === 'getChannelNameFromPage') {
				
				
				logDebug('YouTube Video Blocker: Getting channel name from current page');
				
				// Ensure we respond even if we don't find the channel name
				try {
				
				// Try multiple selectors for channel name on channel pages
				const channelNameSelectors = [
					// New YouTube layout - the exact structure from your HTML
					'yt-dynamic-text-view-model h1 .yt-core-attributed-string',
					'yt-dynamic-text-view-model .yt-core-attributed-string[role="text"]',
					'.yt-page-header-view-model__page-header-title h1 .yt-core-attributed-string',
					'.yt-page-header-view-model__page-header-title .yt-core-attributed-string',
					// Additional fallbacks
					'yt-dynamic-text-view-model h1 span',
					'yt-dynamic-text-view-model span[role="text"]',
					'#channel-name .ytd-channel-name',
					'ytd-channel-name #text',
					'.ytd-c4-tabbed-header-renderer #text',
					'h1.ytd-channel-name',
					'.ytd-channel-header-renderer h1'
				];
				
				let channelName = null;
				for (const selector of channelNameSelectors) {
					const element = document.querySelector(selector);
					console.log('YouTube Video Blocker: Trying selector:', selector, 'Element found:', !!element);
					
					if (element) {
						console.log('YouTube Video Blocker: Element HTML:', element.outerHTML.substring(0, 200) + '...');
						let textContent = '';
						
						// Special handling for yt-core-attributed-string elements
						if (element.classList.contains('yt-core-attributed-string')) {
							// First try: Get direct text content, filtering out icon elements
							const clonedElement = element.cloneNode(true);
							// Remove icon elements from the clone
							const icons = clonedElement.querySelectorAll('.ytIconWrapperHost, .yt-icon-shape, svg, [role="img"]');
							icons.forEach(icon => icon.remove());
							
							textContent = clonedElement.textContent.trim();
							console.log('YouTube Video Blocker: Clone method extracted:', textContent);
							
							// If that didn't work, try TreeWalker with less aggressive filtering
							if (!textContent) {
								const walker = document.createTreeWalker(
									element,
									NodeFilter.SHOW_TEXT,
									{
										acceptNode: function(node) {
											// Only reject if the immediate parent is an icon
											const parent = node.parentElement;
											if (parent && (
												parent.classList.contains('ytIconWrapperHost') ||
												parent.classList.contains('yt-icon-shape') ||
												parent.tagName === 'svg'
											)) {
												return NodeFilter.FILTER_REJECT;
											}
											return NodeFilter.FILTER_ACCEPT;
										}
									}
								);
								
								let textNode;
								while (textNode = walker.nextNode()) {
									const text = textNode.textContent.trim();
									if (text) {
										textContent = text;
										break;
									}
								}
							}
						} else {
							// Fallback for other element types
							if (element.hasChildNodes()) {
								// Get only text nodes, skip icon elements
								for (let node of element.childNodes) {
									if (node.nodeType === Node.TEXT_NODE) {
										const text = node.textContent.trim();
										if (text) textContent += text;
									} else if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector('svg, yt-icon')) {
										const text = node.textContent.trim();
										if (text) textContent += text;
									}
								}
							} else {
								textContent = element.textContent.trim();
							}
						}
						
						console.log('YouTube Video Blocker: Extracted text:', textContent);
						
						if (textContent) {
							channelName = textContent;
							console.log('YouTube Video Blocker: Found channel name with selector:', selector, channelName);
							break;
						}
					}
				}
				
				console.log('YouTube Video Blocker: Found channel name on page:', channelName);
				
				// Always send a response, even if channelName is null
				sendResponse({
					success: channelName !== null,
					channelName: channelName
				});
				
				} catch (error) {
					console.log('YouTube Video Blocker: Error extracting channel name:', error);
					sendResponse({
						success: false,
						channelName: null,
						error: error.message
					});
				}
				
				return true; // Keep message channel open

				
			} else if (message.action === 'getChannelNameFromLink' && message.url) {
				logDebug('YouTube Video Blocker: Received getChannelNameFromLink message for URL:', message.url);
				
				// Extract channel handle from URL (e.g., @mndiaye_97)
				const channelHandleMatch = message.url.match(/@([^/?]+)/);
				if (!channelHandleMatch) {
					logDebug('YouTube Video Blocker: No channel handle found in URL');
					sendResponse({ channelName: null });
					return true;
				}
				
				const channelHandle = '@' + channelHandleMatch[1];
				logDebug('YouTube Video Blocker: Looking for channel handle:', channelHandle);
				
				// Try multiple approaches to find the link and extract channel name
				const linkSelectors = [
					`a[href*="${channelHandle}"]`,
					`a[href*="/@${channelHandleMatch[1]}"]`,
					`a[href="${message.url}"]`,
					`a[href^="${message.url.split('?')[0]}"]`
				];
				
				let channelName = null;
				for (const selector of linkSelectors) {
					const linkElements = document.querySelectorAll(selector);
					
					for (const linkElement of linkElements) {
						// Skip if this is just a channel URL without display text
						if (linkElement.href === message.url && !linkElement.textContent.trim()) {
							continue;
						}
						
						// Try to get channel name from the link or nearby elements
						let extractedName = '';
						
						// First try: Get text from the link itself
						if (linkElement.textContent.trim() && !linkElement.textContent.trim().startsWith('@')) {
							// Filter out verification icons and other non-text content
							const textNodes = [];
							for (let node of linkElement.childNodes) {
								if (node.nodeType === Node.TEXT_NODE) {
									const text = node.textContent.trim();
									if (text) textNodes.push(text);
								} else if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector('svg, yt-icon')) {
									const text = node.textContent.trim();
									if (text && !text.match(/^[@#]/)) textNodes.push(text);
								}
							}
							extractedName = textNodes.join(' ').trim();
						}
						
						// Second try: Look for channel name in parent container
						if (!extractedName) {
							const videoContainer = linkElement.closest('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer');
							if (videoContainer) {
								extractedName = this.extractChannelName(videoContainer);
							}
						}
						
						if (extractedName) {
							channelName = extractedName;
							logDebug('YouTube Video Blocker: Extracted channel name from link:', channelName);
							break;
						}
					}
					
					if (channelName) break;
				}
				
				logDebug('YouTube Video Blocker: Final channel name result:', channelName);
				sendResponse({ channelName: channelName });
				return true;
            } else if (message.action === 'unblockChannel' && message.channelName) {
				logDebug('YouTube Video Blocker: Received unblockChannel message for channel:', message.channelName);
				
				const channelIndex = this.blockedChannelNames.indexOf(message.channelName);
				if (channelIndex === -1) {
					logDebug('YouTube Video Blocker: Channel not in blocked list:', message.channelName);
					sendResponse({
						success: false,
						error: 'Channel not blocked'
					});
					return;
				}

				this.blockedChannelNames.splice(channelIndex, 1);
				chrome.storage.sync.set({
					blockedChannelNames: this.blockedChannelNames,
					lastUpdateInstance: this.instanceId
				}, () => {
					logDebug('YouTube Video Blocker: Unblocked channel:', message.channelName);
					// Process immediately to unblock videos from this channel
					this.processAllVideos({ force: true });
					sendResponse({
						success: true,
						channelName: message.channelName
					});
				});

				// Keep message channel open for async storage
				return true;
			}
        });
    }

    startBlocking() {
        if (!this.extensionEnabled)
            return;
        logDebug('YouTube Video Blocker: Starting with', this.rules.length, 'rules, enabled:', this.extensionEnabled);

        const startObserving = () => {
            if (this.removeShorts || this.removeIrrelevantElements) {
                this.startElementsRemoval();
            }

            // Start video blocking
            this.startVideoBlocking();

            if (!this.showPlaceholders) {
                const style = document.createElement('style');
                style.id = 'youtube-video-blocker-temp';
                style.textContent = 'yt-lockup-view-model:not([data-blocker-processed]), yt-lockup-view-model[data-blocker-processed="checked"], ytd-video-renderer:not([data-blocker-processed]), ytd-video-renderer[data-blocker-processed="checked"], ytd-compact-video-renderer:not([data-blocker-processed]), ytd-compact-video-renderer[data-blocker-processed="checked"], ytd-rich-item-renderer:not([data-blocker-processed]), ytd-rich-item-renderer[data-blocker-processed="checked"] { display: none; }';
                document.head.appendChild(style);
            }
        };
		
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startObserving);
        } else {
            startObserving();
        }

        logDebug('Setup ParentObserver');
        this.setupParentObserver();
    }

    setupParentObserver() {
        // Set up parent observer to detect container replacements
        this.parentObserver = new MutationObserver(debounce((mutations) => {
                    if (!this.extensionEnabled)
                        return;
                    let containerChanged = false;
                    mutations.forEach(mutation => {
                        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeType === 1 && (
                                        // Watch page containers with video content
                                        (node.matches('#related, ytd-watch-next-secondary-results-renderer') &&
                                            node.querySelector('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer')) ||
                                        // Home page containers with video content
                                        (node.matches('#contents, ytd-rich-grid-renderer') &&
                                            node.querySelector('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer')) ||
                                        // Subscription page containers with video content
                                        (node.matches('ytd-section-list-renderer, ytd-item-section-renderer') &&
                                            node.querySelector('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer')))) {
                                    containerChanged = true;
                                    break;
                                }
                            }
                        }
                    });

                    if (containerChanged) {
                        logDebug('YouTube Video Blocker: Detected container change, re-attaching observer');
                        this.observer.disconnect();
                        this.processAllVideos();
                    }
                }, 1000));

        // Start observing parent for container changes
        this.parentObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    checkAndBlockVideo(videoElement) {
        const titleElement = videoElement.querySelector(
                'a#video-title, #video-title, ' +
                'h3.ytd-video-renderer a, ' +
                '.ytd-video-meta-block #video-title, ' +
                '.yt-lockup-metadata-view-model__title span[role="text"], ' +
                '.yt-lockup-metadata-view-model__title, ' +
                'h3 a, #video-title, ' +
                'a.yt-lockup-metadata-view-model__title, ' +
                '#title-wrapper h3, .title, ' +
                'span.title, [id="video-title"], ' +
                'a#video-title-link, ' +
                '.ytd-video-meta-block #video-title, ' +
                'h3.ytd-video-renderer, ' +
                'a[aria-label*="minutes"]');

		const channelName = this.extractChannelName(videoElement);
		//logDebug('YouTube Video Blocker: Extracted channel name:', channelName);
        if (!titleElement) {
            logDebug('YouTube Video Blocker: Title element not found for video', videoElement);
            logDebug('YouTube Video Blocker: Video element structure:', {
                tagName: videoElement.tagName,
                classList: Array.from(videoElement.classList),
                innerHTML: videoElement.innerHTML.substring(0, 200) + '...',
                parentStructure: videoElement.parentNode ? {
                    tagName: videoElement.parentNode.tagName,
                    classList: Array.from(videoElement.parentNode.classList)
                }
                 : null
            });
            videoElement.dataset.blockerProcessed = 'no-title';
            return;
        }

        const title = titleElement.textContent.trim();
        if (!title) {
            console.warn('YouTube Video Blocker: Empty title found for video', videoElement);
            logDebug('YouTube Video Blocker: Video element structure:', {
                tagName: videoElement.tagName,
                classList: Array.from(videoElement.classList),
                innerHTML: videoElement.innerHTML.substring(0, 200) + '...',
                parentStructure: videoElement.parentNode ? {
                    tagName: videoElement.parentNode.tagName,
                    classList: Array.from(videoElement.parentNode.classList)
                }
                 : null
            });
            videoElement.dataset.blockerProcessed = 'no-title';
            return;
        }

        const linkElement = videoElement.querySelector(
                'a[href*="/watch?v="], a[href*="/shorts/"], ' +
                '.yt-lockup-view-model__content-image[href*="/watch?v="]');
        let videoId = null;
        if (linkElement) {
            const href = linkElement.getAttribute('href');
            const videoIdMatch = href.match(/v=([a-zA-Z0-9_-]{11})|\/shorts\/([a-zA-Z0-9_-]{11})/);
            if (videoIdMatch)
                videoId = videoIdMatch[1] || videoIdMatch[2];
        } else {
            logDebug('YouTube Video Blocker: No link element found for video', videoElement);
            logDebug('YouTube Video Blocker: Video element structure:', {
                tagName: videoElement.tagName,
                classList: Array.from(videoElement.classList),
                innerHTML: videoElement.innerHTML.substring(0, 200) + '...',
                parentStructure: videoElement.parentNode ? {
                    tagName: videoElement.parentNode.tagName,
                    classList: Array.from(videoElement.parentNode.classList)
                }
                 : null
            });
        }

        if (videoId && this.unblockedVideoIds.has(videoId)) {
            logDebug('YouTube Video Blocker: Skipping unblocked video ID:', videoId);
            videoElement.dataset.blockerProcessed = 'checked';
            return;
        }

        if (videoElement.dataset?.blockerProcessed === 'blocked')
            return;

        const shouldBlock = this.rules.some(rule => {
            const trimmedRule = rule.trim();
            return trimmedRule && title.toLowerCase().includes(trimmedRule.toLowerCase());
        }) || (videoId && this.blockedVideoIds.some(entry => entry.id === videoId)) ||
		   (channelName && this.blockedChannelNames.some(blockedChannel => 
       blockedChannel.toLowerCase() === channelName.toLowerCase()));

        if (shouldBlock) {
            logDebug(`YouTube Video Blocker: Blocking video with title: "${title}"${videoId ? `, ID: ${videoId}` : ''}${channelName ? `, Channel: ${channelName}` : ''}`);
            if (!this.showPlaceholders) {
                videoElement.style.display = 'none';
                this.removeVideo(videoElement, title);
            } else {
                this.blockVideoWithPlaceholder(videoElement, title);
            }
            videoElement.dataset.blockerProcessed = 'blocked';
        } else {
            videoElement.dataset.blockerProcessed = 'checked';
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
            chrome.storage.sync.set({
                blockedVideosCount: count
            });
        });
    }

    // Update blocked videos count
    removeVideo(videoElement, title) {
        videoElement.remove();
        chrome.storage.sync.get(['blockedVideosCount'], (result) => {
            const count = (result.blockedVideosCount || 0) + 1;
            chrome.storage.sync.set({
                blockedVideosCount: count
            });
        });
    }

    // Shorts and irrelevant elements cleanup
    startElementsRemoval() {
        if (!this.extensionEnabled)
            return;
        logDebug('YouTube Video Blocker: Starting Shorts and irrelevant elements cleanup');

        // Remove existing Shorts and irrelevant sections immediately
        this.removeElements();

        // Set up observer for Shorts and irrelevant elements cleanup
        this.shortsObserver = new MutationObserver((mutations) => {
            if (!this.extensionEnabled || (!this.removeShorts && !this.cleanSearchResults))
                return;

            let foundElements = false;
            mutations.forEach(mutation => {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            // Check for Shorts or irrelevant elements
                            if (this.isShortsOrIrrelevantElement(node)) {
                                foundElements = true;
                                this.removeShortsElement(node);
                            }
                            // Check within added nodes
                            const elements = node.querySelectorAll ? this.findShortsAndIrrelevantElements(node) : [];

                            if (elements.length > 0) {
                                foundElements = true;
                                elements.forEach(el => this.removeShortsElement(el));
                            }
                        }
                    });
                }
            });

            if (foundElements) {
                logDebug('YouTube Video Blocker: Removed Shorts or irrelevant search elements');
            }
        });

        // Observe the entire document
        this.shortsObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
		logDebug('YouTube Video Blocker: Element observer started');													 
    }

    stopElementsRemoval() {
        if (this.shortsObserver) {
            this.shortsObserver.disconnect();
            this.shortsObserver = null;
            logDebug('YouTube Video Blocker: Stopped Shorts and irrelevant elements cleanup');
        }
    }

    startVideoBlocking() {
        if (!this.extensionEnabled)
            return;
        logDebug('YouTube Video Blocker: Starting video blocking');

        // Remove existing videos immediately
        this.processAllVideos();

        // Set up observer for video blocking
        this.videoObserver = new MutationObserver((mutations) => {
            if (!this.extensionEnabled)
                return;

            let foundVideos = false;
            mutations.forEach(mutation => {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            // Check if the added node is a video element
                            if (this.isVideoElement(node)) {
                                foundVideos = true;
                                this.checkAndBlockVideo(node);
                            }
                            // Check within added nodes
                            const videoElements = node.querySelectorAll ? this.findVideoElements(node) : [];
                            if (videoElements.length > 0) {
                                foundVideos = true;
                                videoElements.forEach(el => this.checkAndBlockVideo(el));
                            }
                        }
                    });
                }
            });

            if (foundVideos) {
                logDebug('YouTube Video Blocker: Processed new video elements from mutations');
            }
        });

        // Observe the entire document for videos
        this.videoObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    stopVideoBlocking() {
        if (this.videoObserver) {
            this.videoObserver.disconnect();
            this.videoObserver = null;
            logDebug('YouTube Video Blocker: Stopped video blocking observer');
        }
    }

    processAllVideos() {
        if (!this.extensionEnabled)
            return;

        logDebug('YouTube Video Blocker: Processing all existing videos');

        const selectors = [
            // Search page - results
            '#contents.ytd-item-section-renderer ytd-video-renderer',
            'ytd-item-section-renderer #contents ytd-video-renderer',
            '#contents.ytd-item-section-renderer yt-lockup-view-model',
            'ytd-item-section-renderer #contents yt-lockup-view-model',
            'ytd-search ytd-video-renderer',
            'ytd-search yt-lockup-view-model',
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
            'ytd-rich-grid-video-renderer',
            'ytd-shelf-renderer ytd-video-renderer',
            'ytd-shelf-renderer yt-lockup-view-model',
            'ytd-search-result-renderer' // Potential new element
        ].join(', ');

        const videoElements = this.findVideoElements(document);
        videoElements.forEach(element => {
            this.checkAndBlockVideo(element);
        });
    }

    isVideoElement(element) {
        if (!element.matches)
            return false;

        return (
            element.matches('yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-rich-grid-video-renderer, ytd-search-result-renderer') &&
            !this.isShortsOrIrrelevantElement(element) // Exclude Shorts and irrelevant sections
        );
    }

    findVideoElements(container) {
        const selectors = [
            'yt-lockup-view-model',
            'ytd-video-renderer',
            'ytd-compact-video-renderer',
            'ytd-rich-item-renderer',
            'ytd-grid-video-renderer',
            'ytd-rich-grid-video-renderer',
            'ytd-search-result-renderer'
        ].join(', ');

        let videoElements = [];
        selectors.split(', ').forEach(selector => {
            try {
                const elements = container.querySelectorAll(selector);
                videoElements = videoElements.concat(Array.from(elements));
            } catch (e) {
                logDebug('YouTube Video Blocker: Invalid selector:', selector, e);
            }
        });

        // Filter to exclude Shorts and irrelevant sections
        return videoElements.filter(el => !this.isShortsOrIrrelevantElement(el));
    }

    // Method to detect Shorts within ytd-video-renderer
    isVideoRendererShorts(videoElement) {
        // Check for Shorts thumbnail link
        if (videoElement.querySelector('a[href*="/shorts/"]')) {
            return true;
        }

        // Check for Shorts overlay indicator
        const timeOverlay = videoElement.querySelector('ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]');
        if (timeOverlay) {
            return true;
        }

        // Check for hide-time-status attribute (often used with Shorts)
        const hideTimeStatus = videoElement.querySelector('ytd-thumbnail-overlay-time-status-renderer[hide-time-status]');
        if (hideTimeStatus && hideTimeStatus.hasAttribute('overlay-style') &&
            hideTimeStatus.getAttribute('overlay-style') === 'SHORTS') {
            return true;
        }

        return false;
    }

    isShortsOrIrrelevantElement(element) {
        if (!element.matches){
			logDebug('YouTube Video Blocker: Element lacks matches method:', element);
            return false;
		}

        // Avoid matching large page containers
        if (element.matches('ytd-search, ytd-page-manager, body, html')) {
			logDebug('YouTube Video Blocker: Skipping large container:', element.tagName);
            return false;
        }

        // Check for Shorts elements
        const isShorts = (
            // Sidebar Shorts link (specific guide entry)
            (element.matches('ytd-guide-entry-renderer') &&
                element.querySelector('yt-formatted-string') &&
                element.querySelector('yt-formatted-string').textContent.trim() === 'Shorts') ||

            // Mini guide Shorts link
            (element.matches('ytd-mini-guide-entry-renderer') &&
                (element.getAttribute('aria-label') === 'Shorts' || element.querySelector('a[title="Shorts"]'))) ||

            // Shorts shelves on Home/Subscriptions pages
            (element.matches('ytd-rich-section-renderer') &&
                element.querySelector('a[href*="/shorts/"], ytd-reel-item-renderer, [data-shorts-shelf], grid-shelf-view-model.ytGridShelfViewModelHost')) ||
            element.matches('grid-shelf-view-model.ytGridShelfViewModelHost') ||
            element.matches('ytd-rich-shelf-renderer[is-shorts-shelf]') ||
			element.matches('ytd-rich-shelf-renderer[is-shorts]') ||
            element.matches('ytd-reel-shelf-renderer') ||

            // Individual Shorts videos
            element.matches('ytd-reel-item-renderer') ||
            element.matches('ytd-video-renderer[is-shorts]') ||

            // Check if ytd-video-renderer or ytd-compact-video-renderer contains Shorts indicators
            ((element.matches('ytd-video-renderer') || element.matches('ytd-compact-video-renderer')) && this.isVideoRendererShorts(element)) ||

            // Shorts sections with specific data attributes
            element.matches('[data-shorts-shelf]') ||

            // Direct Shorts links (not within large containers)
            (element.matches('a[href*="/shorts/"]') && !element.closest('ytd-search, ytd-page-manager')));

        if (this.removeShorts && isShorts) {
			logDebug('YouTube Video Blocker: Identified as Shorts element:', element.tagName, Array.from(element.classList));				  
            return true;
        }

        // Check for irrelevant sections
        		if (this.removeIrrelevantElements && (location.href.includes('/results?search_query=') || location.href.match(/^https:\/\/www\.youtube\.com\/?$/))) {
            const isIrrelevant = (
                // Horizontal card lists (e.g., "People also search for")
                element.matches('ytd-horizontal-card-list-renderer') ||
                // Shelves with specific titles like "Previously watched", "From related searches", "Channels new to you"
                (element.matches('ytd-shelf-renderer') &&
                    element.querySelector('#title')?.textContent.match(/People also search for|Previously watched|Channels new to you|From related searches/i)));
            return isIrrelevant;
        }

        return false;
    }

    findShortsAndIrrelevantElements(container) {
		if (!this.removeShorts && !this.removeIrrelevantElements) return [];
		
        const selectors = [
            // Shorts selectors
            'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
            'ytd-mini-guide-entry-renderer a[title="Shorts"]',
            // Shorts shelves and sections on Home/Subscriptions
            'ytd-rich-section-renderer a[href*="/shorts/"]',
            'ytd-rich-section-renderer grid-shelf-view-model.ytGridShelfViewModelHost',
            'ytd-rich-section-renderer ytd-reel-item-renderer',
            'ytd-rich-section-renderer[data-shorts-shelf]',
            'grid-shelf-view-model.ytGridShelfViewModelHost',
            'ytd-rich-shelf-renderer[is-shorts-shelf]',
			'ytd-rich-shelf-renderer[is-shorts]',
            'ytd-reel-shelf-renderer',
            'ytd-reel-item-renderer',
            'ytd-video-renderer[is-shorts]',
            'ytd-compact-video-renderer a[href*="/shorts/"]',
            '[data-shorts-shelf]',
            // Direct Shorts links (exclude main page containers)
            'a[href*="/shorts/"]:not(ytd-search a):not(ytd-page-manager a)'
        ];

        // Irrelevant section selectors
		if (this.removeIrrelevantElements && (location.href.includes('/results?search_query=') || location.href.match(/^https:\/\/www\.youtube\.com\/?$/))) {
            selectors.push(
                'ytd-horizontal-card-list-renderer',
                'ytd-shelf-renderer' // Will filter by title in isShortsOrIrrelevantElement
            );
        }

        let elements = [];
        selectors.forEach(selector => {
            try {
                const foundElements = container.querySelectorAll(selector);
				if (foundElements.length > 0) {
					logDebug('YouTube Video Blocker: Selector found elements:', selector, foundElements.length);
				}
                elements = elements.concat(Array.from(foundElements));
            } catch (e) {
                logDebug('YouTube Video Blocker: Invalid selector:', selector, e);
            }
        });

        // Special handling for Shorts link in sidebar
        if (this.removeShorts) {
            const guideEntries = container.querySelectorAll('ytd-guide-entry-renderer');
            guideEntries.forEach(entry => {
                const titleElement = entry.querySelector('yt-formatted-string');
                if (titleElement && titleElement.textContent.trim() === 'Shorts') {
                    elements.push(entry);
					logDebug('YouTube Video Blocker: Added Shorts guide entry');											 
                }
            });

            // Check ytd-video-renderer and ytd-compact-video-renderer for Shorts indicators
            const videoRenderers = container.querySelectorAll('ytd-video-renderer, ytd-compact-video-renderer');
            videoRenderers.forEach(video => {
                if (this.isVideoRendererShorts && this.isVideoRendererShorts(video)) {
                    elements.push(video);
					logDebug('YouTube Video Blocker: Added Shorts video renderer');												
                }
            });

            // Check ytd-rich-section-renderer for Shorts content
            const richSections = container.querySelectorAll('ytd-rich-section-renderer');
            richSections.forEach(section => {
                if (section.querySelector('a[href*="/shorts/"], ytd-reel-item-renderer, [data-shorts-shelf], grid-shelf-view-model.ytGridShelfViewModelHost')) {
                    elements.push(section);
					logDebug('YouTube Video Blocker: Added Shorts rich section');											  
                }
            });
        }

        // Filter to include only valid Shorts or irrelevant elements
        return elements.filter(el => this.isShortsOrIrrelevantElement(el));
    }

    // Handle both Shorts and irrelevant sections
    removeShortsElement(element) {
        // Find the appropriate element to remove
        let elementToRemove = element;

        // For Shorts: Sidebar Shorts link
        if (this.removeShorts && (element.matches('ytd-guide-entry-renderer') || element.closest('ytd-guide-entry-renderer'))) {
            const guideEntry = element.closest('ytd-guide-entry-renderer') || element;
            const titleElement = guideEntry.querySelector('yt-formatted-string');
            if (titleElement && titleElement.textContent.trim() === 'Shorts') {
                elementToRemove = guideEntry;
            } else {
                return;
            }
        }
        // For Shorts: Mini guide (collapsed sidebar)
        else if (this.removeShorts && (element.matches('ytd-mini-guide-entry-renderer') || element.closest('ytd-mini-guide-entry-renderer'))) {
            const miniGuideEntry = element.closest('ytd-mini-guide-entry-renderer') || element;
            if (miniGuideEntry.getAttribute('aria-label') === 'Shorts' ||
                miniGuideEntry.querySelector('a[title="Shorts"]')) {
                elementToRemove = miniGuideEntry;
            } else {
                return;
            }
        }
        // For Notifications: Handle ytd-notification-renderer
        else if (this.removeShorts && (element.matches('ytd-notification-renderer') || element.closest('ytd-notification-renderer'))) {
            const notification = element.closest('ytd-notification-renderer') || element;
            if (notification.querySelector('a[href*="/shorts/"]')) {
                elementToRemove = notification;
            } else {
                return;
            }
        }
        // For Shorts: Home/Subscriptions page Shorts sections
        else if (this.removeShorts && (element.matches('ytd-rich-section-renderer') || element.closest('ytd-rich-section-renderer'))) {
            const richSection = element.closest('ytd-rich-section-renderer') || element;
            if (richSection.querySelector('a[href*="/shorts/"], ytd-reel-item-renderer, [data-shorts-shelf], grid-shelf-view-model.ytGridShelfViewModelHost')) {
                elementToRemove = richSection;
            } else {
                return;
            }
        }
        // For Shorts: Individual ytd-video-renderer or ytd-compact-video-renderer that contains Shorts
        else if (this.removeShorts && (element.matches('ytd-video-renderer') || element.matches('ytd-compact-video-renderer'))) {
            if (this.isVideoRendererShorts && this.isVideoRendererShorts(element)) {
                elementToRemove = element;
            } else {
                return;
            }
        }
        // For Shorts: Shorts shelves
        else if (this.removeShorts && (element.matches('grid-shelf-view-model') || element.closest('grid-shelf-view-model'))) {
            elementToRemove = element.closest('grid-shelf-view-model') || element;
        } else if (this.removeShorts && (element.matches('ytd-rich-shelf-renderer[is-shorts-shelf]') || element.closest('ytd-rich-shelf-renderer[is-shorts-shelf]'))) {
            elementToRemove = element.closest('y td-rich-shelf-renderer[is-shorts-shelf]') || element;
        } else if (this.removeShorts && (element.matches('ytd-reel-shelf-renderer') || element.closest('ytd-reel-shelf-renderer'))) {
            elementToRemove = element.closest('ytd-reel-shelf-renderer') || element;
        }
        // For Shorts: Individual Shorts videos
        else if (this.removeShorts && (element.matches('ytd-reel-item-renderer') || element.closest('ytd-reel-item-renderer'))) {
            elementToRemove = element.closest('ytd-reel-item-renderer') || element;
        }
        // For Shorts: Individual Shorts links
        else if (this.removeShorts && element.matches('a[href*="/shorts/"]')) {
            const videoContainer = element.closest('ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model');
            if (videoContainer) {
                elementToRemove = videoContainer;
            } else {
                elementToRemove = element;
            }
        }
        // For irrelevant elements: Horizontal card lists (e.g., "People also search for")
        else if (this.removeIrrelevantElements && location.href.includes('/results?search_query=') &&
            element.matches('ytd-horizontal-card-list-renderer')) {
            elementToRemove = element;
        }
        // For irrelevant elements: Shelves with specific titles
        else if (this.removeIrrelevantElements && location.href.includes('/results?search_query=') &&
            element.matches('ytd-shelf-renderer')) {
            const titleElement = element.querySelector('#title');
            if (titleElement && titleElement.textContent.match(/People also search for|Previously watched|Channels new to you|From related searches/i)) {
                elementToRemove = element;
            } else {
                return;
            }
        }
        // Don't remove large containers
        else if (element.matches('ytd-search, ytd-page-manager, ytd-guide-section-renderer')) {
            logDebug('YouTube Video Blocker: Skipping removal of large container:', element.tagName);
            return;
        }

        if (elementToRemove && elementToRemove.parentNode && elementToRemove !== document.body) {
            logDebug('YouTube Video Blocker: Removing element:', elementToRemove.tagName, elementToRemove.className);
            elementToRemove.remove();
        }
    }

    // Remove Shorts and irrelevant sections
    removeElements() {
        if (!this.removeShorts && !this.removeIrrelevantElements || !this.extensionEnabled)
            return;

        logDebug('YouTube Video Blocker: Removing all existing Shorts and irrelevant search sections');

        // Find and remove all existing Shorts and irrelevant elements
        const elements = this.findShortsAndIrrelevantElements(document);
		if (elements > 0) {
			logDebug('YouTube Video Blocker: Found elements to remove:', elements.length, elements);
		}
        elements.forEach(element => {
            this.removeShortsElement(element);
        });

        // Also remove Shorts navigation link specifically
        if (this.removeShorts) {
            const shortsNavLinks = document.querySelectorAll('ytd-guide-entry-renderer a[title*="Shorts"], ytd-guide-entry-renderer[title*="Shorts"]');
            shortsNavLinks.forEach(link => {
                const parentEntry = link.closest('ytd-guide-entry-renderer');
                if (parentEntry) {
                    logDebug('YouTube Video Blocker: Removing Shorts nav link');
                    parentEntry.remove();
                }
            });
        }
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
        if (this.shortsObserver) {
            this.shortsObserver.disconnect();
        }
        if (this.videoObserver) {
            this.videoObserver.disconnect();
        }
        // Remove temporary CSS
        const tempStyle = document.getElementById('youtube-video-blocker-temp');
        if (tempStyle)
            tempStyle.remove();
    }
}

// Initialize the blocker
let videoBlocker;

try {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => {
			videoBlocker = new YouTubeVideoBlocker();
		});
	} else {
		videoBlocker = new YouTubeVideoBlocker();
	}
} catch (error) {
       console.error('YouTube Video Blocker: Failed to initialize:', error);
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
                videoBlocker.processAllVideos();
            }
        }
    }
}).observe(document, {
    subtree: true,
    childList: true
});
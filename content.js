// YouTube Video Blocker Content Script

let DEBUG = false; // default fallback

const OBSERVER_LIFETIME = 5000;

// Load debug setting asynchronously
browser.storage.local.get(["DEBUG"], (result) => {
  DEBUG = result.DEBUG !== undefined ? result.DEBUG : false;
});

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Call the real analyzeYTTitle() function from the background script
async function analyzeYTTitle(title) {
  logDebug("YouTube Video Blocker: Sending title for analysis:", title);

  try {
    const result = await browser.runtime.sendMessage({
      action: "analyzeTitle",
      title: title
    });

    //logDebug("YouTube Video Blocker: Received analysis result:", result);
    return result; // Returns {score, blocked, reasons}
  } catch (error) {
    console.error("Message error:", error);
    return { score: 0, blocked: false, reasons: "Error" };
  }
}

class YouTubeVideoBlocker {
  static TITLE_SELECTOR =
    "a#video-title, #video-title, h3.ytd-video-renderer a, " +
    ".ytd-video-meta-block #video-title, " +
    '.yt-lockup-metadata-view-model__title span[role="text"], ' +
    ".yt-lockup-metadata-view-model__title, h3 a, " +
    "a.yt-lockup-metadata-view-model__title, #title-wrapper h3, .title, " +
    'span.title, [id="video-title"], a#video-title-link, ' +
    'h3.ytd-video-renderer, a[aria-label*="minutes"]';

  constructor() {
    this.rules = [];
    this.blockedVideoIds = []; // Array of { id: string, title: string }
    this.blockedChannelNames = [];
    this.showPlaceholders = true;
    this.removeShorts = false;
    this.removeIrrelevantElements = false;
    this.blockClickbaitVaguetitles = false;
    this.theme = "light";
    this.extensionEnabled = true;
    this.parentObserver = null;
    this.videoObserver = null;
    this.instanceId = Date.now() + "-" + Math.random().toString(36).substring(2, 9); // Unique instance ID
    this.unblockedVideoIds = new Set(); // Per-tab list of unblocked video IDs
    this.clickbaitTitleCache = new Map(); // title -> result {score, blocked, reasons}
    this.pendingObservers = new Map(); // videoElement -> observer
    this.init();
  }

  async init() {
    await this.loadSettings();
    logDebug("YouTube Video Blocker: Initialized with DEBUG:", DEBUG);
    this.setupMessageListener();
    this.startBlocking();

    // Listen for storage changes
    const debouncedOnStorageChange = debounce((changes, namespace) => {
      if (namespace === "sync") {
        if (changes.blockingRules) {
          this.rules = changes.blockingRules.newValue || [];
          logDebug("YouTube Video Blocker: Rules updated:", this.rules);
          // Force re-process
          document
            .querySelectorAll('[data-blocker-processed="checked"]')
            .forEach((el) => delete el.dataset.blockerProcessed);
          this.processAllVideos();
        }
        if (changes.blockedVideoIds) {
          // Build oldIds from the current local array (already updated by push() if
          // this tab triggered the change) so cross-tab new IDs are hidden while
          // own-tab new IDs are skipped
          const oldIds = new Set(this.blockedVideoIds.map((e) => e.id));
          this.blockedVideoIds = changes.blockedVideoIds.newValue || [];
          logDebug("YouTube Video Blocker: Blocked video IDs updated:", this.blockedVideoIds);
          // Hide the newly added IDs
          this.blockedVideoIds.forEach((entry) => {
            if (!oldIds.has(entry.id)) {
              this.forceHideVideoById(entry.id);
            }
          });
        }
        if (changes.blockedChannelNames && changes.lastUpdateInstance?.newValue !== this.instanceId) {
          this.blockedChannelNames = changes.blockedChannelNames.newValue || [];
          logDebug("YouTube Video Blocker: Blocked channel names updated:", this.blockedChannelNames);
          document
            .querySelectorAll('[data-blocker-processed="checked"]')
            .forEach((el) => delete el.dataset.blockerProcessed);
          this.processAllVideos();
        }
        if (changes.showPlaceholders) {
          this.showPlaceholders = changes.showPlaceholders.newValue !== false;
          logDebug("YouTube Video Blocker: Show placeholders updated:", this.showPlaceholders);
          this.processAllVideos();
        }
        if (changes.removeShorts) {
          this.removeShorts = changes.removeShorts.newValue === true;
          logDebug("YouTube Video Blocker: Remove shorts updated:", this.removeShorts);
          if (this.removeShorts || this.removeIrrelevantElements) {
            this.startElementsRemoval();
          } else {
            this.stopElementsRemoval();
          }
        }
        if (changes.removeIrrelevantElements) {
          this.removeIrrelevantElements = changes.removeIrrelevantElements.newValue === true;
          logDebug("YouTube Video Blocker: removeIrrelevantElements updated:", this.removeIrrelevantElements);
          if (this.removeIrrelevantElements || this.removeShorts) {
            this.startElementsRemoval();
          } else {
            this.stopElementsRemoval();
          }
        }
        if (changes.blockClickbaitVaguetitles) {
          this.blockClickbaitVaguetitles = changes.blockClickbaitVaguetitles.newValue === true;
          logDebug("YouTube Video Blocker: blockClickbaitVaguetitles updated:", this.blockClickbaitVaguetitles);
          this.processAllVideos();
        }
        if (changes.theme) {
          this.theme = changes.theme.newValue || "light";
          logDebug("YouTube Video Blocker: Theme updated:", this.theme);
        }
        if (changes.extensionEnabled) {
          this.extensionEnabled = changes.extensionEnabled.newValue !== false;
          logDebug("YouTube Video Blocker: Extension enabled updated:", this.extensionEnabled);
          if (!this.extensionEnabled) {
            this.unblockAllVideos();
            this.stop();
          } else {
            this.startBlocking();
            this.processAllVideos();
          }
        }
      } else if (namespace === "local" && changes.DEBUG) {
        DEBUG = changes.DEBUG.newValue === true;
        logDebug("YouTube Video Blocker: Debug mode changed in content script to:", DEBUG);
      }
    }, 100);

    browser.storage.onChanged.addListener(debouncedOnStorageChange);
  }

  async loadSettings() {
    try {
      const result = await browser.storage.sync.get([
        "blockingRules",
        "blockedVideoIds",
        "blockedChannelNames",
        "showPlaceholders",
        "removeShorts",
        "removeIrrelevantElements",
        "blockClickbaitVaguetitles",
        "theme",
        "extensionEnabled"
      ]);
      const debugResult = await browser.storage.local.get(["DEBUG"]);

      this.rules = result.blockingRules || [];
      this.blockedVideoIds = result.blockedVideoIds || [];
      this.blockedChannelNames = result.blockedChannelNames || [];
      this.showPlaceholders = result.showPlaceholders !== false; // Default to true
      this.removeShorts = result.removeShorts === true;
      this.removeIrrelevantElements = result.removeIrrelevantElements === true;
      this.blockClickbaitVaguetitles = result.blockClickbaitVaguetitles === true;
      this.theme = result.theme || "light";
      this.extensionEnabled = result.extensionEnabled !== false; // Default to true
      DEBUG = debugResult.DEBUG === true;
      logDebug("YouTube Video Blocker: Loaded settings in content script:", {
        rules: this.rules,
        blockedVideoIds: this.blockedVideoIds,
        showPlaceholders: this.showPlaceholders,
        removeShorts: this.removeShorts,
        removeIrrelevantElements: this.removeIrrelevantElements,
        blockClickbaitVaguetitles: this.blockClickbaitVaguetitles,
        theme: this.theme,
        extensionEnabled: this.extensionEnabled,
        DEBUG: DEBUG
      });
      // Force re-process on load
      document
        .querySelectorAll('[data-blocker-processed="checked"]')
        .forEach((el) => delete el.dataset.blockerProcessed);
      this.processAllVideos();
    } catch (error) {
      console.error("Error loading settings:", error);
      this.rules = [];
      this.blockedVideoIds = [];
      this.showPlaceholders = true;
      this.removeShorts = false;
      this.removeIrrelevantElements = false;
      this.blockClickbaitVaguetitles = false;
      this.theme = "light";
      this.extensionEnabled = true;
    }
  }

  // Method to extract video ID:
  extractVideoId(videoElement) {
    const linkElement = videoElement.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    logDebug("YouTube Video Blocker: Found link element:", linkElement);

    if (linkElement) {
      const href = linkElement.getAttribute("href");
      logDebug("YouTube Video Blocker: Link href:", href);
      const match = href.match(/v=([a-zA-Z0-9_-]{11})|\/shorts\/([a-zA-Z0-9_-]{11})/);
      const videoId = match ? match[1] || match[2] : null;
      logDebug("YouTube Video Blocker: Extracted video ID:", videoId);
      return videoId;
    }
    logDebug("YouTube Video Blocker: No link element found in:", videoElement);
    return null;
  }

  forceHideVideoById(videoId) {
    const selectors = [`a[href*="/watch?v=${videoId}"]`, `a[href*="/shorts/${videoId}"]`];

    let foundTitle = null;

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((link) => {
        // Prefer the inner lockup for consistency; fall back to outer wrappers
        // for older layouts where yt-lockup-view-model is absent.
        const videoEl =
          link.closest("yt-lockup-view-model") ||
          link.closest(
            "ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer"
          );
        if (videoEl && videoEl.dataset.blockerProcessed !== "blocked") {
          // Extract title
          const titleEl = videoEl.querySelector(YouTubeVideoBlocker.TITLE_SELECTOR);
          if (titleEl && !foundTitle) {
            foundTitle = titleEl.textContent.trim();
          }

          if (!this.showPlaceholders) {
            this.hideVideoElement(videoEl);
            videoEl.dataset.blockerProcessed = "blocked";
          } else {
            this.blockVideoWithPlaceholder(videoEl, foundTitle || "Manually blocked", "video");
          }
          logDebug(`YouTube Video Blocker: Force-hid video ID ${videoId}`);
        }
      });
    }

    return foundTitle;
  }

  // Method to extract channel name:
  extractChannelName(videoElement) {
    // First try the attributed string format (recommendations section)
    const attributedChannelElement = videoElement.querySelector(
      ".yt-core-attributed-string.yt-content-metadata-view-model__metadata-text"
    );

    if (attributedChannelElement) {
      // Get the text content before any child spans (icons, etc.)
      const textNodes = [];
      for (let node of attributedChannelElement.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodes.push(node.textContent.trim());
        } else if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector("svg")) {
          // Include text from non-icon elements that don't contain icons
          const nodeText = node.textContent.trim();
          // Only add if it's not just whitespace and doesn't seem to be a handle/username
          if (nodeText && !nodeText.match(/^[@#]/)) {
            textNodes.push(nodeText);
          }
        }
      }
      const channelName = textNodes.join("").trim();
      if (channelName) {
        //logDebug('YouTube Video Blocker: Found channel name (attributed string):', channelName);
        return channelName;
      }
    }

    // Try the link format (Home page)
    const linkChannelElement = videoElement.querySelector("a.yt-core-attributed-string__link");

    if (linkChannelElement) {
      const channelName = linkChannelElement.textContent.trim();
      if (channelName) {
        logDebug("YouTube Video Blocker: Found channel name (link text):", channelName);
        return channelName;
      }
    }

    // Fallback selectors for other layouts
    const fallbackSelectors = [
      ".ytd-channel-name yt-formatted-string",
      "#channel-name yt-formatted-string",
      ".ytd-video-meta-block #channel-name yt-formatted-string",
      "yt-formatted-string.ytd-channel-name"
    ];

    for (const selector of fallbackSelectors) {
      const element = videoElement.querySelector(selector);
      if (element) {
        const channelName = element.textContent.trim();
        if (channelName) {
          logDebug("YouTube Video Blocker: Found channel name (fallback):", channelName);
          return channelName;
        }
      }
    }

    //logDebug("YouTube Video Blocker: No channel name found for video", videoElement);
    return null;
  }

  setupMessageListener() {
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === "toggleExtension") {
        this.extensionEnabled = message.enabled !== false;
        logDebug("YouTube Video Blocker: Received toggle message, enabled:", this.extensionEnabled);
        if (!this.extensionEnabled) {
          this.unblockAllVideos();
          this.stop();
        } else {
          this.startBlocking();
          this.processAllVideos();
        }
      } else if (message.action === "blockVideo" && message.url) {
        logDebug("YouTube Video Blocker: Received blockVideo message for URL:", message.url);
        const videoIdMatch = message.url.match(/v=([a-zA-Z0-9_-]{11})/);
        if (!videoIdMatch) {
          console.warn("YouTube Video Blocker: Invalid video ID in URL:", message.url);
          sendResponse({ success: false, error: "Invalid video ID" });
          return;
        }

        const videoId = videoIdMatch[1];

        // Always try to hide it visually, even if already in list
        const wasAlreadyBlocked = this.blockedVideoIds.some((entry) => entry.id === videoId);

        // Find and hide immediately, get title
        const foundTitle = this.forceHideVideoById(videoId);

        if (!wasAlreadyBlocked) {
          const title = foundTitle || "Unknown Title";
          this.blockedVideoIds.push({ id: videoId, title });
          browser.storage.sync.set(
            {
              blockedVideoIds: this.blockedVideoIds,
              lastUpdateInstance: this.instanceId
            },
            () => {
              logDebug("YouTube Video Blocker: Blocked video:", { id: videoId, title });
              sendResponse({ success: true, id: videoId, title });
            }
          );
          return true;
        } else {
          logDebug("YouTube Video Blocker: Video ID already blocked:", videoId);
          sendResponse({ success: true, id: videoId, alreadyBlocked: true });
          return true;
        }
      } else if (message.action === "blockChannel" && message.channelName) {
        logDebug("YouTube Video Blocker: Received blockChannel message for channel:", message.channelName);

        if (this.blockedChannelNames.includes(message.channelName)) {
          logDebug("YouTube Video Blocker: Channel already blocked:", message.channelName);
          sendResponse({
            success: false,
            error: "Channel already blocked"
          });
          return;
        }

        this.blockedChannelNames.push(message.channelName);
        browser.storage.sync.set(
          {
            blockedChannelNames: this.blockedChannelNames,
            lastUpdateInstance: this.instanceId
          },
          () => {
            logDebug("YouTube Video Blocker: Blocked channel:", message.channelName);

            // Force re-process so existing videos from this channel get hidden
            document
              .querySelectorAll('[data-blocker-processed="checked"]')
              .forEach((el) => delete el.dataset.blockerProcessed);
            this.processAllVideos();

            sendResponse({ success: true, channelName: message.channelName });
          }
        );

        return true;
      } else if (message.action === "getChannelNameFromPage") {
        logDebug("YouTube Video Blocker: Getting channel name from current page");

        // Ensure the response even if channel name was not found
        try {
          // Try multiple selectors for channel name on channel pages
          const channelNameSelectors = [
            // New YouTube layout - the exact structure from your HTML
            "yt-dynamic-text-view-model h1 .yt-core-attributed-string",
            'yt-dynamic-text-view-model .yt-core-attributed-string[role="text"]',
            ".yt-page-header-view-model__page-header-title h1 .yt-core-attributed-string",
            ".yt-page-header-view-model__page-header-title .yt-core-attributed-string",
            // Additional fallbacks
            "yt-dynamic-text-view-model h1 span",
            'yt-dynamic-text-view-model span[role="text"]',
            "#channel-name .ytd-channel-name",
            "ytd-channel-name #text",
            ".ytd-c4-tabbed-header-renderer #text",
            "h1.ytd-channel-name",
            ".ytd-channel-header-renderer h1"
          ];

          let channelName = null;
          for (const selector of channelNameSelectors) {
            const element = document.querySelector(selector);
            console.log("YouTube Video Blocker: Trying selector:", selector, "Element found:", !!element);

            if (element) {
              console.log("YouTube Video Blocker: Element HTML:", element.outerHTML.substring(0, 200) + "...");
              let textContent = "";

              // Special handling for yt-core-attributed-string elements
              if (element.classList.contains("yt-core-attributed-string")) {
                // First try: Get direct text content, filtering out icon elements
                const clonedElement = element.cloneNode(true);
                // Remove icon elements from the clone
                const icons = clonedElement.querySelectorAll('.ytIconWrapperHost, .yt-icon-shape, svg, [role="img"]');
                icons.forEach((icon) => icon.remove());

                textContent = clonedElement.textContent.trim();
                console.log("YouTube Video Blocker: Clone method extracted:", textContent);

                // If that didn't work, try TreeWalker with less aggressive filtering
                if (!textContent) {
                  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                    acceptNode: function (node) {
                      // Only reject if the immediate parent is an icon
                      const parent = node.parentElement;
                      if (
                        parent &&
                        (parent.classList.contains("ytIconWrapperHost") ||
                          parent.classList.contains("yt-icon-shape") ||
                          parent.tagName === "svg")
                      ) {
                        return NodeFilter.FILTER_REJECT;
                      }
                      return NodeFilter.FILTER_ACCEPT;
                    }
                  });

                  let textNode;
                  while ((textNode = walker.nextNode())) {
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
                    } else if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector("svg, yt-icon")) {
                      const text = node.textContent.trim();
                      if (text) textContent += text;
                    }
                  }
                } else {
                  textContent = element.textContent.trim();
                }
              }

              console.log("YouTube Video Blocker: Extracted text:", textContent);

              if (textContent) {
                channelName = textContent;
                console.log("YouTube Video Blocker: Found channel name with selector:", selector, channelName);
                break;
              }
            }
          }

          console.log("YouTube Video Blocker: Found channel name on page:", channelName);

          // Always send a response, even if channelName is null
          sendResponse({
            success: channelName !== null,
            channelName: channelName
          });
        } catch (error) {
          console.log("YouTube Video Blocker: Error extracting channel name:", error);
          sendResponse({
            success: false,
            channelName: null,
            error: error.message
          });
        }

        return true; // Keep message channel open
      } else if (message.action === "getChannelNameFromLink" && message.url) {
        logDebug("YouTube Video Blocker: Received getChannelNameFromLink message for URL:", message.url);

        // Extract channel handle from URL (e.g., @mndiaye_97)
        const channelHandleMatch = message.url.match(/@([^/?]+)/);
        if (!channelHandleMatch) {
          logDebug("YouTube Video Blocker: No channel handle found in URL");
          sendResponse({ channelName: null });
          return true;
        }

        const channelHandle = "@" + channelHandleMatch[1];
        logDebug("YouTube Video Blocker: Looking for channel handle:", channelHandle);

        // Try multiple approaches to find the link and extract channel name
        const linkSelectors = [
          `a[href*="${channelHandle}"]`,
          `a[href*="/@${channelHandleMatch[1]}"]`,
          `a[href="${message.url}"]`,
          `a[href^="${message.url.split("?")[0]}"]`
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
            let extractedName = "";

            // First try: Get text from the link itself
            if (linkElement.textContent.trim() && !linkElement.textContent.trim().startsWith("@")) {
              // Filter out verification icons and other non-text content
              const textNodes = [];
              for (let node of linkElement.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                  const text = node.textContent.trim();
                  if (text) textNodes.push(text);
                } else if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector("svg, yt-icon")) {
                  const text = node.textContent.trim();
                  if (text && !text.match(/^[@#]/)) textNodes.push(text);
                }
              }
              extractedName = textNodes.join(" ").trim();
            }

            // Second try: Look for channel name in parent container
            if (!extractedName) {
              const videoContainer = linkElement.closest(
                "yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer"
              );
              if (videoContainer) {
                extractedName = this.extractChannelName(videoContainer);
              }
            }

            if (extractedName) {
              channelName = extractedName;
              logDebug("YouTube Video Blocker: Extracted channel name from link:", channelName);
              break;
            }
          }

          if (channelName) break;
        }

        logDebug("YouTube Video Blocker: Final channel name result:", channelName);
        sendResponse({ channelName: channelName });
        return true;
      } else if (message.action === "unblockChannel" && message.channelName) {
        logDebug("YouTube Video Blocker: Received unblockChannel message for channel:", message.channelName);

        const channelIndex = this.blockedChannelNames.indexOf(message.channelName);
        if (channelIndex === -1) {
          logDebug("YouTube Video Blocker: Channel not in blocked list:", message.channelName);
          sendResponse({
            success: false,
            error: "Channel not blocked"
          });
          return;
        }

        this.blockedChannelNames.splice(channelIndex, 1);
        browser.storage.sync.set(
          {
            blockedChannelNames: this.blockedChannelNames,
            lastUpdateInstance: this.instanceId
          },
          () => {
            logDebug("YouTube Video Blocker: Unblocked channel:", message.channelName);
            // Process immediately to unblock videos from this channel
            this.processAllVideos({ force: true });
            sendResponse({
              success: true,
              channelName: message.channelName
            });
          }
        );

        // Keep message channel open for async storage
        return true;
      } else if (message.action === "getChannelNameFromVideoLink" && message.url) {
        logDebug("YouTube Video Blocker: Received getChannelNameFromVideoLink message for URL:", message.url);

        // Extract video ID from URL
        const videoIdMatch = message.url.match(/v=([a-zA-Z0-9_-]{11})|\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (!videoIdMatch) {
          logDebug("YouTube Video Blocker: No video ID found in URL");
          sendResponse({ channelName: null });
          return true;
        }

        const videoId = videoIdMatch[1] || videoIdMatch[2];
        logDebug("YouTube Video Blocker: Looking for video ID:", videoId);

        // Find the video element with this ID
        const linkSelectors = [`a[href*="/watch?v=${videoId}"]`, `a[href*="/shorts/${videoId}"]`];

        let channelName = null;
        for (const selector of linkSelectors) {
          const linkElements = document.querySelectorAll(selector);

          for (const linkElement of linkElements) {
            // Find the video container
            const videoContainer = linkElement.closest(
              "yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer"
            );
            if (videoContainer) {
              channelName = this.extractChannelName(videoContainer);
              if (channelName) {
                logDebug("YouTube Video Blocker: Extracted channel name from video:", channelName);
                break;
              }
            }
          }

          if (channelName) break;
        }

        logDebug("YouTube Video Blocker: Final channel name result for video:", channelName);
        sendResponse({ channelName: channelName });
        return true;
      }
    });
  }

  startBlocking() {
    if (!this.extensionEnabled) return;
    logDebug("YouTube Video Blocker: Starting with", this.rules.length, "rules, enabled:", this.extensionEnabled);

    const startObserving = () => {
      if (this.removeShorts || this.removeIrrelevantElements) {
        this.startElementsRemoval();
      }

      // Start video blocking
      this.startVideoBlocking();

      if (!this.showPlaceholders) {
        const style = document.createElement("style");
        style.id = "youtube-video-blocker-temp";
        style.textContent = `
          [data-blocker-processed="blocked"] {
            display: none !important;
          }
        `;
        document.head.appendChild(style);
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObserving);
    } else {
      startObserving();
    }

    logDebug("Setup ParentObserver");
    this.setupParentObserver();
  }

  setupParentObserver() {
    // Set up parent observer to detect container replacements
    this.parentObserver = new MutationObserver(
      debounce((mutations) => {
        if (!this.extensionEnabled) return;
        let containerChanged = false;
        mutations.forEach((mutation) => {
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (
                node.nodeType === 1 &&
                // Watch page containers with video content
                ((node.matches("#related, ytd-watch-next-secondary-results-renderer") &&
                  node.querySelector(
                    "yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer"
                  )) ||
                  // Home page containers with video content
                  (node.matches("#contents, ytd-rich-grid-renderer") &&
                    node.querySelector(
                      "yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer"
                    )) ||
                  // Subscription page containers with video content
                  (node.matches("ytd-section-list-renderer, ytd-item-section-renderer") &&
                    node.querySelector(
                      "yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer"
                    )))
              ) {
                containerChanged = true;
                break;
              }
            }
          }
        });

        if (containerChanged) {
          logDebug("YouTube Video Blocker: Detected container change, re-attaching observer");
          this.processAllVideos();
          // Re-run element removal so ytd-rich-section-renderer sections that
          // couldn't be identified before videos loaded are caught now.
          if (this.removeShorts || this.removeIrrelevantElements) {
            this.removeElements();
          }
        }
      }, 1000)
    );

    // Start observing parent for container changes
    this.parentObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  startPendingObserver(videoElement) {
    if (this.pendingObservers.has(videoElement)) return;

    const debouncedCheck = debounce(() => {
      if (!videoElement.isConnected) {
        this.disconnectPendingObserver(videoElement);
        return;
      }
      if (["checked", "blocked"].includes(videoElement.dataset?.blockerProcessed)) {
        this.disconnectPendingObserver(videoElement);
        return;
      }
      this.checkAndBlockVideo(videoElement);
    }, 300);

    const observer = new MutationObserver(debouncedCheck);

    observer.observe(videoElement, {
      childList: true,
      subtree: true
    });

    this.pendingObservers.set(videoElement, observer);

    // Safety timeout
    const timeoutId = setTimeout(() => {
      this.disconnectPendingObserver(videoElement);
    }, OBSERVER_LIFETIME);

    videoElement._pendingTimeout = timeoutId;
  }

  disconnectPendingObserver(videoElement) {
    const observer = this.pendingObservers.get(videoElement);
    if (observer) {
      observer.disconnect();
      this.pendingObservers.delete(videoElement);
    }
    if (videoElement._pendingTimeout) {
      clearTimeout(videoElement._pendingTimeout);
      delete videoElement._pendingTimeout;
    }
  }

  async checkAndBlockVideo(videoElement) {
    // Skip if already finally decided
    if (["checked", "blocked"].includes(videoElement.dataset?.blockerProcessed)) {
      return;
    }

    // Extract videoId
    const linkElement = videoElement.querySelector(
      'a[href*="/watch?v="], a[href*="/shorts/"], ' + '.yt-lockup-view-model__content-image[href*="/watch?v="]'
    );
    let videoId = null;
    if (linkElement) {
      const href = linkElement.getAttribute("href");
      const videoIdMatch = href.match(/v=([a-zA-Z0-9_-]{11})|\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (videoIdMatch) {
        videoId = videoIdMatch[1] || videoIdMatch[2];
        logDebug("YouTube Video Blocker: Extracted videoID:", videoId);
      }
    } else {
      //logDebug("YouTube Video Blocker: No link element found for video", videoElement);
    }

    // Mark as checked if the user manually unblocked the video via "Show anyway" button
    if (videoId && this.unblockedVideoIds.has(videoId)) {
      logDebug("YouTube Video Blocker: Skipping unblocked video ID:", videoId);
      videoElement.dataset.blockerProcessed = "checked";
      return;
    }

    // Block by video ID
    if (videoId && this.blockedVideoIds.some((entry) => entry.id === videoId)) {
      logDebug(`YouTube Video Blocker: Blocking by video ID early: ${videoId}`);
      if (!this.showPlaceholders) {
        this.hideVideoElement(videoElement);
      } else {
        const title =
          videoElement.querySelector(YouTubeVideoBlocker.TITLE_SELECTOR)?.textContent?.trim() || "Blocked Video";
        this.blockVideoWithPlaceholder(videoElement, title, "video");
      }
      videoElement.dataset.blockerProcessed = "blocked";
      this.disconnectPendingObserver(videoElement);
      return;
    }

    // Extract channel name
    const channelName = this.extractChannelName(videoElement);

    // Block by channel name
    if (channelName) {
      logDebug("YouTube Video Blocker: Extracted channel name:", channelName);
      if (this.blockedChannelNames.some((b) => b.toLowerCase() === channelName.toLowerCase())) {
        logDebug(`YouTube Video Blocker: Blocking by channel: ${channelName}`);
        if (!this.showPlaceholders) {
          this.hideVideoElement(videoElement);
        } else {
          this.blockVideoWithPlaceholder(videoElement, channelName, "channel");
        }
        videoElement.dataset.blockerProcessed = "blocked";
        this.disconnectPendingObserver(videoElement);
        return;
      }
    }

    const titleElement = videoElement.querySelector(YouTubeVideoBlocker.TITLE_SELECTOR);

    if (!titleElement) {
      videoElement.dataset.blockerProcessed = "pending";
      this.startPendingObserver(videoElement);
      //logDebug("YouTube Video Blocker: Title element not found for video", videoElement);
      return;
    }

    const title = titleElement.textContent.trim();

    if (!title) {
      //logDebug("YouTube Video Blocker: Title not found for video", videoElement);
      this.startPendingObserver(videoElement);
      videoElement.dataset.blockerProcessed = "pending";
      return;
    }

    let shouldBlock = false;

    // Blocking clickbait / vague titles check
    if (this.blockClickbaitVaguetitles) {
      const cacheKey = title;

      // Check cache first by title
      if (this.clickbaitTitleCache.has(cacheKey)) {
        const cached = this.clickbaitTitleCache.get(cacheKey);
        if (cached.blocked) {
          shouldBlock = true;
        }
      } else {
        // If not in cache, send the request
        const result = await analyzeYTTitle(title);
        this.clickbaitTitleCache.set(cacheKey, result);
        if (result.blocked) {
          shouldBlock = true;
        }
      }
    }

    if (!shouldBlock) {
      shouldBlock =
        this.rules.some((rule) => {
          const trimmedRule = rule.trim();
          return trimmedRule && title.toLowerCase().includes(trimmedRule.toLowerCase());
        }) ||
        (videoId && this.blockedVideoIds.some((entry) => entry.id === videoId)) ||
        (channelName &&
          this.blockedChannelNames.some(
            (blockedChannel) => blockedChannel.toLowerCase() === channelName.toLowerCase()
          ));
    }

    if (shouldBlock) {
      logDebug(
        `YouTube Video Blocker: Blocking video with title: "${title}"${videoId ? `, ID: ${videoId}` : ""}${channelName ? `, Channel: ${channelName}` : ""}`
      );
      if (!this.showPlaceholders) {
        this.hideVideoElement(videoElement);
        this.incrementBlockedCount();
      } else {
        this.blockVideoWithPlaceholder(videoElement, title, "clickbait");
      }
      videoElement.dataset.blockerProcessed = "blocked";
    } else {
      videoElement.dataset.blockerProcessed = "checked";
    }
  }

  blockVideoWithPlaceholder(videoElement, title, blockReason = "video") {
    const originalParent = videoElement.parentNode;
    const originalNextSibling = videoElement.nextSibling;

    // Extract video ID before processing changes the DOM structure
    const videoId = this.extractVideoId(videoElement);

    // Get the computed dimensions and styles before removing the element
    const computedStyle = window.getComputedStyle(videoElement);
    const elementRect = videoElement.getBoundingClientRect();

    // Determine if this is a grid layout by checking parent classes or styles
    const isGridLayout =
      videoElement.closest("ytd-rich-grid-renderer") ||
      videoElement.closest('[class*="grid"]') ||
      computedStyle.display === "flex" ||
      computedStyle.display === "inline-block";
    // Create blocked video placeholder
    const blockedDiv = document.createElement("div");
    blockedDiv.className = "youtube-video-blocked";

    // Base styles
    let placeholderStyles = `
      padding: 16px;
      margin: ${computedStyle.margin};
      background: ${this.theme === "dark" ? "#2a2a2a" : "#f0f0f0"};
      border: 2px dashed ${this.theme === "dark" ? "#555" : "#ccc"};
      border-radius: 8px;
      text-align: center;
      color: ${this.theme === "dark" ? "#ccc" : "#666"};
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
      // Apply full card height only in the Home/Subscriptions rich grid
      const isRichGrid = !!videoElement.closest("ytd-rich-grid-renderer");
      if (isRichGrid && elementRect.height > 0) {
        placeholderStyles += `
          min-height: ${elementRect.height}px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
        `;
      }
    } else {
      // For list layouts, use full width
      placeholderStyles += `
		  width: 100%;
		`;
    }

    blockedDiv.style.cssText = placeholderStyles;

    // Default font sizes (used on Recommendations and all non-grid pages)
    let channelFontSize = "11px";
    let titleFontSize = "12px";
    let buttonFontSize = "11px";
    // On Home/Subscriptions grid, sample sizes from a sibling video card instead
    if (videoElement.closest("ytd-rich-grid-renderer")) {
      const sibling = originalParent?.querySelector(
        "yt-lockup-view-model, ytd-video-renderer, ytd-compact-video-renderer"
      );
      if (sibling) {
        const channelEl = sibling.querySelector(
          ".yt-content-metadata-view-model__metadata-text, a.yt-core-attributed-string__link, " +
            ".ytd-channel-name yt-formatted-string"
        );
        const titleEl = sibling.querySelector(YouTubeVideoBlocker.TITLE_SELECTOR);
        if (channelEl) channelFontSize = window.getComputedStyle(channelEl).fontSize || channelFontSize;
        if (titleEl) {
          const s = window.getComputedStyle(titleEl).fontSize;
          if (s) {
            titleFontSize = parseInt(s) - 1 + "px";
            buttonFontSize = parseInt(s) - 2 + "px";
          }
        }
      }
    }

    // Create container for blocked message
    const messageDiv = document.createElement("div");
    messageDiv.style.fontWeight = "500";
    messageDiv.style.fontSize = channelFontSize;
    messageDiv.style.marginBottom = "4px";

    if (blockReason === "channel") {
      messageDiv.textContent = "🚫 Channel Blocked";
      messageDiv.style.color = "#FFA014";
    } else if (blockReason === "clickbait") {
      messageDiv.textContent = "🚫 Blocked: Clickbait / Vague Title";
      messageDiv.style.color = "#ff6b6b";
    } else {
      messageDiv.textContent = "🚫 Video Blocked";
    }

    // Create title/channel div
    const titleDiv = document.createElement("div");
    titleDiv.style.fontSize = titleFontSize;
    titleDiv.style.opacity = "0.7";
    titleDiv.style.wordBreak = "break-word";
    titleDiv.style.lineHeight = "1.3";

    if (blockReason === "channel") {
      titleDiv.textContent = `Channel: "${title}"`;
    } else {
      titleDiv.textContent = `Title: "${title}"`;
    }

    // Create unblock button
    const unblockButton = document.createElement("button");
    unblockButton.className = "unblock-btn";
    unblockButton.style.marginTop = "8px";
    unblockButton.style.padding = "4px 8px";
    unblockButton.style.background = "transparent";
    unblockButton.style.border = "1px solid currentColor";
    unblockButton.style.borderRadius = "4px";
    unblockButton.style.color = "inherit";
    unblockButton.style.cursor = "pointer";
    unblockButton.style.fontSize = buttonFontSize;
    unblockButton.textContent = "Show anyway";

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
    const unblockBtn = blockedDiv.querySelector(".unblock-btn");
    const self = this; // Capture reference to YouTubeVideoBlocker instance

    unblockBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const originalVideo = blockedDiv._originalVideo;
      const parent = blockedDiv._originalParent;
      const nextSibling = blockedDiv._originalNextSibling;
      const videoId = blockedDiv._videoId; // Use stored video ID

      logDebug("YouTube Video Blocker: Button clicked, starting restoration");
      logDebug("YouTube Video Blocker: Original video:", originalVideo);
      logDebug("YouTube Video Blocker: Parent:", parent, "Is connected:", parent?.isConnected);
      logDebug("YouTube Video Blocker: Next sibling:", nextSibling, "Is connected:", nextSibling?.isConnected);
      logDebug("YouTube Video Blocker: Using stored video ID for unblocking:", videoId);

      if (videoId) {
        self.unblockedVideoIds.add(videoId);
        logDebug("YouTube Video Blocker: Added to unblocked list:", videoId);
        logDebug("YouTube Video Blocker: Updated unblocked list:", Array.from(this.unblockedVideoIds));
      }

      // Reset video element state before restoration
      originalVideo.dataset.blockerProcessed = "checked";
      originalVideo.style.display = "";
      originalVideo.style.visibility = "";
      originalVideo.style.opacity = "";
      originalVideo.hidden = false;

      // Get the placeholder's position for proper insertion
      const placeholderParent = blockedDiv.parentNode;
      const placeholderNextSibling = blockedDiv.nextSibling;

      // Remove placeholder
      blockedDiv.remove();
      logDebug("YouTube Video Blocker: Placeholder removed");

      // Restore video to the exact position where the placeholder was
      if (placeholderParent && placeholderParent.isConnected) {
        if (placeholderNextSibling) {
          placeholderParent.insertBefore(originalVideo, placeholderNextSibling);
          logDebug("YouTube Video Blocker: Inserted before placeholder next sibling");
        } else {
          placeholderParent.appendChild(originalVideo);
          logDebug("YouTube Video Blocker: Appended to placeholder parent");
        }
      } else {
        // Fallback to original parent if placeholder parent is invalid
        if (parent && parent.isConnected) {
          if (nextSibling && nextSibling.parentNode === parent) {
            parent.insertBefore(originalVideo, nextSibling);
            logDebug("YouTube Video Blocker: Inserted before original next sibling");
          } else {
            parent.appendChild(originalVideo);
            logDebug("YouTube Video Blocker: Appended to original parent");
          }
        } else {
          // Last resort fallback
          const fallbackParent = document.querySelector("#related, ytd-watch-next-secondary-results-renderer, #items");
          if (fallbackParent) {
            fallbackParent.appendChild(originalVideo);
            logDebug("YouTube Video Blocker: Appended to fallback parent:", fallbackParent);
          } else {
            logDebug("YouTube Video Blocker: No valid parent found");
            return;
          }
        }
      }
      logDebug("YouTube Video Blocker: Video restored. Visible:", originalVideo.offsetParent !== null);
      logDebug("YouTube Video Blocker: Video parent after restoration:", originalVideo.parentNode);
      logDebug("YouTube Video Blocker: Video display style:", originalVideo.style.display);
      logDebug("YouTube Video Blocker: Video manually unblocked:", title);
    });

    // Remove video element and insert placeholder
    videoElement.remove();
    if (originalParent && originalParent.isConnected) {
      originalParent.insertBefore(blockedDiv, originalNextSibling);
    } else {
      const fallbackParent =
        document.querySelector("#related, ytd-watch-next-secondary-results-renderer") || document.body;
      fallbackParent.appendChild(blockedDiv);
      logDebug(
        "YouTube Video Blocker: Parent node disconnected, inserted placeholder to fallback parent:",
        fallbackParent
      );
    }

    browser.storage.sync.get(["blockedVideosCount"], (result) => {
      const count = (result.blockedVideosCount || 0) + 1;
      browser.storage.sync.set({
        blockedVideosCount: count
      });
    });
  }

  incrementBlockedCount() {
    browser.storage.sync.get(["blockedVideosCount"], (result) => {
      const count = (result.blockedVideosCount || 0) + 1;
      browser.storage.sync.set({ blockedVideosCount: count });
    });
  }

  // Shorts and irrelevant elements cleanup
  startElementsRemoval() {
    if (!this.extensionEnabled) return;
    logDebug("YouTube Video Blocker: Starting Shorts and irrelevant elements cleanup");

    // Remove existing Shorts and irrelevant sections immediately
    this.removeElements();

    // Set up observer for Shorts and irrelevant elements cleanup
    this.shortsObserver = new MutationObserver((mutations) => {
      if (!this.extensionEnabled || (!this.removeShorts && !this.removeIrrelevantElements)) return;

      let foundElements = false;
      const parentsToRecheck = new Set();
      mutations.forEach((mutation) => {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
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
                elements.forEach((el) => this.removeShortsElement(el));
              }
              // When a video item is added to the grid, re-check sibling
              // ytd-rich-section-renderer elements that were skipped earlier
              // because no videos existed in the parent yet.
              if (this.removeIrrelevantElements && node.matches("ytd-rich-item-renderer") && node.parentElement) {
                parentsToRecheck.add(node.parentElement);
              }
            }
          });
        }
      });
      parentsToRecheck.forEach((parent) => {
        parent.querySelectorAll("ytd-rich-section-renderer").forEach((section) => {
          if (!section.dataset.blockerShortRemoved && this.isShowMoreSection(section)) {
            logDebug("YouTube Video Blocker: Removing Show more/less section (deferred, sibling videos now present)");
            this.removeShortsElement(section);
            foundElements = true;
          }
        });
      });

      if (foundElements) {
        logDebug("YouTube Video Blocker: Removed Shorts or irrelevant search elements");
      }
    });

    // Observe the entire document
    this.shortsObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    logDebug("YouTube Video Blocker: Element observer started");
  }

  stopElementsRemoval() {
    if (this.shortsObserver) {
      this.shortsObserver.disconnect();
      this.shortsObserver = null;
      logDebug("YouTube Video Blocker: Stopped Shorts and irrelevant elements cleanup");
    }
  }

  startVideoBlocking() {
    if (!this.extensionEnabled) return;
    logDebug("YouTube Video Blocker: Starting video blocking");

    // Remove existing videos immediately
    this.processAllVideos();

    // Set up observer for video blocking
    this.videoObserver = new MutationObserver((mutations) => {
      if (!this.extensionEnabled) return;

      let foundVideos = false;
      mutations.forEach((mutation) => {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
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
                videoElements.forEach((el) => this.checkAndBlockVideo(el));
              }
            }
          });
        }
      });

      if (foundVideos) {
        logDebug("YouTube Video Blocker: Processed new video elements from mutations");
      }
    });

    // Observe the entire document for videos
    this.videoObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  processAllVideos() {
    if (!this.extensionEnabled) return;

    logDebug("YouTube Video Blocker: Processing all existing videos");

    const videoElements = this.findVideoElements(document);
    videoElements.forEach((element) => {
      this.checkAndBlockVideo(element);
    });
  }

  isVideoElement(element) {
    if (!element.matches) return false;
    if (this.isShortsOrIrrelevantElement(element)) return false;

    // Always target yt-lockup-view-model — present on all modern pages.
    // Outer wrappers (ytd-rich-item-renderer etc.) contain it as a descendant
    // and are excluded to avoid double-processing the same video.
    if (element.matches("yt-lockup-view-model")) return true;

    // Fallback for older layouts that don't use yt-lockup-view-model
    if (
      element.matches("ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer") &&
      !element.querySelector("yt-lockup-view-model")
    )
      return true;

    return false;
  }

  findVideoElements(container) {
    // Primary: yt-lockup-view-model is the consistent inner video element on all
    // modern YouTube pages (Home, Subscriptions, Search, Watch, Recommendations).
    const primary = Array.from(container.querySelectorAll("yt-lockup-view-model"));

    // Fallback: older-layout elements only when they don't contain a lockup inside,
    // so the same video is never double-processed via both outer and inner selectors.
    const fallback = Array.from(
      container.querySelectorAll("ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer")
    ).filter((el) => !el.querySelector("yt-lockup-view-model"));

    return [...primary, ...fallback].filter((el) => !this.isShortsOrIrrelevantElement(el));
  }

  // Hides a video element and its outer ytd-rich-item-renderer grid wrapper (if any)
  // so the grid reflows correctly when placeholders are disabled.
  hideVideoElement(videoElement) {
    videoElement.style.setProperty("display", "none", "important");
    videoElement.offsetHeight; // force reflow
    const gridWrapper = videoElement.closest("ytd-rich-item-renderer");
    if (gridWrapper) {
      gridWrapper.style.setProperty("display", "none", "important");
    }
  }

  // Returns true if this ytd-rich-section-renderer is a removable "Show more/less"
  // shelf. Identify it negatively: keep any section that contains a chip/filter
  // bar (Latest/All switcher on Subscriptions) or a title header. Remove the rest
  // that appear after video items are present in the grid.
  isShowMoreSection(element) {
    // Never remove sections that contain a shelf (e.g. Latest/All switcher on Subscriptions)
    if (element.querySelector("ytd-shelf-renderer")) return false;

    const parent = element.parentElement;
    if (!parent) return false;
    // ytd-rich-item-renderer may have been replaced by .youtube-video-blocked
    // placeholders if videos were blocked, so check for both.
    return !!(parent.querySelector("ytd-rich-item-renderer") || parent.querySelector(".youtube-video-blocked"));
  }

  // Method to detect Shorts within ytd-video-renderer
  isVideoRendererShorts(videoElement) {
    // Check for Shorts thumbnail link
    if (videoElement.querySelector('a[href*="/shorts/"]')) {
      return true;
    }

    // Check for Shorts overlay indicator
    const timeOverlay = videoElement.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer[overlay-style="SHORTS"]'
    );
    if (timeOverlay) {
      return true;
    }

    // Check for hide-time-status attribute (often used with Shorts)
    const hideTimeStatus = videoElement.querySelector("ytd-thumbnail-overlay-time-status-renderer[hide-time-status]");
    if (
      hideTimeStatus &&
      hideTimeStatus.hasAttribute("overlay-style") &&
      hideTimeStatus.getAttribute("overlay-style") === "SHORTS"
    ) {
      return true;
    }

    return false;
  }

  isShortsOrIrrelevantElement(element) {
    if (!element.matches) {
      logDebug("YouTube Video Blocker: Element lacks matches method:", element);
      return false;
    }

    // Remove "Show more/less" expandable shelves — identified by having video items
    // already present in the same parent container
    if (
      this.removeIrrelevantElements &&
      element.matches("ytd-rich-section-renderer") &&
      this.isShowMoreSection(element)
    ) {
      logDebug("YouTube Video Blocker: Removing Show more/less rich section");
      return true;
    }

    // Prevent re-processing already removed Shorts
    if (element.dataset?.blockerShortRemoved === "true") {
      return false;
    }

    // Avoid matching large page containers
    if (element.matches("ytd-search, ytd-page-manager, body, html")) {
      logDebug("YouTube Video Blocker: Skipping large container:", element.tagName);
      return false;
    }

    // Check for Shorts elements
    const isShorts =
      // Sidebar Shorts link (specific guide entry)
      (element.matches("ytd-guide-entry-renderer") &&
        element.querySelector("yt-formatted-string") &&
        element.querySelector("yt-formatted-string").textContent.trim() === "Shorts") ||
      // Mini guide Shorts link
      (element.matches("ytd-mini-guide-entry-renderer") &&
        (element.getAttribute("aria-label") === "Shorts" || element.querySelector('a[title="Shorts"]'))) ||
      // Shorts shelves on Home/Subscriptions pages
      (element.matches("ytd-rich-section-renderer") &&
        element.querySelector(
          'a[href*="/shorts/"], ytd-reel-item-renderer, [data-shorts-shelf], grid-shelf-view-model.ytGridShelfViewModelHost'
        )) ||
      element.matches("grid-shelf-view-model.ytGridShelfViewModelHost") ||
      element.matches("ytd-rich-shelf-renderer[is-shorts-shelf]") ||
      element.matches("ytd-rich-shelf-renderer[is-shorts]") ||
      element.matches("ytd-reel-shelf-renderer") ||
      // Individual Shorts videos
      element.matches("ytd-reel-item-renderer") ||
      element.matches("ytd-video-renderer[is-shorts]") ||
      // Check if ytd-video-renderer or ytd-compact-video-renderer contains Shorts indicators
      ((element.matches("ytd-video-renderer") || element.matches("ytd-compact-video-renderer")) &&
        this.isVideoRendererShorts(element)) ||
      // Shorts sections with specific data attributes
      element.matches("[data-shorts-shelf]") ||
      // Direct Shorts links (not within large containers)
      (element.matches('a[href*="/shorts/"]') && !element.closest("ytd-search, ytd-page-manager"));

    if (this.removeShorts && isShorts) {
      logDebug("YouTube Video Blocker: Identified as Shorts element:", element.tagName, Array.from(element.classList));
      return true;
    }

    // Check for irrelevant sections
    if (
      this.removeIrrelevantElements &&
      (location.href.includes("/results?search_query=") || location.href.match(/^https:\/\/www\.youtube\.com\/?$/))
    ) {
      const isIrrelevant =
        // Horizontal card lists (e.g., "People also search for")
        element.matches("ytd-horizontal-card-list-renderer") ||
        // Shelves with specific titles like "Previously watched", "From related searches", "Channels new to you"
        (element.matches("ytd-shelf-renderer") &&
          element
            .querySelector("#title")
            ?.textContent.match(
              /People also search for|Previously watched|Channels new to you|From related searches/i
            ));
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
      "ytd-rich-section-renderer grid-shelf-view-model.ytGridShelfViewModelHost",
      "ytd-rich-section-renderer ytd-reel-item-renderer",
      "ytd-rich-section-renderer[data-shorts-shelf]",
      "grid-shelf-view-model.ytGridShelfViewModelHost",
      "ytd-rich-shelf-renderer[is-shorts-shelf]",
      "ytd-rich-shelf-renderer[is-shorts]",
      "ytd-rich-section-renderer",
      "ytd-reel-shelf-renderer",
      "ytd-reel-item-renderer",
      "ytd-video-renderer[is-shorts]",
      'ytd-compact-video-renderer a[href*="/shorts/"]',
      "[data-shorts-shelf]",
      // Direct Shorts links (exclude main page containers)
      'a[href*="/shorts/"]:not(ytd-search a):not(ytd-page-manager a)'
    ];

    // Irrelevant section selectors
    if (
      this.removeIrrelevantElements &&
      (location.href.includes("/results?search_query=") || location.href.match(/^https:\/\/www\.youtube\.com\/?$/))
    ) {
      selectors.push(
        "ytd-horizontal-card-list-renderer",
        "ytd-shelf-renderer" // Will filter by title in isShortsOrIrrelevantElement
      );
    }

    let elements = [];
    selectors.forEach((selector) => {
      try {
        const foundElements = container.querySelectorAll(selector);
        if (foundElements.length > 0) {
          logDebug("YouTube Video Blocker: Selector found elements:", selector, foundElements.length);
        }
        elements = elements.concat(Array.from(foundElements));
      } catch (e) {
        logDebug("YouTube Video Blocker: Invalid selector:", selector, e);
      }
    });

    // Special handling for Shorts link in sidebar
    if (this.removeShorts) {
      const guideEntries = container.querySelectorAll("ytd-guide-entry-renderer");
      guideEntries.forEach((entry) => {
        const titleElement = entry.querySelector("yt-formatted-string");
        if (titleElement && titleElement.textContent.trim() === "Shorts") {
          elements.push(entry);
          logDebug("YouTube Video Blocker: Added Shorts guide entry");
        }
      });

      // Check ytd-video-renderer and ytd-compact-video-renderer for Shorts indicators
      const videoRenderers = container.querySelectorAll("ytd-video-renderer, ytd-compact-video-renderer");
      videoRenderers.forEach((video) => {
        if (this.isVideoRendererShorts && this.isVideoRendererShorts(video)) {
          elements.push(video);
          logDebug("YouTube Video Blocker: Added Shorts video renderer");
        }
      });

      // Check ytd-rich-section-renderer for Shorts content
      const richSections = container.querySelectorAll("ytd-rich-section-renderer");
      richSections.forEach((section) => {
        if (
          section.querySelector(
            'a[href*="/shorts/"], ytd-reel-item-renderer, [data-shorts-shelf], grid-shelf-view-model.ytGridShelfViewModelHost'
          )
        ) {
          elements.push(section);
          logDebug("YouTube Video Blocker: Added Shorts rich section");
        }
      });
    }

    // Filter to include only valid Shorts or irrelevant elements
    return elements.filter((el) => this.isShortsOrIrrelevantElement(el));
  }

  // Handle both Shorts and irrelevant sections
  removeShortsElement(element) {
    // Find the appropriate element to remove
    let elementToRemove = element;

    // For Shorts: Sidebar Shorts link
    if (
      this.removeShorts &&
      (element.matches("ytd-guide-entry-renderer") || element.closest("ytd-guide-entry-renderer"))
    ) {
      const guideEntry = element.closest("ytd-guide-entry-renderer") || element;
      const titleElement = guideEntry.querySelector("yt-formatted-string");
      if (titleElement && titleElement.textContent.trim() === "Shorts") {
        elementToRemove = guideEntry;
      } else {
        return;
      }
    }
    // For Shorts: Mini guide (collapsed sidebar)
    else if (
      this.removeShorts &&
      (element.matches("ytd-mini-guide-entry-renderer") || element.closest("ytd-mini-guide-entry-renderer"))
    ) {
      const miniGuideEntry = element.closest("ytd-mini-guide-entry-renderer") || element;
      if (miniGuideEntry.getAttribute("aria-label") === "Shorts" || miniGuideEntry.querySelector('a[title="Shorts"]')) {
        elementToRemove = miniGuideEntry;
      } else {
        return;
      }
    }
    // For Notifications: Handle ytd-notification-renderer
    else if (
      this.removeShorts &&
      (element.matches("ytd-notification-renderer") || element.closest("ytd-notification-renderer"))
    ) {
      const notification = element.closest("ytd-notification-renderer") || element;
      if (notification.querySelector('a[href*="/shorts/"]')) {
        elementToRemove = notification;
      } else {
        return;
      }
    }
    // For Shorts/Irrelevant: Home/Subscriptions page sections
    else if (element.matches("ytd-rich-section-renderer") || element.closest("ytd-rich-section-renderer")) {
      const richSection = element.closest("ytd-rich-section-renderer") || element;
      const isShorts =
        this.removeShorts &&
        richSection.querySelector(
          'a[href*="/shorts/"], ytd-reel-item-renderer, [data-shorts-shelf], grid-shelf-view-model.ytGridShelfViewModelHost'
        );
      const isShowMore = this.removeIrrelevantElements && this.isShowMoreSection(richSection);
      if (isShorts || isShowMore) {
        elementToRemove = richSection;
      } else {
        return;
      }
    }
    // For Shorts: Individual ytd-video-renderer or ytd-compact-video-renderer that contains Shorts
    else if (
      this.removeShorts &&
      (element.matches("ytd-video-renderer") || element.matches("ytd-compact-video-renderer"))
    ) {
      if (this.isVideoRendererShorts && this.isVideoRendererShorts(element)) {
        elementToRemove = element;
      } else {
        return;
      }
    }
    // For Shorts: Shorts shelves
    else if (
      this.removeShorts &&
      (element.matches("grid-shelf-view-model") || element.closest("grid-shelf-view-model"))
    ) {
      elementToRemove = element.closest("grid-shelf-view-model") || element;
    } else if (
      this.removeShorts &&
      (element.matches("ytd-rich-shelf-renderer[is-shorts-shelf]") ||
        element.closest("ytd-rich-shelf-renderer[is-shorts-shelf]"))
    ) {
      elementToRemove = element.closest("y td-rich-shelf-renderer[is-shorts-shelf]") || element;
    } else if (
      this.removeShorts &&
      (element.matches("ytd-reel-shelf-renderer") || element.closest("ytd-reel-shelf-renderer"))
    ) {
      elementToRemove = element.closest("ytd-reel-shelf-renderer") || element;
    }
    // For Shorts: Individual Shorts videos
    else if (
      this.removeShorts &&
      (element.matches("ytd-reel-item-renderer") || element.closest("ytd-reel-item-renderer"))
    ) {
      elementToRemove = element.closest("ytd-reel-item-renderer") || element;
    }
    // For Shorts: Individual Shorts links
    else if (this.removeShorts && element.matches('a[href*="/shorts/"]')) {
      const videoContainer = element.closest("ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model");
      if (videoContainer) {
        elementToRemove = videoContainer;
      } else {
        elementToRemove = element;
      }
    }
    // For irrelevant elements: Horizontal card lists (e.g., "People also search for")
    else if (
      this.removeIrrelevantElements &&
      location.href.includes("/results?search_query=") &&
      element.matches("ytd-horizontal-card-list-renderer")
    ) {
      elementToRemove = element;
    }
    // For irrelevant elements: Shelves with specific titles
    else if (
      this.removeIrrelevantElements &&
      location.href.includes("/results?search_query=") &&
      element.matches("ytd-shelf-renderer")
    ) {
      const titleElement = element.querySelector("#title");
      if (
        titleElement &&
        titleElement.textContent.match(
          /People also search for|Previously watched|Channels new to you|From related searches/i
        )
      ) {
        elementToRemove = element;
      } else {
        return;
      }
    }

    // Don't remove large containers
    else if (element.matches("ytd-search, ytd-page-manager, ytd-guide-section-renderer")) {
      logDebug("YouTube Video Blocker: Skipping removal of large container:", element.tagName);
      return;
    }

    if (elementToRemove && elementToRemove.parentNode && elementToRemove !== document.body) {
      elementToRemove.dataset.blockerShortRemoved = "true";
      logDebug("YouTube Video Blocker: Removing element:", elementToRemove.tagName, elementToRemove.className);
      elementToRemove.remove();
    }
  }

  // Remove Shorts and irrelevant sections
  removeElements() {
    if ((!this.removeShorts && !this.removeIrrelevantElements) || !this.extensionEnabled) return;

    logDebug("YouTube Video Blocker: Removing all existing Shorts and irrelevant search sections");

    // Find and remove all existing Shorts and irrelevant elements
    const elements = this.findShortsAndIrrelevantElements(document);
    if (elements > 0) {
      logDebug("YouTube Video Blocker: Found elements to remove:", elements.length, elements);
    }
    elements.forEach((element) => {
      this.removeShortsElement(element);
    });

    // Also remove Shorts navigation link specifically
    if (this.removeShorts) {
      const shortsNavLinks = document.querySelectorAll(
        'ytd-guide-entry-renderer a[title*="Shorts"], ytd-guide-entry-renderer[title*="Shorts"]'
      );
      shortsNavLinks.forEach((link) => {
        const parentEntry = link.closest("ytd-guide-entry-renderer");
        if (parentEntry) {
          logDebug("YouTube Video Blocker: Removing Shorts nav link");
          parentEntry.remove();
        }
      });
    }
  }

  unblockAllVideos() {
    logDebug("YouTube Video Blocker: Unblocking all videos");

    // Check if placeholders are enabled
    const blockedPlaceholders = document.querySelectorAll(".youtube-video-blocked");
    const hasRemovedVideos =
      document.querySelectorAll(
        'yt-lockup-view-model[data-blocker-processed="blocked"], ytd-video-renderer[data-blocker-processed="blocked"], ytd-compact-video-renderer[data-blocker-processed="blocked"]'
      ).length > 0;

    logDebug("YouTube Video Blocker: Found", blockedPlaceholders.length, "placeholders");
    logDebug("YouTube Video Blocker: Has removed videos:", hasRemovedVideos);

    if (blockedPlaceholders.length > 0) {
      // Restore videos from placeholders (when showPlaceholders is enabled)
      logDebug("YouTube Video Blocker: Restoring videos from placeholders");

      blockedPlaceholders.forEach((blockedDiv) => {
        const originalVideo = blockedDiv._originalVideo;
        if (originalVideo) {
          // Reset video element state
          originalVideo.dataset.blockerProcessed = "checked";
          originalVideo.style.display = "";
          originalVideo.style.visibility = "";
          originalVideo.style.opacity = "";
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
            logDebug("YouTube Video Blocker: Video restored to placeholder position");
          } else {
            // Fallback to a valid container
            const fallbackParent = document.querySelector(
              "#related, ytd-watch-next-secondary-results-renderer, #items"
            );
            if (fallbackParent) {
              fallbackParent.appendChild(originalVideo);
              logDebug("YouTube Video Blocker: Video restored to fallback parent");
            }
          }
        } else {
          logDebug("YouTube Video Blocker: No original video found for placeholder, just removing");
          blockedDiv.remove();
        }
      });
    } else if (!this.showPlaceholders && (this.rules.length > 0 || this.blockedVideoIds.length > 0)) {
      // When placeholders are disabled and there are blocking rules, videos were likely removed
      // The only way to restore them is to refresh the page content
      logDebug(
        "YouTube Video Blocker: Placeholders disabled and blocking rules exist, refreshing page to restore removed videos"
      );
      location.reload();
      return; // Exit early since page is reloading
    }

    // Reset processed markers on any remaining videos
    const videoElements = document.querySelectorAll(
      "yt-lockup-view-model[data-blocker-processed], ytd-video-renderer[data-blocker-processed], ytd-compact-video-renderer[data-blocker-processed]"
    );
    logDebug("YouTube Video Blocker: Resetting", videoElements.length, "processed markers");

    videoElements.forEach((el) => {
      this.disconnectPendingObserver(el);
      if (el.dataset.blockerProcessed === "blocked" || el.dataset.blockerProcessed === "checked") {
        delete el.dataset.blockerProcessed;
        el.style.display = "";
        el.style.visibility = "";
        el.style.opacity = "";
        el.hidden = false;
        logDebug("YouTube Video Blocker: Reset video element");
      }
    });

    // Remove temporary CSS
    const tempStyle = document.getElementById("youtube-video-blocker-temp");
    if (tempStyle) {
      tempStyle.remove();
      logDebug("YouTube Video Blocker: Removed temporary CSS");
    }

    // Clear the unblocked video IDs
    this.unblockedVideoIds.clear();
    logDebug("YouTube Video Blocker: Cleared unblocked video IDs");
  }

  stop() {
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
    const tempStyle = document.getElementById("youtube-video-blocker-temp");
    if (tempStyle) tempStyle.remove();
  }
}

// Initialize the blocker
let videoBlocker;

try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      videoBlocker = new YouTubeVideoBlocker();
    });
  } else {
    videoBlocker = new YouTubeVideoBlocker();
  }
} catch (error) {
  console.error("YouTube Video Blocker: Failed to initialize:", error);
}

let currentUrl = location.href;
new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    if (videoBlocker) {
      // Clear unblocked list on URL change
      videoBlocker.unblockedVideoIds.clear();
      videoBlocker.clickbaitTitleCache.clear();
      logDebug("YouTube Video Blocker: URL changed, cleared unblocked list");

      if (currentUrl.includes("/watch")) {
        logDebug("YouTube Video Blocker: Navigation detected, resetting observer");
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

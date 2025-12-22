//chrome.storage.local.set({
//    DEBUG: true
//}); // DEBUG value on initial load, only for testing

import nlp from './lib/compromise-two.mjs';

let DEBUG = false; // default fallback
let removeShorts = false; // Default fallback for Shorts removal
let removeIrrelevantElements = false; // Default fallback
let blockClickbaitVaguetitles = false; // Default fallback

// Load initial settings
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get(['removeShorts', 'removeIrrelevantElements', 'blockClickbaitVaguetitles']);
		
		const debugResult = await chrome.storage.local.get(['DEBUG']);
		
        removeShorts = result.removeShorts === true || result.removeShorts === false ? result.removeShorts : false;
        removeIrrelevantElements = result.removeIrrelevantElements === true || result.removeIrrelevantElements === false ? result.removeIrrelevantElements : false;
		blockClickbaitVaguetitles = result.blockClickbaitVaguetitles === true || result.blockClickbaitVaguetitles === false ? result.blockClickbaitVaguetitles : false;
        DEBUG = debugResult.DEBUG === true || debugResult.DEBUG === false ? debugResult.DEBUG : false;
        logDebug('YouTube Video Blocker: Loaded settings:', {
            removeShorts,
            removeIrrelevantElements,
			blockClickbaitVaguetitles,
            DEBUG
        });
    } catch (error) {
        console.error('YouTube Video Blocker: Error loading settings:', error);
    }
}

function logDebug(...args) {
    if (DEBUG)
        console.log(...args);
}

// Initialize settings on startup
logDebug('YouTube Video Blocker: Background script initialized');
loadSettings();

if (typeof nlp === 'undefined') {
  console.error("nlp global is not defined");
  throw new Error("nlp is not defined");
} else {
  logDebug('YouTube Video Blocker: "compromise" library loaded');
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
	if (namespace === 'sync' && changes.blockClickbaitVaguetitles) {
        blockClickbaitVaguetitles = changes.blockClickbaitVaguetitles.newValue === true || changes.blockClickbaitVaguetitles.newValue === false ? changes.blockClickbaitVaguetitles.newValue : false;
        logDebug('YouTube Video Blocker: Block clickbait / vague titles changed to:', blockClickbaitVaguetitles);
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

// Listen for messages from content script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);
  
  if (message.action === 'analyzeTitle') {
    const result = analyzeYTTitle(message.title);
    console.log('Background sending result:', result);
    sendResponse(result);
    return true; // keeps the message channel open
  }
});

// YT title analysis function, uses NLP library "compromise".
function analyzeYTTitle(title) {
  let score = 0;
  let reasons = [];
  
  const doc = nlp(title);
  const cleanTitle = title.toLowerCase();

  // Whitelist pattern for "This" - only specific expletive constructions
  const isThisExpletive = doc.match('^this is (how|why|what|where|the)').found;

  // 1. Clickbait/Dramatic Phrases
  const clickbaitPhrases = [
    /just happened/i,
	/makes (me|us) (sad|happy|angry|want|sense)/i,
    /you won'?t believe/i,
    /need to (see|know|watch)/i,
    /something (shocking|crazy|insane|terrifying|exposed|unbelievable)/i,
    /the truth about/i,
    /finally (happened|here|revealed)/i,
    /gone too far/i,
    /is a (disaster|problem)/i,
    /everything is (over|changing)/i,
    /stop (doing|buying) this/i,
    /won't be the same/i,
    /secret to/i,
	/(over|about|figured|for|then|now|but) (this|that|it|what)([.!?\s]|$)/i,

	// Mystery & Curiosity Gaps
	/(what|this) (actually|really) (happened|means)/i,
	/nobody is talking about (this|it)/i,
	/the (real )?reason (why|i|we)/i,
	/it's finally (over|time)/i,
	/watch (this )?before (it's deleted|you buy|you go)/i,

	// Authority & "Secrets"
	/they (don't|won't) want you to know/i,
	/(the|my) (top )?secret/i,
	/(hacks?|tricks?) they don't tell you/i,
	/don't (make this mistake|do this)/i,
	/how i (made|did|got) \d+ in \d+ (days|hours)/i,

	// Hyperbole & Emotional Extremes
	/the (best|worst) (ever|i've seen)/i,
	/this (changed|ruined) my life/i,
	/i (regret|am leaving|am quitting)/i,
	/pure (chaos|perfection|evil)/i,

	// Call to Action / Urgency
	/stop everything/i,
	/you need this/i,
	/do (this|not) immediately/i,
	/last chance/i,
	/wait for the end/i,
	/stay tuned/i
  ];
  
  if (clickbaitPhrases.some(r => r.test(title))) {
    score += 10;
    reasons.push("Clickbait/dramatic phrase");
  }		
  
	// 2. Context-Aware Deictic Detection
	const deictics = doc.match('(this|that|these|those)');

	if (deictics.found) {
	  // A. Check for Relative Pronoun usage (The "Math That Predicts" / "Player That Works")
	  const isConnector = doc.match('#Noun (this|that|these|those)').found;

	  // B. Check for Adverbial usage (The "Go This Hard" / "This Big")
	  const isAdverb = doc.match('(this|that|these|those) #Adjective').found;
	  
	  // C. Check for valid time references like "this year", "this month", "this week"
	  const isTimeReference = doc.match('(this|that) (year|month|week|day|time|morning|evening|night|decade|century)').found;

	  // D. Check for presentational "This is [ProperNoun]" - but exclude single adjectives that are capitalized
	  const properNounAfterThis = doc.match('^this is #ProperNoun').found;
	  const hasMultipleWords = doc.match('^this is #ProperNoun+ .+').found; // More than just "This is X"
	  const isPresentational = properNounAfterThis && (hasMultipleWords || doc.match('^this is #Place').found || doc.match('^this is #Person').found);

	  // E. Check for vague "This/That is [Adjective]" without a clear subject
	  const isVagueAdjective = doc.match('^(this|that) is (#Adverb)* #Adjective').found && !isThisExpletive && !isPresentational;

	  if (!isConnector && !isAdverb && !isTimeReference && !isPresentational) {
		const startsWithThis = doc.match('^this').found;
		const otherVagueStart = doc.match('^(that|these|those)').found;

		const endsWithVague = doc.match('(this|that|these|those) [#Adverb|#Adjective]* [.!?]*$').found;
		const followedByNoun = doc.match('(this|that|these|those) #Noun').found;

		if (followedByNoun) {
		  score += 10;
		  reasons.push("Deictic pointing to undefined noun (This X)");
		} else if (isVagueAdjective) {
		  score += 10;
		  reasons.push("Vague 'This/That is [adjective]' without clear subject");
		} else if ((startsWithThis && !isThisExpletive) || otherVagueStart || endsWithVague){
		  score += 10;
		  reasons.push("Standalone vague deictic reference");
		}
	  }
	}
  
	// 3. Use of "something"
	if (cleanTitle.includes('something')) {
		score += 10; 
		reasons.push("Uses 'something'");
	}

	// 4. Vague Third-Person Start
	// Block only if the entire title starts with vague pronouns, not mid-title sentences
	const titleStartsWithVague = /^(they|he|she|it|this|that|those|these)\b/i.test(title);

	if (titleStartsWithVague) {
	  const isThisStart = /^this\b/i.test(title);
	  
	  // Detect "It's been", "It is", "It has" as valid expletive/dummy subjects
	  const isItExpletive = /^it'?s?\s+(been|has)\b/i.test(title);
	  
	  // Whitelist "It's time" as a valid idiom
	  const isItTime = /^it'?s?\s+time\b/i.test(title);
	  
	  // Check if "This is [ProperNoun]" - valid presentational structure (places/people)
	  const isThisPresentational = isThisStart && (doc.match('^this is #Place').found || doc.match('^this is #Person').found);
	  
	  // Only penalize if it's not a valid structure
	  if (!(isThisStart && isThisExpletive) && !isItExpletive && !isItTime && !isThisPresentational) {
		score += 10;
		reasons.push("Starts with vague third-person pronoun");
	  }
	}

  // 5. Cliffhanger / Trailing Ellipsis
  if (title.endsWith('...') || title.endsWith('..') || title.endsWith('?')) {
    score += 5;
    reasons.push("Trailing ellipsis or question teaser");
  }

  // 6. ALL CAPS Check
  const shoutingWords = title.match(/\b[A-Z]{4,}\b/g) || [];
  if (shoutingWords.length >= 2) {
    score += 10; 
    reasons.push(`Multiple ALL CAPS words (${shoutingWords.length})`);
  } else if (shoutingWords.length === 1 && shoutingWords[0].length > 3) {
    score += 5;
    reasons.push("Single ALL CAPS emphasis");
  }
  // 7. Hidden Target / Curiosity Gap (Trailing Object)
  if (title.match(/(for|about|with|to|at|is|ready for) (him|her|them|it|that|this|these|those)$/i)) {
    score += 10;
    reasons.push("Hidden subject/object at end");
  }
  
  // 8. Anchor Check (Subject Validation)
  const isFirstPerson = doc.match('^(i|we|my|our)').found;
  const hasValue = doc.match('#Value').found; 
  const hasProperNoun = doc.match('#ProperNoun').found;
  
  // Real anchors: Nouns that aren't pronouns or vague placeholders
  const concreteNounMatch = doc.match('#Noun').not('(something|everything|nothing|it|this|that|these|those|things|i|we|my|me|so|much)');
  const hasConcreteNoun = concreteNounMatch.found;

  // Identify "This [Noun]" as a mystery object
  const hasMysteryNounPhrase = doc.match('(this|that|these|those) #Noun$').found;
  
  // Identify "I [Verb] [Mystery Object]"
  const hasVagueObject = doc.match('(this|that|it)( #Adverb| #Adjective)*( [.!?…])*$').found;
  // Check for first-person + vague object anywhere in title
  const firstPersonWithVague = isFirstPerson && doc.match('(this|that|it)').found && !hasConcreteNoun && !hasProperNoun && !hasValue;
  
  // LOGIC: Block if:
  // - No anchor exists at all
  // - OR it's a mystery phrase like "this object" with no other anchors
  // - OR it's 1st person pointing at a mystery object
  const noAnchor = !hasConcreteNoun && !hasValue && !hasProperNoun && !isFirstPerson;
  const vagueMystery = hasMysteryNounPhrase && !hasProperNoun && !hasValue;
  const firstPersonVague = firstPersonWithVague;
  
  if (noAnchor || vagueMystery || firstPersonVague) {					
    score += 10;
    reasons.push("No specific subject/anchor detected");
  }

  return {
    score: score,
    blocked: score >= 10,
    reasons: reasons.join(", ")
  };
}

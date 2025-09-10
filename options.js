// YouTube Video Blocker Options Script

let DEBUG = false; // default fallback

// Load debug setting asynchronously
chrome.storage.local.get(['DEBUG'], (result) => {
  DEBUG = result.DEBUG !== undefined ? result.DEBUG : false;
});

// Optional: Listen for debug setting changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.DEBUG) {
    DEBUG = changes.DEBUG.newValue;
    console.log('Debug mode changed to:', DEBUG);
  }
});

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

// Default sample titles to populate the textarea
const defaultTitles = [
	"Amazing Cat Videos Compilation",
	"SCAMMER Gets EXPOSED!!!",
	"Clickbait Title YOU WON'T BELIEVE",
	"How to Cook Pasta - Simple Tutorial",
	"Reaction Video to Popular Song",
	"I Tried Fortnite Cheats… And This Happened",
	"I Tried the Viral Money Hack – Insane Results!",
	"Win Free PS5 Now – Limited Spots Left!",
	"One Stock to Make You Rich Overnight",
	"Cure Diseases with This Kitchen Item Fast",
	"ASMR Challenge That Almost Killed Me"
];
class OptionsManager {
  constructor() {
    this.elements = {
	  debugMode: document.getElementById('debugMode'),
      blockingRules: document.getElementById('blockingRules'),
      blockedVideoIds: document.getElementById('blockedVideoIds'),
	  testTitles: document.getElementById('testTitles'),
      showPlaceholders: document.getElementById('showPlaceholders'),
      saveBtn: document.getElementById('saveBtn'),
      testBtn: document.getElementById('testBtn'),
      resetBtn: document.getElementById('resetBtn'),
      statusMessage: document.getElementById('statusMessage'),
      titleRuleCount: document.getElementById('titleRuleCount'),
	  blockedIdCount: document.getElementById('blockedIdCount'),
      blockedCount: document.getElementById('blockedCount'),
      themeToggle: document.getElementById('themeToggle'),
      tabs: document.querySelectorAll('.tab'),
      tabContents: document.querySelectorAll('.tab-content')
    };
    
    this.init();
  }

  async init() {
    await this.loadSettings();
    this.setupEventListeners();
    this.setupTheme();
    this.updateStats();
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.sync.get(['blockingRules', 'blockedVideoIds', 'blockedVideosCount', 'theme', 'showPlaceholders']);
	  
	  const debugResult = await chrome.storage.local.get(['DEBUG']);
	  const debugEnabled = debugResult.DEBUG !== undefined ? debugResult.DEBUG : false;
      this.elements.debugMode.checked = debugEnabled;
      DEBUG = debugEnabled;
      
      if (result.blockingRules) {
        this.elements.blockingRules.value = result.blockingRules.join('\n');
      }
      
      if (result.blockedVideoIds) {
        this.elements.blockedVideoIds.value = result.blockedVideoIds.map(entry => `${entry.id}: ${entry.title}`).join('\n');
      }
      
      if (result.blockedVideosCount) {
        this.elements.blockedCount.textContent = result.blockedVideosCount;
      }
      
      if (result.theme) {
        document.documentElement.setAttribute('data-theme', result.theme);
        this.elements.themeToggle.classList.toggle('active', result.theme === 'light');
        chrome.storage.local.set({ 'yt-blocker-theme': result.theme }); // Sync cache
      }
      
      if (result.showPlaceholders !== undefined) {
        this.elements.showPlaceholders.checked = result.showPlaceholders;
      }
      
	  // Populate testTitles with default values if empty
	  if (this.elements.testTitles && !this.elements.testTitles.value.trim()) {
		this.elements.testTitles.value = defaultTitles.join('\n');
	  }	
		
      document.body.classList.add('theme-loaded'); // Reveal page
    } catch (error) {
      console.error('Error loading settings:', error);
      this.showStatus('Error loading settings', 'error');
      document.body.classList.add('theme-loaded'); // Ensure page is visible
    }
  }

  setupEventListeners() {
    this.elements.saveBtn.addEventListener('click', () => this.saveRules());
    this.elements.testBtn.addEventListener('click', () => this.testRules());
    this.elements.resetBtn.addEventListener('click', () => this.resetCounters());
    this.elements.blockingRules.addEventListener('input', () => this.updateStats());
    this.elements.blockedVideoIds.addEventListener('input', () => this.updateStats());
    this.elements.showPlaceholders.addEventListener('change', () => this.saveShowPlaceholders());
    this.elements.themeToggle.addEventListener('click', () => this.toggleTheme());
	this.elements.debugMode.addEventListener('change', () => this.saveDebugMode());
    
    // Auto-save on input (debounced)
    let saveTimeout;
    this.elements.blockingRules.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => this.saveRules(true), 2000);
    });
    this.elements.blockedVideoIds.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => this.saveRules(true), 2000);
    });
    
    this.elements.tabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });
  }

  setupTheme() {
    // Detect system theme preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!document.documentElement.getAttribute('data-theme')) {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        this.elements.themeToggle.classList.toggle('active', e.matches);
      }
    });
    
    // Set initial theme if not already set
    if (!document.documentElement.getAttribute('data-theme')) {
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      this.elements.themeToggle.classList.toggle('active', prefersDark);
    }
  }

  async toggleTheme() {
    try {
      this.elements.themeToggle.classList.toggle('active');
      const newTheme = this.elements.themeToggle.classList.contains('active') ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      await chrome.storage.sync.set({ theme: newTheme });
      chrome.storage.local.set({ 'yt-blocker-theme': newTheme }); // Sync cache
      this.showStatus(`Switched to ${newTheme} theme`, 'success');
    } catch (error) {
      console.error('Error toggling theme:', error);
      this.showStatus('Error toggling theme', 'error');
    }
  }

  parseRules(text) {
    return text
      .split('\n')
      .map(rule => rule.trim())
      .filter(rule => rule.length > 0);
  }
  
  parseBlockedVideoIds(text) {
    return text
      .split('\n')
      .map(line => {
        const [id, ...titleParts] = line.split(':').map(part => part.trim());
        if (id && id.match(/^[a-zA-Z0-9_-]{11}$/)) {
          return { id, title: titleParts.join(':') || 'Unknown Title' };
        }
        return null;
      })
      .filter(entry => entry);
  }
  updateStats() {
    const titleRules = this.parseRules(this.elements.blockingRules.value);
    const blockedVideoIds = this.elements.blockedVideoIds.value
      .split('\n')
      .map(line => line.split(':')[0].trim())
      .filter(id => id && id.match(/^[a-zA-Z0-9_-]{11}$/));
	this.elements.titleRuleCount.textContent = titleRules.length;
	this.elements.blockedIdCount.textContent = blockedVideoIds.length;
  }

  async saveRules(autoSave = false) {
    try {
      const rules = this.parseRules(this.elements.blockingRules.value);
      const blockedVideoIds = this.elements.blockedVideoIds.value
        .split('\n')
        .map(line => {
          const [id, ...titleParts] = line.split(':').map(part => part.trim());
          if (id && id.match(/^[a-zA-Z0-9_-]{11}$/)) {
            return { id, title: titleParts.join(':') || 'Unknown Title' };
          }
          return null;
        })
        .filter(entry => entry);

      await chrome.storage.sync.set({
        blockingRules: rules,
        blockedVideoIds
      });
      
      this.updateStats();
      this.showStatus(autoSave ? 'Rules auto-saved' : 'Rules saved successfully', 'success');
    } catch (error) {
      console.error('Error saving rules:', error);
      this.showStatus('Error saving rules', 'error');
    }
  }

  async saveShowPlaceholders() {
    try {
      await chrome.storage.sync.set({ showPlaceholders: this.elements.showPlaceholders.checked });
      this.showStatus(`Placeholder setting updated`, 'success');
    } catch (error) {
      console.error('Error saving placeholder setting:', error);
      this.showStatus('Error saving placeholder setting', 'error');
    }
  }
  
  async saveDebugMode() {
    try {
      if (!this.elements.debugMode) return;
      const enabled = this.elements.debugMode.checked;
      
      // Save to chrome.storage.local
      await chrome.storage.local.set({ DEBUG: enabled });
      
      // Update the local DEBUG variable immediately
      DEBUG = enabled;
      
      this.showStatus(`Debug mode ${enabled ? 'enabled' : 'disabled'}`, 'success');
      logDebug('Debug mode changed from options:', enabled);
    } catch (error) {
      console.error('Error saving debug mode:', error);
      this.showStatus('Error saving debug mode', 'error');
    }
  }
  
  testRules() {
    const rules = this.parseRules(this.elements.blockingRules.value);
    
    if (rules.length === 0) {
      this.showStatus('No rules to test', 'error');
      return;
    }
    
    // Get user-provided test titles, with fallback to default samples
    const testTitlesElement = this.elements.testTitles;
    let testTitles = [];
    
    if (testTitlesElement && testTitlesElement.value.trim()) {
      // Use user-provided titles
      testTitles = testTitlesElement.value
        .split('\n')
        .map(title => title.trim())
        .filter(title => title.length > 0);
    }
    
    if (testTitles.length === 0) {
      // Fallback to default sample titles and populate the textarea
      testTitles = defaultTitles;
      testTitlesElement.value = defaultTitles.join('\n');
    }
    
    const blockedTitles = [];
    const results = [];
    
    testTitles.forEach(title => {
      const matchedRules = [];
      rules.forEach(rule => {
        if (title.toLowerCase().includes(rule.toLowerCase())) {
          matchedRules.push(rule);
        }
      });
      
      if (matchedRules.length > 0) {
        blockedTitles.push(title);
        results.push(`❌ "${title}" (matches: ${matchedRules.join(', ')})`);
      } else {
        results.push(`✅ "${title}"`);
      }
    });
    
    // Create detailed results message
    const totalTested = testTitles.length;
    const totalBlocked = blockedTitles.length;
    const totalAllowed = totalTested - totalBlocked;
    
    let detailedResults = `Test Results Summary:\n`;
    detailedResults += `${totalBlocked} blocked, ${totalAllowed} allowed out of ${totalTested} titles\n\n`;
    detailedResults += `Detailed Results:\n`;
    detailedResults += results.join('\n');
    
    // Show results in the UI console
    const testResultsSection = document.getElementById('testResultsSection');
    const testResultsDiv = document.getElementById('testResults');
    
    if (testResultsSection && testResultsDiv) {
      testResultsDiv.textContent = detailedResults;
      testResultsSection.style.display = 'block';
      
      // Scroll to results
      testResultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    
    // Show summary in status message
    this.showStatus(
      `Test complete: ${totalBlocked} blocked, ${totalAllowed} allowed out of ${totalTested} titles`,
      'success'
    );
  }

  async resetCounters() {
    try {
      await chrome.storage.sync.set({ blockedVideosCount: 0 });
      this.elements.blockedCount.textContent = 0;
      this.showStatus('Counters reset successfully', 'success');
    } catch (error) {
      console.error('Error resetting counters:', error);
      this.showStatus('Error resetting counters', 'error');
    }
  }

  showStatus(message, type) {
    const statusEl = this.elements.statusMessage;
    statusEl.textContent = message;
    statusEl.className = `status-message ${type}`;
    statusEl.style.display = 'block';
    
    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 3000);
  }
  
  switchTab(tabName) {
    this.elements.tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    this.elements.tabContents.forEach(content => {
      content.classList.toggle('active', content.id === `${tabName}-tab`);
    });
  }
}

// Initialize options manager when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new OptionsManager();
  });
} else {
  new OptionsManager();
}
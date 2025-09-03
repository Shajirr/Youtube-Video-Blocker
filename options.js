// YouTube Video Blocker Options Script
class OptionsManager {
  constructor() {
    this.elements = {
      blockingRules: document.getElementById('blockingRules'),
      showPlaceholders: document.getElementById('showPlaceholders'),	
      saveBtn: document.getElementById('saveBtn'),
      testBtn: document.getElementById('testBtn'),
      clearBtn: document.getElementById('clearBtn'),
      statusMessage: document.getElementById('statusMessage'),
      ruleCount: document.getElementById('ruleCount'),
      blockedCount: document.getElementById('blockedCount'),
      themeToggle: document.getElementById('themeToggle')
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
      const result = await chrome.storage.sync.get(['blockingRules', 'blockedVideosCount', 'theme', 'showPlaceholders']);
      
      if (result.blockingRules) {
        this.elements.blockingRules.value = result.blockingRules.join('\n');
      }
      
      if (result.blockedVideosCount) {
        this.elements.blockedCount.textContent = result.blockedVideosCount;
      }
      
      if (result.theme) {
        document.documentElement.setAttribute('data-theme', result.theme);
        this.elements.themeToggle.classList.toggle('active', result.theme === 'dark');
      }
      
      if (result.showPlaceholders !== undefined) {
        this.elements.showPlaceholders.checked = result.showPlaceholders;
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      this.showStatus('Error loading settings', 'error');
    }
  }

  setupEventListeners() {
    this.elements.saveBtn.addEventListener('click', () => this.saveRules());
    this.elements.testBtn.addEventListener('click', () => this.testRules());
    this.elements.clearBtn.addEventListener('click', () => this.clearRules());
    this.elements.blockingRules.addEventListener('input', () => this.updateStats());
	this.elements.showPlaceholders.addEventListener('change', () => this.saveShowPlaceholders());
    this.elements.themeToggle.addEventListener('click', () => this.toggleTheme());
    
    // Auto-save on input (debounced)
    let saveTimeout;
    this.elements.blockingRules.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => this.saveRules(true), 2000);
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
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    document.documentElement.setAttribute('data-theme', newTheme);
    this.elements.themeToggle.classList.toggle('active', newTheme === 'dark');
    
    try {
      await chrome.storage.sync.set({ theme: newTheme });
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  }

  parseRules(text) {
    return text
      .split('\n')
      .map(rule => rule.trim())
      .filter(rule => rule.length > 0);
  }

  updateStats() {
    const rules = this.parseRules(this.elements.blockingRules.value);
    this.elements.ruleCount.textContent = rules.length;
  }

  async saveRules(silent = false) {
    const rulesText = this.elements.blockingRules.value;
    const rules = this.parseRules(rulesText);
    
    try {
      await chrome.storage.sync.set({ blockingRules: rules });
      
      if (!silent) {
        this.showStatus(`Saved ${rules.length} blocking rules`, 'success');
      }
      
      this.updateStats();
      
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
  testRules() {
    const rules = this.parseRules(this.elements.blockingRules.value);
    
    if (rules.length === 0) {
      this.showStatus('No rules to test', 'error');
      return;
    }
    
    // Sample video titles for testing
    const sampleTitles = [
      "Amazing Cat Videos Compilation",
      "SCAMMER Gets EXPOSED!!!",
      "Clickbait Title YOU WON'T BELIEVE",
      "How to Cook Pasta - Simple Tutorial",
      "FAKE NEWS About Celebrity Drama",
      "Conspiracy Theory About Space",
      "Reaction Video to Popular Song",
      "Educational Content About Science"
    ];
    
    const blockedTitles = [];
    
    sampleTitles.forEach(title => {
      const shouldBlock = rules.some(rule => 
        title.toLowerCase().includes(rule.toLowerCase())
      );
      
      if (shouldBlock) {
        blockedTitles.push(title);
      }
    });
    
    if (blockedTitles.length > 0) {
      this.showStatus(
        `Test complete: ${blockedTitles.length} out of ${sampleTitles.length} sample videos would be blocked`,
        'success'
      );
    } else {
      this.showStatus(
        `Test complete: None of the ${sampleTitles.length} sample videos would be blocked`,
        'success'
      );
    }
  }

  async clearRules() {
    if (!confirm('Are you sure you want to clear all blocking rules?')) {
      return;
    }
    
    this.elements.blockingRules.value = '';
    
    try {
      await chrome.storage.sync.set({ blockingRules: [] });
      this.showStatus('All rules cleared', 'success');
      this.updateStats();
    } catch (error) {
      console.error('Error clearing rules:', error);
      this.showStatus('Error clearing rules', 'error');
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
}

// Initialize options manager when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new OptionsManager();
  });
} else {
  new OptionsManager();
}
// YouTube Video Blocker Options Script
class OptionsManager {
  constructor() {
    this.elements = {
      blockingRules: document.getElementById('blockingRules'),
      blockedVideoIds: document.getElementById('blockedVideoIds'),
      showPlaceholders: document.getElementById('showPlaceholders'),
      saveBtn: document.getElementById('saveBtn'),
      testBtn: document.getElementById('testBtn'),
      resetBtn: document.getElementById('resetBtn'),
      statusMessage: document.getElementById('statusMessage'),
      ruleCount: document.getElementById('ruleCount'),
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
    this.elements.resetBtn.addEventListener('click', () => this.resetCounters());
    this.elements.blockingRules.addEventListener('input', () => this.updateStats());
    this.elements.blockedVideoIds.addEventListener('input', () => this.updateStats());
    this.elements.showPlaceholders.addEventListener('change', () => this.saveShowPlaceholders());
    this.elements.themeToggle.addEventListener('click', () => this.toggleTheme());
    
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
    const rules = this.parseRules(this.elements.blockingRules.value);
    const blockedVideoIds = this.elements.blockedVideoIds.value
      .split('\n')
      .map(line => line.split(':')[0].trim())
      .filter(id => id && id.match(/^[a-zA-Z0-9_-]{11}$/));
    this.elements.ruleCount.textContent = rules.length + blockedVideoIds.length;
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
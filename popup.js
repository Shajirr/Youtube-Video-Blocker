// YouTube Video Blocker Popup Script
class PopupManager {
  constructor() {
    this.elements = {
      ruleCount: document.getElementById('ruleCount'),
      blockedCount: document.getElementById('blockedCount'),
      openOptions: document.getElementById('openOptions'),
      toggleExtension: document.getElementById('toggleExtension'),
      status: document.getElementById('status')
    };
    
    this.isEnabled = true;
    this.init();
  }

  async init() {
    await this.loadData();
    this.setupEventListeners();
    this.updateUI();
  }

  async loadData() {
    try {
      const result = await chrome.storage.sync.get([
        'blockingRules',
        'blockedVideosCount',
        'extensionEnabled'
      ]);
      
      const rules = result.blockingRules || [];
      const blockedCount = result.blockedVideosCount || 0;
      this.isEnabled = result.extensionEnabled !== false; // Default to true
      
      this.elements.ruleCount.textContent = rules.length;
      this.elements.blockedCount.textContent = blockedCount;
      
    } catch (error) {
      console.error('Error loading data:', error);
    }
  }

  setupEventListeners() {
    this.elements.openOptions.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });

    this.elements.toggleExtension.addEventListener('click', () => {
      this.toggleExtension();
    });
  }

  async toggleExtension() {
    this.isEnabled = !this.isEnabled;
    
    try {
      await chrome.storage.sync.set({ extensionEnabled: this.isEnabled });
      this.updateUI();
      
      // Notify content script of the change
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('youtube.com')) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'toggleExtension',
          enabled: this.isEnabled
        }).catch(() => {
          // Content script might not be loaded, that's okay
        });
      }
      
    } catch (error) {
      console.error('Error toggling extension:', error);
    }
  }

  updateUI() {
    if (this.isEnabled) {
      this.elements.toggleExtension.textContent = '⏸️ Pause Blocking';
      this.elements.toggleExtension.className = 'btn btn-secondary';
      this.elements.status.textContent = 'Extension is active';
      this.elements.status.className = 'status active';
    } else {
      this.elements.toggleExtension.textContent = '▶️ Resume Blocking';
      this.elements.toggleExtension.className = 'btn btn-primary';
      this.elements.status.textContent = 'Extension is paused';
      this.elements.status.className = 'status inactive';
    }
  }
}

// Initialize popup manager when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new PopupManager();
  });
} else {
  new PopupManager();
}
// YouTube Video Blocker Initial Theme Script
(function () {
  chrome.storage.local.get(['yt-blocker-theme'], (result) => {
    const theme = result['yt-blocker-theme'] || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.add('theme-loaded');
  });
})();
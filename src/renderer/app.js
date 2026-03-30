// SWEGEO GNSS Monitor - Main Renderer
// Initializes all components and manages page navigation

// Main App Logic
// Components are loaded via script tags in index.html

// Global Error Handler
window.onerror = function (message, source, lineno, colno, error) {
  console.error('Global Error:', message, 'at', source, ':', lineno);
  alert(`App Error: ${message}\nCheck console for details.`);
};

// Dismiss splash after animation completes
const splashOverlay = document.getElementById('splash-overlay');
if (splashOverlay) {
  splashOverlay.addEventListener('animationend', (e) => {
    if (e.animationName === 'splashFadeOut') {
      splashOverlay.classList.add('splash-hidden');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM Content Loaded');

  // Check if API is available
  if (!window.api) {
    console.error('FATAL: API not exposed to renderer. Preload script failed?');
    alert('API not available. Application cannot start.');
    return;
  }

  try {
    // Initialize Components
    console.log('Initializing Sidebar...');
    const sidebar = new Sidebar();

    console.log('Initializing Terminal...');
    const terminal = new Terminal(window.api);

    console.log('Initializing ConnectionDialog...');
    const connDialog = new ConnectionDialog(window.api);

    console.log('Initializing Dashboard...');
    const dashboard = new Dashboard(window.api);

    console.log('Initializing MessagesSettings...');
    const messagesSettings = new MessagesSettings(window.api);

    console.log('Initializing HeadingSettings...');
    const headingSettings = new HeadingSettings(window.api);

    console.log('Initializing BaseRoverSettings...');
    const baseRoverSettings = new BaseRoverSettings(window.api);

    console.log('Initializing EthernetSettings...');
    const ethernetSettings = new EthernetSettings(window.api);

    console.log('Initializing InsSettings...');
    const insSettings = new InsSettings(window.api);

    console.log('Initializing NtripClientPage...');
    const ntripClientPage = new NtripClientPage();

    console.log('Initializing RtkCard...');
    const rtkCard = new RtkCard(ntripClientPage);

    console.log('Initializing UpdatePanel...');
    const updatePanel = new UpdatePanel();

    // Connection state changes
    window.api.onConnection((connected) => {
      messagesSettings.onConnectionChanged(connected);
    });

    // Device capabilities: connect → main.js runs LOG AUTHORIZATION ONCE and resolves here
    // null = disconnected or unknown device → show all cards (default layout)
    window.api.onDeviceCapabilities((caps) => {
      dashboard.applyCapabilities(caps);
      messagesSettings.applyCapabilities(caps);
      baseRoverSettings.applyCapabilities(caps);
      ethernetSettings.applyCapabilities(caps);

      const isUblox = caps?.detected === true && caps?.family === 'ublox';
      const knownNoIns = caps !== null && caps?.detected === true && caps?.ins === false;

      const tabs = {
        messages: document.querySelector('.settings-tab[data-settings-tab="messages"]'),
        ethernet: document.querySelector('.settings-tab[data-settings-tab="ethernet"]'),
        baseRover: document.querySelector('.settings-tab[data-settings-tab="base-rover"]'),
        heading: document.querySelector('.settings-tab[data-settings-tab="heading"]'),
        ins: document.querySelector('.settings-tab[data-settings-tab="ins"]')
      };

      const panels = {
        messages: document.getElementById('settings-panel-messages'),
        ethernet: document.getElementById('settings-panel-ethernet'),
        baseRover: document.getElementById('settings-panel-base-rover'),
        heading: document.getElementById('settings-panel-heading'),
        ins: document.getElementById('settings-panel-ins')
      };

      // F9P phase-1 gating: only Messages + Ethernet tabs stay active for ublox devices.
      if (isUblox) {
        if (tabs.baseRover) tabs.baseRover.style.display = 'none';
        if (tabs.heading) tabs.heading.style.display = 'none';
        if (tabs.ins) tabs.ins.style.display = 'none';
        if (panels.baseRover) panels.baseRover.style.display = 'none';
        if (panels.heading) panels.heading.style.display = 'none';
        if (panels.ins) panels.ins.style.display = 'none';
      } else {
        if (tabs.baseRover) tabs.baseRover.style.display = '';
        if (tabs.heading) tabs.heading.style.display = '';
        if (panels.baseRover) panels.baseRover.style.display = '';
        if (panels.heading) panels.heading.style.display = '';

        // Non-ublox flow: INS visibility still depends on capability
        if (tabs.ins) tabs.ins.style.display = knownNoIns ? 'none' : '';
        if (panels.ins) panels.ins.style.display = knownNoIns ? 'none' : '';
      }

      const hiddenActive =
        (tabs.baseRover?.classList.contains('active') && tabs.baseRover?.style.display === 'none') ||
        (tabs.heading?.classList.contains('active') && tabs.heading?.style.display === 'none') ||
        (tabs.ins?.classList.contains('active') && tabs.ins?.style.display === 'none');
      if (hiddenActive) {
        tabs.messages?.click();
      }
      updateSettingsTabIndicator();
    });

    // Settings tab switching & Sliding Indicator
    const settingsTabs = document.querySelectorAll('.settings-tabs .settings-tab');
    const settingsPanels = document.querySelectorAll('.settings-panel');
    const tabIndicator = document.querySelector('.settings-tab-indicator');

    function updateSettingsTabIndicator() {
      const activeTab = document.querySelector('.settings-tabs .settings-tab.active');
      if (!activeTab || !tabIndicator) return;

      // Use requestAnimationFrame to ensure layout is ready
      requestAnimationFrame(() => {
        const parentRect = activeTab.parentElement.getBoundingClientRect();
        const tabRect = activeTab.getBoundingClientRect();

        // Calculate relative position
        const left = tabRect.left - parentRect.left;
        const width = tabRect.width;

        tabIndicator.style.width = `${width}px`;
        tabIndicator.style.transform = `translateX(${left}px)`;
      });
    }

    // Initial update with a slight delay and retry to catch font loading or layout shifts
    setTimeout(updateSettingsTabIndicator, 50);
    setTimeout(updateSettingsTabIndicator, 200);

    // Also update on window resize
    window.addEventListener('resize', () => {
      clearTimeout(window._resizeTimer);
      window._resizeTimer = setTimeout(updateSettingsTabIndicator, 20);
    });

    // Update indicator after sidebar collapse/expand CSS transition completes
    document.getElementById('sidebar')?.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'width') updateSettingsTabIndicator();
    });

    settingsTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetName = tab.dataset.settingsTab; // Correct HTML attribute: data-settings-tab
        const targetId = `settings-panel-${targetName}`;

        // Update Active Classes
        settingsTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        settingsPanels.forEach(p => {
          p.classList.remove('active');
          if (p.id === targetId) {
            p.classList.add('active');
          }
        });

        // Update Indicator
        updateSettingsTabIndicator();

        // Notify settings tabs when they become active 
        if (targetName === 'messages') messagesSettings?.onPageActivated();
        if (targetName === 'heading') headingSettings?.onPageActivated();
        if (targetName === 'base-rover') baseRoverSettings?.onPageActivated();
        if (targetName === 'ethernet') ethernetSettings?.onPageActivated();
        if (targetName === 'ins') insSettings?.onPageActivated();
      });
    });

    // Hook into sidebar page changes to trigger settings activation
    const origSetActive = sidebar.setActivePage.bind(sidebar);
    sidebar.setActivePage = (pageId, btnIndex) => {
      origSetActive(pageId, btnIndex);
      if (pageId === 'settings') {
        // Trigger resize update on page visible
        setTimeout(updateSettingsTabIndicator, 50);

        const activeTab = document.querySelector('.settings-tab.active');
        const target = activeTab?.dataset.settingsTab || 'messages';
        if (target === 'messages') messagesSettings?.onPageActivated();
        if (target === 'heading') headingSettings?.onPageActivated();
        if (target === 'base-rover') baseRoverSettings?.onPageActivated();
        if (target === 'ethernet') ethernetSettings?.onPageActivated();
        if (target === 'ins') insSettings?.onPageActivated();
      }
    };

    console.log('App Initialization Complete');
  } catch (e) {
    console.error('Component Initialization Failed:', e);
    alert(`Startup Error: ${e.message}`);
  }
});

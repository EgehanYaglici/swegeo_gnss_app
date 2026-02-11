// SWEGEO GNSS Monitor - Main Renderer
// Initializes all components and manages page navigation

// Main App Logic
// Components are loaded via script tags in index.html

// Global Error Handler
window.onerror = function (message, source, lineno, colno, error) {
  console.error('Global Error:', message, 'at', source, ':', lineno);
  alert(`App Error: ${message}\nCheck console for details.`);
};

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

    // Auto-scan ports when connection established
    window.api.onConnection((connected) => {
      messagesSettings.onConnectionChanged(connected);
    });

    // Settings tab switching
    const settingsTabs = document.querySelectorAll('.settings-tab');
    const settingsPanels = document.querySelectorAll('.settings-panel');
    settingsTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.settingsTab;
        settingsTabs.forEach(t => t.classList.toggle('active', t === tab));
        settingsPanels.forEach(p => p.classList.toggle('active', p.id === `settings-panel-${target}`));
        // Notify settings tabs when they become active
        if (target === 'messages') messagesSettings.onPageActivated();
        if (target === 'heading') headingSettings.onPageActivated();
        if (target === 'base-rover') baseRoverSettings.onPageActivated();
        if (target === 'ethernet') ethernetSettings.onPageActivated();
        if (target === 'ins') insSettings.onPageActivated();
      });
    });

    // Hook into sidebar page changes to trigger settings activation
    const origSetActive = sidebar.setActivePage.bind(sidebar);
    sidebar.setActivePage = (pageId, btnIndex) => {
      origSetActive(pageId, btnIndex);
      if (pageId === 'settings') {
        const activeTab = document.querySelector('.settings-tab.active');
        const target = activeTab?.dataset.settingsTab || 'messages';
        if (target === 'messages') messagesSettings.onPageActivated();
        if (target === 'heading') headingSettings.onPageActivated();
        if (target === 'base-rover') baseRoverSettings.onPageActivated();
        if (target === 'ethernet') ethernetSettings.onPageActivated();
        if (target === 'ins') insSettings.onPageActivated();
      }
    };

    console.log('App Initialization Complete');
  } catch (e) {
    console.error('Component Initialization Failed:', e);
    alert(`Startup Error: ${e.message}`);
  }
});

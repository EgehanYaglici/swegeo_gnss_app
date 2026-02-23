class Sidebar {
    constructor() {
        this.sidebar = document.getElementById('sidebar');
        this.toggleBtn = document.getElementById('btn-sidebar-toggle');
        this.navBtns = document.querySelectorAll('.nav-btn[data-page]');
        this.indicator = document.querySelector('.nav-indicator');
        this.pages = document.querySelectorAll('.page');

        this.init();
    }

    init() {
        // Pre-warm GPU layer on first interaction — do a silent toggle before user sees it
        this._warmed = false;
        this._warmupGPU();

        // Toggle expand/collapse
        this.toggleBtn?.addEventListener('click', () => this.toggle());

        // Navigation with animated indicator
        this.navBtns.forEach((btn, index) => {
            btn.addEventListener('click', () => {
                const pageId = btn.dataset.page;
                this.setActivePage(pageId, index);
            });
        });

        // Set initial indicator position
        this.updateIndicator(0);
    }

    _warmupGPU() {
        // Silently toggle without transition to create GPU compositing layer
        // This prevents the "first click jank" in Electron/Chromium
        requestAnimationFrame(() => {
            this.sidebar.style.transition = 'none';
            this.sidebar.classList.add('collapsed');
            void this.sidebar.offsetWidth; // force reflow
            this.sidebar.classList.remove('collapsed');
            void this.sidebar.offsetWidth;
            this.sidebar.style.transition = '';
            this._warmed = true;
        });
    }

    toggle() {
        this.sidebar.classList.toggle('collapsed');
    }

    setActivePage(pageId, btnIndex) {
        // Update active button
        this.navBtns.forEach(b => b.classList.toggle('active', b.dataset.page === pageId));

        // Update active page
        this.pages.forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));

        // Animate indicator
        this.updateIndicator(btnIndex);
    }

    updateIndicator(index) {
        if (this.indicator) {
            // Python formula: 24px padding + (index * 58px)
            // 58px = 52px button height + 6px margin-bottom
            const top = 24 + (index * 58);
            this.indicator.style.top = `${top}px`;
        }
    }
}

// End Sidebar class


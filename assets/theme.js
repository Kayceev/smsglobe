// --- Light / dark theme (shared by every page; styles live in dark.css) ---
(function () {
    const root = document.documentElement;

    // 1. Apply The Saved Choice Before First Paint (otherwise the device setting)
    try {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            root.classList.add('dark');
        }
    } catch (e) {}

    const MOON = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>';
    const SUN = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>';

    // 2. Swap Logos And Toggle Icons To Match The Mode
    function renderTheme() {
        const isDark = root.classList.contains('dark');

        // The dark logo has white text and a transparent background
        document.querySelectorAll('img[src$="logo.png"], img[src$="logo-dark.png"]').forEach(img => {
            const next = img.src.replace(/logo(-dark)?\.png$/, isDark ? 'logo-dark.png' : 'logo.png');
            if (img.src !== next) img.src = next;
        });

        document.querySelectorAll('[data-theme-icon], #themeIcon').forEach(icon => {
            icon.innerHTML = isDark ? SUN : MOON;
        });

        // The sliding switch animates from CSS; only its state needs updating
        document.querySelectorAll('.theme-switch').forEach(sw => {
            sw.setAttribute('aria-checked', isDark ? 'true' : 'false');
        });
    }

    function applyToggle() {
        const isDark = root.classList.toggle('dark');
        try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch (e) {}
        renderTheme();
    }

    // 3. Flip The Theme With A Soft Cross-Fade (the timing lives in dark.css, ::view-transition rules)
    window.toggleTheme = function () {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduceMotion) return applyToggle();

        // Older browsers: fade the colours on every element for a moment instead
        if (!document.startViewTransition) {
            root.classList.add('theme-fading');
            applyToggle();
            setTimeout(() => root.classList.remove('theme-fading'), 450);
            return;
        }

        // A second click mid-fade skips the first transition, which is fine (no console noise)
        const transition = document.startViewTransition(applyToggle);
        transition.ready.catch(() => {});
        transition.finished.catch(() => {});
    };

    // 4. Add A Floating Toggle On Pages That Have No Header Button
    // (pages that use the header spot for something else opt out with <body data-no-theme-fab>)
    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('themeToggle') && !document.body.hasAttribute('data-no-theme-fab')) {
            const fab = document.createElement('button');
            fab.id = 'themeToggle';
            fab.className = 'theme-fab';
            fab.type = 'button';
            fab.setAttribute('aria-label', 'Switch light or dark mode');
            fab.innerHTML = '<svg id="themeIcon" class="w-5 h-5" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"></svg>';
            fab.addEventListener('click', window.toggleTheme);
            document.body.appendChild(fab);
        }
        renderTheme();
    });
})();

// --- Embedded mode for the admin User View ---
// A buy page opened inside the admin's User View (/admin/user-view loads it in an iframe with
// ?embed=1) hides its own sidebar and top bar, opens links to other pages in a new tab, and tells
// the admin page after wallet changes so the top bar balance stays current.
(function () {
    const isEmbedded = window.self !== window.top && new URLSearchParams(location.search).has('embed');
    if (!isEmbedded) return;

    // 1. Hide The Customer Chrome Before First Paint
    document.documentElement.classList.add('embedded');
    const style = document.createElement('style');
    style.textContent = `
        html.embedded #sidebar, html.embedded #sidebarOverlay, html.embedded header.sticky, html.embedded .theme-fab { display: none !important; }
        html.embedded .lg\\:ml-64 { margin-left: 0 !important; }
        html.embedded .min-h-screen { min-height: 0 !important; }
        html.embedded .md\\:top-\\[69px\\] { top: 0 !important; } /* Sticky bars sat under the hidden top bar */
    `;
    document.head.appendChild(style);

    // 2. Links To Other Pages Open In A New Tab, So The Admin Stays In User View (Fund Wallet tells the admin to use the Users page)
    document.addEventListener('click', e => {
        const link = e.target.closest('a[href]');
        if (!link || link.target || link.getAttribute('href').startsWith('#')) return;
        const url = new URL(link.href, location.href);
        if (url.origin === location.origin && url.pathname === location.pathname) return;
        e.preventDefault();
        // Admins top up from the Users page, not by bank transfer
        if (url.origin === location.origin && url.pathname === '/fund-wallet') {
            window.parent.postMessage({ type: 'user-view:add-money' }, location.origin);
            return;
        }
        window.open(url.href, '_blank', 'noopener');
    }, true);

    // 3. Tell The Admin Page After Any Wallet-Changing Call (purchase, cancel...), So Its Top Bar Balance Updates
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const response = await realFetch(input, init);
        const method = String(init.method || 'GET').toUpperCase();
        if (method !== 'GET' && String(input).includes('/api/')) {
            window.parent.postMessage({ type: 'user-view:wallet-changed' }, location.origin);
        }
        return response;
    };
})();

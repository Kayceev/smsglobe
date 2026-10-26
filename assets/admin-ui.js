/**
 * Admin Messages And Confirmations
 * Replaces the browser's alert() and confirm() boxes on admin pages:
 * - notify(message, type): a toast in the corner ('success', 'error', 'warning' or 'info')
 * - confirmAction(message, options): an in-page dialog that resolves true or false
 * Built on SweetAlert2 (loaded just before this file); its dark mode colours are in dark.css.
 * If SweetAlert2 fails to load, both fall back to the browser boxes so nothing breaks.
 * It also turns the top bar's "Admin" badge into the admin's own wallet balance (section 3).
 */
(function () {
    var BRAND_BLUE = '#0F54C6';
    var BRAND_RED = '#E31E24';

    // Plain text only: pages may pass API text that was HTML-escaped for display, so decode
    // the entities and hand SweetAlert2 the result as text (never as HTML)
    function text(message) {
        var box = document.createElement('textarea');
        box.innerHTML = String(message == null ? '' : message);
        return box.value;
    }

    // --- 1. Toasts ---
    window.notify = function (message, type) {
        type = type || 'success';
        if (!window.Swal) return window.alert(text(message));

        var isProblem = type === 'error' || type === 'warning';
        window.Swal.fire({
            toast: true,
            position: 'top-end',
            icon: type,
            titleText: text(message),
            showConfirmButton: false,
            showCloseButton: true,
            timer: isProblem ? 6000 : 3000, // Problems stay up long enough to read
            timerProgressBar: true,
            customClass: { title: 'admin-toast-title' },
            didOpen: function (toast) {
                toast.addEventListener('mouseenter', window.Swal.stopTimer);
                toast.addEventListener('mouseleave', window.Swal.resumeTimer);
            }
        });
    };

    // --- 2. Confirm Dialog ---
    // options: { title, confirmText, cancelText, danger }
    window.confirmAction = function (message, options) {
        options = options || {};
        if (!window.Swal) return Promise.resolve(window.confirm(text(message)));

        return window.Swal.fire({
            titleText: options.title || 'Are you sure?',
            text: text(message),
            icon: options.danger ? 'warning' : 'question',
            showCancelButton: true,
            confirmButtonText: options.confirmText || 'Yes, continue',
            cancelButtonText: options.cancelText || 'Cancel',
            confirmButtonColor: options.danger ? BRAND_RED : BRAND_BLUE,
            reverseButtons: true,
            focusCancel: Boolean(options.danger)
        }).then(function (result) { return result.isConfirmed; });
    };

    // --- 3. Top Bar Wallet ---
    // The "Admin" badge in the top bar shows the admin's own customer wallet (the one User View spends).
    // It refreshes after a wallet credit on this page and after a purchase inside User View.
    var WALLET_ICON = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"></path>';

    function findAdminBadge() {
        var spans = document.querySelectorAll('header span');
        for (var i = 0; i < spans.length; i++) {
            if (spans[i].textContent.trim() === 'Admin' && spans[i].querySelector('svg')) return spans[i];
        }
        return null;
    }

    function setBadgeText(badge, value) {
        var textNode = Array.prototype.find.call(badge.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
        if (textNode) textNode.textContent = value;
        else badge.appendChild(document.createTextNode(value));
    }

    window.refreshAdminWallet = function () {
        var badge = document.getElementById('adminWalletBadge');
        var token = localStorage.getItem('smsglobe_admin_token');
        if (!badge || !token) return;
        realFetch('/api/admin-wallet', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) return;
                setBadgeText(badge, '₦' + Math.round(Number(data.balance || 0)).toLocaleString());
                badge.title = 'Your wallet' + (data.bonusBalance > 0 ? ' (+ ₦' + Math.round(data.bonusBalance).toLocaleString() + ' bonus)' : '') + '. Open User View to buy.';
            })
            .catch(function () {});
    };

    // Wallet credits made on this page (e.g. the admin topping up their own account on Users)
    var realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        var request = realFetch(input, init);
        var method = String((init && init.method) || 'GET').toUpperCase();
        if (method !== 'GET' && String(input).indexOf('admin-credit-user') !== -1) {
            request.then(function () { window.refreshAdminWallet(); }).catch(function () {});
        }
        return request;
    };

    // Purchases inside User View (posted by /assets/embed.js)
    window.addEventListener('message', function (e) {
        if (e.origin === location.origin && e.data && e.data.type === 'user-view:wallet-changed') setTimeout(window.refreshAdminWallet, 800);
    });

    document.addEventListener('DOMContentLoaded', function () {
        var badge = findAdminBadge();
        if (!badge) return;
        badge.id = 'adminWalletBadge';
        badge.classList.add('tabular-nums', 'cursor-pointer');
        var icon = badge.querySelector('svg');
        if (icon) icon.innerHTML = WALLET_ICON;
        setBadgeText(badge, '₦…');
        badge.addEventListener('click', function () { window.location.href = '/admin/user-view'; });
        window.refreshAdminWallet();
        window.addEventListener('focus', window.refreshAdminWallet);
    });

    // --- 4. Toast Text Style (wraps long messages, uses the page font) ---
    var style = document.createElement('style');
    style.textContent = '.admin-toast-title { font-family: Outfit, system-ui, sans-serif !important; font-size: 13px !important; font-weight: 600 !important; white-space: pre-line; }'
        + ' .swal2-popup { font-family: Outfit, system-ui, sans-serif; border-radius: 16px !important; }';
    document.head.appendChild(style);
})();

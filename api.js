const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const axios = require('axios');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

dotenv.config();
const app = express();

if (!process.env.JWT_SECRET) {
    console.error("⚠️ CRITICAL: JWT_SECRET is not set. Logins and every authenticated route will fail.");
}

// Public site address used in payment redirects and email links
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://www.deemaxhub.com').replace(/\/$/, '');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_KEY,
    api_secret: process.env.CLOUDINARY_SECRET
});

// Global in-memory cache shared across settings requests
let cachedSettings = null;
let lastFetchTime = 0;
const CACHE_TTL = 60000;

let cachedCountriesMeta = null;
let lastMetaFetchTime = 0;
const META_CACHE_TTL = 3600000; // 1 hour


// Receipts are held in memory, then streamed to Cloudinary with the signed API (see handleUploadReceipt)
const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 }, // Vercel caps request bodies at 4.5 MB
    fileFilter: (req, file, cb) => cb(null, RECEIPT_MIME_TYPES.includes(file.mimetype))
});

const smsBowerClient = axios.create({
    baseURL: process.env.SMSBOWER_BASE_URL || 'https://smsbower.page/stubs/handler_api.php',
    params: {
        api_key: process.env.SMSBOWER_API_KEY
    },
    timeout: 15000
});
const SMS_ALLOCATION_TIMEOUT_MS = 7000; // getNumberV2 runs after the debit (see handlePurchaseWithWallet)

// --- SMS DEMO MODE (LOCAL TESTING ONLY) ---
// Set SMS_DEMO_MODE=true in the local .env to click through the whole SMS flow
// (services, countries, buy, code, cancel, request-another) with no SMSBower key.
// Gated like demo login: never active when NODE_ENV is 'production' (Vercel always
// sets it), so demo numbers can never be sold on the live site. Demo vendor IDs
// start with 'DEMO-', and helpers honor that prefix even if the flag is later off.
function isSmsDemoMode() {
    return process.env.SMS_DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
}
const SMS_DEMO_TZID_PREFIX = 'DEMO-';
const SMS_DEMO_CODE_DELAY_MS = 25 * 1000; // First code lands on polls after this, so cancel can be tested first
const SMS_DEMO_SERVICES = [
    { code: 'whatsapp', name: 'WhatsApp' },
    { code: 'tg', name: 'Telegram' },
    { code: 'fb', name: 'Facebook' },
    { code: 'ig', name: 'Instagram' },
    { code: 'lf', name: 'TikTok' },
    { code: 'go', name: 'Google' }
];
// countryId values match the SMSBOWER_ID_TO_ISO map the frontend uses for flags
const SMS_DEMO_COUNTRIES = [
    { countryId: '19', countryName: 'Nigeria', code: 'ng', dial: '+234', costUsd: 0.35 },
    { countryId: '16', countryName: 'United Kingdom', code: 'gb', dial: '+44', costUsd: 0.55 },
    { countryId: '187', countryName: 'United States', code: 'us', dial: '+1', costUsd: 0.60 },
    { countryId: '22', countryName: 'India', code: 'in', dial: '+91', costUsd: 0.30 },
    { countryId: '31', countryName: 'South Africa', code: 'za', dial: '+27', costUsd: 0.40 }
];
function isSmsDemoVendorId(vendorId) {
    return typeof vendorId === 'string' && vendorId.startsWith(SMS_DEMO_TZID_PREFIX);
}
// Same tier shape as the live catalog, with fake operators (getSmsPriceCatalog prices them)
function buildSmsDemoCatalog(exchangeRateToNgn) {
    return SMS_DEMO_COUNTRIES.map(c => {
        const tiers = [0, 1].map(idx => {
            const costUsd = Number((c.costUsd * (idx === 0 ? 1 : 1.4)).toFixed(3));
            return {
                providerId: `demo-op-${idx + 1}`,
                count: idx === 0 ? 100 : 50,
                rank: idx === 0 ? 'Standard' : 'Premium',
                costUsd,
                baseCostNGN: costUsd * exchangeRateToNgn
            };
        });
        return {
            countryId: c.countryId,
            countryName: c.countryName,
            code: c.code,
            flagUrl: `https://flagcdn.com/w40/${c.code}.png`,
            tiers
        };
    });
}
function allocateSmsDemoNumber(countryId) {
    const demo = SMS_DEMO_COUNTRIES.find(c => c.countryId === String(countryId)) || SMS_DEMO_COUNTRIES[0];
    const subscriber = String(Math.floor(1000000 + Math.random() * 9000000));
    return {
        tzid: `${SMS_DEMO_TZID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        phoneNumber: `${demo.dial}${subscriber}`
    };
}
function makeSmsDemoCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// --- ACCOUNTS & VPN VENDOR (Sameeha's Socialhub) ---
// Social media accounts and VPN keys are resold from Sameeha's API (prices in NGN).
// Docs: https://sameehasocialhub.com/api-docs/ (needs a Sameeha login)
const sameehaClient = axios.create({
    baseURL: (process.env.SAMEEHA_BASE_URL || 'https://sameehasocialhub.com/api/v1').replace(/\/$/, ''),
    headers: { 'Authorization': `Bearer ${process.env.SAMEEHA_API_KEY}` },
    timeout: 15000
});
const ACCOUNT_BUY_TIMEOUT_MS = 7000; // /buy runs after the wallet debit (see handlePurchaseWithWallet)
const ACCOUNT_MAX_QUANTITY = 10; // Keys per order
const ACCOUNT_CATALOG_TTL = 60000;
let cachedAccountCatalog = null;
let lastAccountCatalogFetch = 0;

// --- ACCOUNTS DEMO MODE (LOCAL TESTING ONLY) ---
// Set ACCOUNTS_DEMO_MODE=true in the local .env to use a fake Sameeha catalog with no API key.
// Gated like SMS demo mode, so it can never run on Vercel. The wallet is still really debited.
function isAccountsDemoMode() {
    return process.env.ACCOUNTS_DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
}
const ACCOUNTS_DEMO_CATEGORIES = [
    { id: 1, name: 'Facebook', slug: 'facebook' },
    { id: 2, name: 'Instagram', slug: 'instagram' },
    { id: 3, name: 'Tiktok', slug: 'tiktok' },
    { id: 4, name: 'VPN', slug: 'vpn' }
];
const ACCOUNTS_DEMO_PRODUCTS = [
    { id: 9001, name: 'Facebook 2025', category_id: 1, price: '3500.00', stock: 57 },
    { id: 9002, name: 'Facebook Aged 2018 (Marketplace)', category_id: 1, price: '6200.00', stock: 4 },
    { id: 9003, name: 'Instagram 1K Followers', category_id: 2, price: '5000.00', stock: 12 },
    { id: 9004, name: 'Instagram Fresh (Email Verified)', category_id: 2, price: '1800.00', stock: 0 },
    { id: 9005, name: 'Tiktok USA 2024', category_id: 3, price: '4200.00', stock: 9 },
    { id: 9006, name: 'ExpressVPN 1 Month', category_id: 4, price: '2500.00', stock: 30 },
    { id: 9007, name: 'NordVPN 3 Months', category_id: 4, price: '6000.00', stock: 7 }
];

// Fake Sameeha responses with the same shapes as the live API
function sameehaDemoReply(method, path, params = {}, body = {}) {
    if (path === '/categories') {
        const results = ACCOUNTS_DEMO_CATEGORIES.map(c => ({ ...c, product_count: ACCOUNTS_DEMO_PRODUCTS.filter(p => p.category_id === c.id).length }));
        return { status: 200, data: { count: results.length, results } };
    }
    if (path === '/products') {
        const results = ACCOUNTS_DEMO_PRODUCTS
            .filter(p => !params.category || p.category_id === Number(params.category))
            .map(p => ({ ...p, in_stock: p.stock > 0 }));
        return { status: 200, data: { count: results.length, results } };
    }
    if (path === '/balance') return { status: 200, data: { balance: '250000.00', currency: 'NGN' } };
    if (path === '/buy' && method === 'post') {
        const product = ACCOUNTS_DEMO_PRODUCTS.find(p => p.id === Number(body.product));
        const quantity = Number(body.quantity) || 1;
        if (!product) return { status: 404, data: { error: 'not_found', detail: 'Product not found.' } };
        if (product.stock < quantity) return { status: 409, data: { error: 'out_of_stock', detail: 'Not enough keys.' } };
        // VPN keys come back as objects, like the live API's (the others as plain strings)
        const keys = Array.from({ length: quantity }, (_, i) => product.category_id === 4
            ? { email: `demo_vpn_${i + 1}@example.com`, password: `Pass${Math.floor(1000 + Math.random() * 9000)}` }
            : `DEMO-${product.id}-${Math.random().toString(36).slice(2, 7).toUpperCase()}|demo_user_${i + 1}|Pass${Math.floor(1000 + Math.random() * 9000)}`);
        return {
            status: 201,
            data: { order_id: `DEMO-${Date.now()}`, product: product.name, quantity, charge: (Number(product.price) * quantity).toFixed(2), keys }
        };
    }
    return { status: 404, data: { error: 'not_found', detail: 'Unknown demo endpoint.' } };
}

// One entry point for every Sameeha call. Resolves to { status, data } for any HTTP reply
// (errors included) and throws only when no reply arrived (timeout or network failure).
async function sameehaRequest(method, path, { params, body, timeout } = {}) {
    if (isAccountsDemoMode()) return sameehaDemoReply(method, path, params, body);
    try {
        const response = await sameehaClient.request({ method, url: path, params, data: body, ...(timeout ? { timeout } : {}) });
        return { status: response.status, data: response.data };
    } catch (err) {
        if (err.response) return { status: err.response.status, data: err.response.data || {} };
        throw err;
    }
}

// Live /buy keys can be objects (login fields) rather than strings; String() on one gives "[object Object]"
function formatSameehaKey(key) {
    if (key === null || key === undefined) return '';
    if (typeof key !== 'object') return String(key).trim();
    if (Array.isArray(key)) return key.map(formatSameehaKey).filter(Boolean).join(' | ');
    return Object.entries(key)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([field, value]) => `${field}: ${typeof value === 'object' ? JSON.stringify(value) : String(value).trim()}`)
        .join(' | ');
}

// Reads every page of /products (optionally one category)
async function fetchSameehaProducts(categoryId) {
    const params = categoryId ? { category: categoryId } : {};
    const first = await sameehaRequest('get', '/products', { params: { ...params, page: 1 } });
    if (first.status !== 200) throw new Error(`Sameeha /products replied ${first.status}: ${first.data?.detail || first.data?.message || ''}`);

    const products = [...(first.data.results || [])];
    const pageSize = products.length;
    const pages = pageSize > 0 ? Math.min(Math.ceil((first.data.count || 0) / pageSize), 30) : 1;
    if (pages > 1) {
        const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) =>
            sameehaRequest('get', '/products', { params: { ...params, page: i + 2 } })));
        rest.forEach(page => {
            if (page.status === 200) products.push(...(page.data.results || []));
        });
    }
    return products;
}

// Vendor price + a % markup, rounded up to the naira. Rounding to kobo first stops float noise
// (3500 × 1.1 = 3850.0000000000005) from adding a naira.
const addAccountMarkup = (vendorPriceNGN, pct) => Math.ceil(Math.round(vendorPriceNGN * (1 + pct / 100) * 100) / 100);

// Selling price for one Sameeha product: the admin's fixed amount when set, otherwise Sameeha's price
// plus the global markup %. A fixed amount below the vendor's current price is ignored, so a supplier
// price rise never sells at a loss.
function priceAccountProduct(vendorPriceNGN, override, settings) {
    // 1. The Product's Own Fixed Amount
    const fixedPrice = Number(override?.fixedPriceNGN) || 0;
    if (fixedPrice > 0 && fixedPrice >= vendorPriceNGN) {
        return { priceNGN: Math.round(fixedPrice), pricing: { level: 'product', type: 'fixed', value: Math.round(fixedPrice) }, fixedBelowCost: false };
    }

    // 2. The Global Markup %
    const value = Number(settings?.accountMarkupPercentage) || 0;
    return {
        priceNGN: addAccountMarkup(vendorPriceNGN, value),
        pricing: { level: 'global', type: 'markup', value },
        fixedBelowCost: fixedPrice > 0
    };
}

// --- SMS AUTO-EXPIRY ---
// Refunds SmsNumber orders still pending after 20 minutes. Serverless instances sleep between
// requests, so there's no in-process timer: this runs lazily whenever a user loads their
// profile, orders or an order's details, and from the daily Vercel cron (/api/expire-sms-orders).
const SMS_ACTIVATION_WINDOW_MS = 20 * 60 * 1000; // SMSBower keeps a number open this long, so "Request another code" works until then
const SMS_ORDER_TTL_MS = SMS_ACTIVATION_WINDOW_MS; // One 20-minute window from purchase: the refund deadline and the "another code" deadline are the same

async function expireStaleSmsOrders(extraFilter = {}, limit = 20) {
    const expiredOrders = await Order.find({
        ...extraFilter,
        productType: 'SmsNumber',
        status: 'pending',
        createdAt: { $lte: new Date(Date.now() - SMS_ORDER_TTL_MS) },
        $or: [{ smsCode: { $exists: false } }, { smsCode: null }, { smsCode: '' }]
    }).limit(limit);

    let refunded = 0;
    for (const order of expiredOrders) {
        try {
            const result = await autoCancelAndRefundOrder(order._id, 'Time limit exceeded (20 min) without SMS');
            if (result.success) refunded++;
        } catch (err) {
            console.error(`Auto-expiry failed for order ${order._id}:`, err.message);
        }
    }

    await retryVendorCancels(extraFilter, limit).catch(err => console.error("Vendor Cancel Retry Error:", err.message));
    return { checked: expiredOrders.length, refunded };
}

// Numbers cancelled in their first 2 minutes were refunded before SMSBower would accept the cancel.
// Once that wait is over, cancel them at SMSBower too, so a late code can't be charged to us.
const SMS_EARLY_CANCEL_WAIT_MS = 2 * 60 * 1000;

async function retryVendorCancels(extraFilter = {}, limit = 20) {
    const orders = await Order.find({
        ...extraFilter,
        productType: 'SmsNumber',
        status: 'cancelled',
        'metadata.vendorCancelPending': true,
        createdAt: { $lte: new Date(Date.now() - SMS_EARLY_CANCEL_WAIT_MS) }
    }).limit(limit);

    for (const order of orders) {
        const activeVendorId = order.vendorOrderId || order.metadata?.tzid;
        const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
        let cancelText = '';
        try {
            const cancelRes = await smsBowerClient.get('', { params: { action: 'setStatus', status: 8, id: activeVendorId } });
            cancelText = typeof cancelRes.data === 'string' ? cancelRes.data.trim() : JSON.stringify(cancelRes.data);
        } catch (apiErr) {
            console.warn(`SMS cancel retry failed for ${activeVendorId}:`, apiErr.message);
            continue;
        }

        // Stop retrying once SMSBower confirms, or once the 20-minute activation has closed by itself
        const isDone = SMS_CANCEL_CONFIRMED.includes(cancelText) || orderAgeMs > SMS_ACTIVATION_WINDOW_MS;
        if (!isDone) continue;
        if (!SMS_CANCEL_CONFIRMED.includes(cancelText)) {
            console.warn(`⚠️ SMS cancel never confirmed for refunded order ${order._id} (${activeVendorId}): ${cancelText}`);
        }
        await Order.updateOne({ _id: order._id }, { $set: { 'metadata.vendorCancelPending': false, 'metadata.vendorCancelResult': cancelText } });
    }
}

// --- REQUEST SANITIZATION ---
// Strips keys starting with '$' (and dotted keys) from JSON bodies so a client can't turn
// a value into a Mongo query operator, e.g. { "token": { "$ne": null } }.
function stripMongoOperators(value) {
    if (Array.isArray(value)) return value.map(stripMongoOperators);
    if (value && typeof value === 'object') {
        const clean = {};
        for (const [key, inner] of Object.entries(value)) {
            if (key.startsWith('$') || key.includes('.')) continue;
            clean[key] = stripMongoOperators(inner);
        }
        return clean;
    }
    return value;
}

// --- RATE LIMITING ---
// Fixed-window counter per IP and action, stored in MongoDB (rate_limits collection) so every
// serverless instance shares the same count. Old windows are deleted by a TTL index.
const RATE_LIMITS = {
    'login': { max: 10, windowMs: 15 * 60 * 1000 },
    'user-login': { max: 10, windowMs: 15 * 60 * 1000 },
    'google-login': { max: 20, windowMs: 15 * 60 * 1000 },
    'user-register': { max: 5, windowMs: 60 * 60 * 1000 },
    'verify-otp': { max: 10, windowMs: 15 * 60 * 1000 },
    'forgot-password': { max: 5, windowMs: 60 * 60 * 1000 },
    'admin-forgot-password': { max: 5, windowMs: 60 * 60 * 1000 },
    'reset-password': { max: 10, windowMs: 60 * 60 * 1000 },
    'admin-reset-password': { max: 10, windowMs: 60 * 60 * 1000 },
    'change-password': { max: 10, windowMs: 15 * 60 * 1000 },
    'change-passwords': { max: 10, windowMs: 15 * 60 * 1000 },
    'purchase-with-wallet': { max: 30, windowMs: 60 * 1000 },
    'request-another-code': { max: 20, windowMs: 60 * 1000 },
    'initiate-topup': { max: 20, windowMs: 15 * 60 * 1000 }
};

function getClientIp(req) {
    // Vercel sets x-real-ip to the caller's address; locally fall back to the socket
    return String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
}

async function isRateLimited(req, action) {
    const rule = RATE_LIMITS[action];
    if (!rule) return false;

    const windowStart = Math.floor(Date.now() / rule.windowMs) * rule.windowMs;
    const key = `${action}:${getClientIp(req)}:${windowStart}`;
    const bump = () => RateLimit.findOneAndUpdate(
        { _id: key },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + rule.windowMs) } },
        { upsert: true, returnDocument: 'after' }
    );

    try {
        let bucket;
        try {
            bucket = await bump();
        } catch (err) {
            if (err.code !== 11000) throw err;
            bucket = await bump(); // Two first requests raced on the upsert; the retry increments
        }
        return bucket.count > rule.max;
    } catch (err) {
        // Fail open: a limiter outage shouldn't lock every user out of login
        console.error("Rate Limit Error:", err.message);
        return false;
    }
}

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') req.body = stripMongoOperators(req.body);
    next();
});

// --- 1. SERVE STATIC FILES ---
// ⚠️ CRITICAL: Only public folders and files are listed here. Never serve __dirname itself:
// it would hand out api.js, package.json and CLAUDE.md to anyone who asks.

app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});

app.get(['/', '/index', '/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Clean page URLs -> HTML files. Keep in step with "rewrites" and "redirects" in vercel.json.
const PAGE_ROUTES = {
    // Draft landing page, to replace index.html once approved
    '/home': 'home.html',
    // User portal
    '/login': 'smsuser/login.html',
    '/register': 'smsuser/register.html',
    '/forgot-password': 'smsuser/forgot-password.html',
    '/reset-password': 'smsuser/reset-password.html',
    '/dashboard': 'smsuser/dashboard.html',
    '/fund-wallet': 'smsuser/fund-wallet.html',
    '/virtual-numbers': 'smsuser/virtual-numbers.html',
    '/vpn': 'smsuser/vpn.html',
    '/proxies': 'smsuser/proxies.html',
    '/accounts': 'smsuser/accounts.html',
    '/esim-refill': 'smsuser/esim-refill.html',
    '/esim-activation': 'smsuser/esim-activation.html',
    '/rdp': 'smsuser/rdp.html',
    '/orders': 'smsuser/orders.html',
    '/profile': 'smsuser/profile.html',
    '/gifts': 'smsuser/gifts.html',
    '/support': 'smsuser/support.html',
    '/terms': 'smsuser/terms.html',
    '/privacy': 'smsuser/privacy.html',
    '/maintenance': 'smsuser/maintenance.html',
    // Admin suite
    '/admin/login': 'smsadmin/login.html',
    '/admin/forgot-password': 'smsadmin/forgot-password.html',
    '/admin/reset-password': 'smsadmin/reset-password.html',
    '/admin/dashboard': 'smsadmin/dashboard.html',
    '/admin/daily-changes': 'smsadmin/daily-changes.html',
    '/admin/user-activity': 'smsadmin/user-activity.html',
    '/admin/users': 'smsadmin/users.html',
    '/admin/sms-numbers': 'smsadmin/sms-numbers.html',
    '/admin/accounts': 'smsadmin/accounts.html',
    '/admin/vpn': 'smsadmin/vpn.html',
    '/admin/proxies': 'smsadmin/proxies.html',
    '/admin/esim-refills': 'smsadmin/esim-refills.html',
    '/admin/esim-activations': 'smsadmin/esim-activations.html',
    '/admin/rdp': 'smsadmin/rdp.html',
    '/admin/transactions': 'smsadmin/transactions.html',
    '/admin/settings': 'smsadmin/settings.html',
    '/admin/user-view': 'smsadmin/user-view.html',
};

// Old file URLs (/smsuser/user_login.html, /smsadmin/sms_dashboard...) -> clean URL
const LEGACY_PAGE_REDIRECTS = Object.assign(Object.fromEntries(
    Object.entries(PAGE_ROUTES).map(([url, file]) => [file.replace(/\.html$/, ''), url])
), {
    'smsuser/user_login': '/login',
    'smsuser/user_create': '/register',
    'smsuser/change-password': '/reset-password',
    'smsuser/user_dashboard': '/dashboard',
    'smsuser/topup': '/fund-wallet',
    'smsuser/sms_number': '/virtual-numbers',
    'smsuser/user_vpn': '/vpn',
    'smsuser/user_proxy': '/proxies',
    'smsuser/user_accounts': '/accounts',
    'smsuser/esim_refill': '/esim-refill',
    'smsuser/esim_activation': '/esim-activation',
    'smsuser/user_rdp': '/rdp',
    'smsuser/order_history': '/orders',
    'smsuser/user_profile': '/profile',
    'smsuser/send_gifts': '/gifts',
    'smsadmin/sms_login': '/admin/login',
    'smsadmin/sms_create': '/admin/login', // Admin sign-up was removed; admins are made from the Users page
    'smsadmin/request_password': '/admin/forgot-password',
    'smsadmin/sms_forgot': '/admin/reset-password',
    'smsadmin/sms_dashboard': '/admin/dashboard',
    'smsadmin/sms_users': '/admin/users',
    'smsadmin/sms_numbers': '/admin/sms-numbers',
    'smsadmin/sms_accounts': '/admin/accounts',
    'smsadmin/sms_vpn': '/admin/vpn',
    'smsadmin/sms_proxy': '/admin/proxies',
    'smsadmin/esims_refill': '/admin/esim-refills',
    'smsadmin/esims_activation': '/admin/esim-activations',
    'smsadmin/rdp_request': '/admin/rdp',
    'smsadmin/transaction_history': '/admin/transactions',
}); // Pre-rename file names, kept for old emails and bookmarks

for (const [url, file] of Object.entries(PAGE_ROUTES)) {
    app.get(url, (req, res) => res.sendFile(path.join(__dirname, file)));
}

app.get('/admin', (req, res) => res.redirect(301, '/admin/dashboard'));
app.get('/admin/register', (req, res) => res.redirect(301, '/admin/login')); // Old public admin sign-up

app.get(['/smsuser/:page', '/smsadmin/:page'], (req, res, next) => {
    const folder = req.path.startsWith('/smsadmin/') ? 'smsadmin' : 'smsuser';
    const target = LEGACY_PAGE_REDIRECTS[`${folder}/${req.params.page.replace(/\.html?$/, '')}`];
    if (!target) return next();
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(301, target + query); // Keeps ?token= and ?ref= from old emails and links
});

app.get('/sitemap.xml', (req, res) => {
    res.sendFile(path.join(__dirname, 'sitemap.xml'));
});

app.get('/robots.txt', (req, res) => {
    res.sendFile(path.join(__dirname, 'robots.txt'));
});

const JWT_SECRET = process.env.JWT_SECRET;
const SMSBOWER_BASE_URL = 'https://smsbower.page/stubs/handler_api.php';
const SMSBOWER_API_KEY = process.env.SMSBOWER_API_KEY;

const adminSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date }
}, { timestamps: true });

const Admin = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

const userSchema = new mongoose.Schema({
    fullName: { type: String, required: [true, "Full name is required"], trim: true },
    email: { 
        type: String, 
        required: [true, "Email is required"], 
        unique: true, 
        lowercase: true, 
        trim: true,
        match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please fill a valid email address']
    },
    password: { type: String, required: [true, "Password is required"], select: false },
    hasPassword: { type: Boolean, default: true }, // False for Google signups (random password) until they reset it
    isVerified: { type: Boolean, default: false },
    otpCode: { type: String },
    otpExpires: { type: Date },
    otpAttempts: { type: Number, default: 0 }, // Wrong guesses against the current code
    balance: { type: Number, default: 0, min: [0, "Balance cannot be negative"] },   
    bonusBalance: { type: Number, default: 0 },    
    hasDeposited: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    suspendedAt: { type: Date }, // Set with status 'suspended', cleared on activate
    suspendedReason: { type: String }, // Admin's note on why, shown on the users page
    referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    referredBy: { type: String, default: null, index: true },
    referralCount: { type: Number, default: 0 },
    // Referral lifecycle for this user as a referee: 'pending' once verified, 'qualified' after a
    // big enough first top-up, 'credited' once the referrer has been counted. Unset on accounts
    // counted by the old verify-time logic, so they are never counted twice.
    referralStatus: { type: String, enum: ['pending', 'qualified', 'credited'] },
    resetPasswordToken: String,
    resetPasswordExpires: Date
}, { timestamps: true });

userSchema.index({ email: 1, referralCode: 1 });
const User = mongoose.models.User || mongoose.model('User', userSchema);

// --- SYSTEM SETTINGS (Exchange Rate Removed) ---
const systemSettingsSchema = new mongoose.Schema({
    maintenanceMode: { type: Boolean, default: false },
    allowSignups: { type: Boolean, default: true },    
    globalMarkup: { type: Number, default: 0 }, 
    smsMarkupPercentage: { type: Number, default: 0 }, // Applied to SMS number prices only
    smsFloorPriceNGN: { type: Number, default: 0, min: 0 }, // Lowest marked-up SMS price (fixed prices ignore it)
    accountMarkupPercentage: { type: Number, default: 0, min: 0 }, // Applied to Sameeha accounts & VPN without their own price
    usdToNgnRate: { type: Number, default: 1400, min: 1 }, // Converts SMSBower USD prices to NGN
    noticeBarText: { type: String, default: "Welcome to DeemaxHub!" },
    supportWhatsapp: { type: String, default: "" },
    referralBonusNGN: { type: Number, default: 3000, min: 0 }, // Paid into bonus balance at each milestone
    referralMilestone: { type: Number, default: 10, min: 1 }, // Qualified referrals per bonus
    referralMinDepositNGN: { type: Number, default: 1000, min: 0 } // A referee's top-up must reach this to count
}, { timestamps: true });

const SystemSettings = mongoose.models.SystemSettings || mongoose.model('SystemSettings', systemSettingsSchema, 'system_settings');

const vpnSchema = new mongoose.Schema({
    name: { type: String, required: true },
    provider: { type: String, required: true },
    region: { type: String, required: true },
    image: String,   
    deviceType: { type: String, enum: ['Phone', 'PC', 'Both'], default: 'Phone' },
    stock: { type: Number, default: 0 },
    deviceLimit: { type: Number, default: 1 },
    plans: [{
        duration: { type: String, required: true },
        price: { type: Number, required: true }
    }],        
    
    phoneAccounts: [{
        username: { type: String },
        password: { type: String }
    }],

    pcMethod: { type: String, enum: ['userpass', 'code'] }, 
    pcAccounts: [{
        username: { type: String }, // Used if method is 'userpass'
        password: { type: String }, // Used if method is 'userpass'
        activationCode: { type: String } // Used if method is 'code'
    }],

    instructions: { type: String }
}, { timestamps: true });

vpnSchema.pre('save', async function() {
    const phoneCount = this.phoneAccounts ? this.phoneAccounts.length : 0;
    const pcCount = this.pcAccounts ? this.pcAccounts.length : 0;    
    this.stock = phoneCount + pcCount;
    
});

const VPN = mongoose.models.VPN || mongoose.model('VPN', vpnSchema);

const ProxySchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, default: 'Standard' },
    stock: { type: Number, default: 0 },
    plans: [{
        ip_count: { type: Number, required: true },
        price: { type: Number, required: true } 
    }],
    activationCode: String, // Single code (for UI preview)
    activationCodes: [String], // Full inventory, popped one per sale
    imageUrl: String,
    instructions: { type: String, default: "Check dashboard for details." }
}, { timestamps: true });

const Proxy = mongoose.models.Proxy || mongoose.model('Proxy', ProxySchema);


const rdpSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userEmail: String,
    fullName: String,
    productType: { type: String, default: "RDP" },
    planName: String,
    nodeName: String, 
    ram: String, 
    cpu: String, 
    storage: String, 
    net: String, 
    os: String,
    amount: Number,
    receiptUrl: String,
    extraCPU: { type: Number, default: 0 },
    extraStorage: { type: Number, default: 0 },
    currency: { type: String, default: "NGN" },
    status: { type: String, default: "successful" },
    paymentReference: String,
    ipAddress: { type: String, default: "N/A" },
    port: { type: String, default: "3389" },
    rdpUsername: { type: String, default: "Admin" },
    rdpPassword: { type: String },
    confirmationNumber: { type: String },
    metadata: { 
        extraCPU: Number, 
        extraStorage: Number, 
        osChoice: String,
        ram: String,
        cpu: String,
        storage: String
    }
}, { timestamps: true });

const RDP = mongoose.models.RDP || mongoose.model('RDP', rdpSchema, 'rdp_orders');

const esimRefillSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, required: true, index: true },
    fullName: { type: String },    
    carrier: {
        id: { type: String, required: true }, 
        name: { type: String, required: true }, 
        image: { type: String } 
    },
    target: {
        number: { type: String, required: true }, // The phone number being topped up
        country: { type: String, required: true } // The coverage country
    },
    amount: { type: Number, required: true }, // Total cost in NGN
    currency: { type: String, default: 'NGN' },
    mainBalanceUsed: { type: Number, default: 0 },
    bonusBalanceUsed: { type: Number, default: 0 },
    paymentReference: { type: String, unique: true, required: true }, // WAL- or ESIM- prefix    
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'successful', 'failed', 'completed'], 
        default: 'pending',
        index: true 
    },
    confirmationNumber: { type: String }, 
    receiptUrl: String,
    adminNote: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

esimRefillSchema.index({ createdAt: -1 });
const EsimRefill = mongoose.models.EsimRefill || mongoose.model('EsimRefill', esimRefillSchema, 'esim_refills');

// --- eSIM ACTIVATION SCHEMA ---
const esimActivationSchema = new mongoose.Schema({
    // User Identity
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, required: true, index: true },
    
    customerDetails: {
        firstName: { type: String, required: true },
        lastName: { type: String, required: true },
        address: { type: String },
        zipCode: { type: String },
        email: { type: String } // The specific activation email provided in the form
    },
    carrier: {
        name: { type: String, required: true }, // e.g., T-Mobile, AT&T
        image: { type: String } 
    },
    receiptUrl: String,
    activationType: { type: String, required: true }, // e.g., 'Prepaid', 'Data-Only'
    deviceName: { type: String, required: true },    // The device name/model provided in 'targetNumber' field
    amount: { type: Number, required: true }, 
    mainBalanceUsed: { type: Number, default: 0 },
    bonusBalanceUsed: { type: Number, default: 0 },
    paymentReference: { type: String, unique: true, required: true }, // e.g., ACT-XXXXX
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'successful', 'failed', 'completed'], 
        default: 'pending',
        index: true 
    },
    adminNote: { type: String },    
    metadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

esimActivationSchema.index({ createdAt: -1 });
const EsimActivation = mongoose.models.EsimActivation || mongoose.model('EsimActivation', esimActivationSchema, 'esim_activations');


const smsNumberSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, required: true },
    
    // Vendor Identity (SMSBower)
    vendorOrderId: { type: String, index: true }, // Order ID / Tzid returned by SMSBower
    countryId: { type: String }, // Country code/ID selected
    phoneNumber: { type: String }, // The virtual number assigned
    serviceName: { type: String, required: true }, // e.g., 'WhatsApp', 'Telegram'
    
    // Order Details
    amount: { type: Number, required: true }, // Final markup-adjusted price charged
    status: { 
        type: String, 
        enum: ['pending', 'completed', 'expired', 'failed'], 
        default: 'pending',
        index: true 
    },
    
    smsCode: { type: String }, // The extracted 4-6 digit code
    fullMessage: { type: String }, // The raw SMS text for backup
    
    expiresAt: { 
        type: Date, 
        default: () => new Date(+new Date() + 20 * 60 * 1000) // Auto-expire after 20 mins
    }
}, { timestamps: true });

smsNumberSchema.index({ vendorOrderId: 1, status: 1, createdAt: -1 });

const SmsNumber = mongoose.models.SmsNumber || mongoose.model('SmsNumber', smsNumberSchema);

// --- SMS POOL OVERRIDE SCHEMA ---
// The admin's fixed SMSBower operator for one service + country. Without a row, prices and
// purchases use the automatic pool (see getSmsCountryPrices).
const smsPoolOverrideSchema = new mongoose.Schema({
    serviceCode: { type: String, required: true, lowercase: true, trim: true }, // e.g. 'wa'
    serviceName: { type: String }, // Display only
    countryId: { type: String, required: true, trim: true }, // SMSBower country ID, e.g. '16'
    countryName: { type: String }, // Display only
    operatorId: { type: String, required: true, trim: true }, // SMSBower provider_id to buy from
    updatedBy: { type: String } // Email of the admin who last saved it
}, { timestamps: true });

smsPoolOverrideSchema.index({ serviceCode: 1, countryId: 1 }, { unique: true });

const SmsPoolOverride = mongoose.models.SmsPoolOverride || mongoose.model('SmsPoolOverride', smsPoolOverrideSchema, 'sms_pool_overrides');

// --- SMS PRICE OVERRIDE SCHEMA ---
// The admin's price for one service + country, one whole service ('*' country) or one whole
// country ('*' service). Without a matching row, numbers sell at cost + smsMarkupPercentage
// (see resolveSmsTierPrice for which row wins).
const SMS_ANY = '*'; // "All services" / "All countries"
const smsPriceOverrideSchema = new mongoose.Schema({
    serviceCode: { type: String, required: true, lowercase: true, trim: true }, // e.g. 'wa', or '*'
    serviceName: { type: String }, // Display only
    countryId: { type: String, required: true, trim: true }, // SMSBower country ID, or '*'
    countryName: { type: String }, // Display only
    pricingType: { type: String, enum: ['markup', 'fixed'], required: true },
    markupPercentage: { type: Number, default: null }, // Used when pricingType is 'markup'
    fixedPriceNGN: { type: Number, default: null }, // Used when pricingType is 'fixed' (ignored below cost)
    updatedBy: { type: String } // Email of the admin who last saved it
}, { timestamps: true });

smsPriceOverrideSchema.index({ serviceCode: 1, countryId: 1 }, { unique: true });

const SmsPriceOverride = mongoose.models.SmsPriceOverride || mongoose.model('SmsPriceOverride', smsPriceOverrideSchema, 'sms_price_overrides');

// --- ACCOUNT PRICE SCHEMA ---
// The admin's settings for one Sameeha product. Without a fixed amount, the product sells at
// vendor price + the global markup (see priceAccountProduct).
const accountPriceSchema = new mongoose.Schema({
    vendorProductId: { type: Number, required: true, unique: true }, // Sameeha product id
    productName: { type: String }, // Display only
    fixedPriceNGN: { type: Number, min: 0 }, // Fixed selling price; empty means the global markup (ignored below cost)
    hidden: { type: Boolean, default: false }, // Hidden products are not listed or sold
    updatedBy: { type: String } // Email of the admin who last saved it
}, { timestamps: true });

const AccountPrice = mongoose.models.AccountPrice || mongoose.model('AccountPrice', accountPriceSchema, 'account_prices');

// --- TRANSACTION SCHEMA ---
const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    purpose: { type: String, enum: ['deposit', 'purchase', 'refund', 'referral_bonus', 'admin_debit'], required: true },
    amountNGN: { type: Number, required: true, set: v => Math.round(v * 100) / 100 },
    status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'pending', index: true },
    reference: { type: String, unique: true, required: true, trim: true },
    paymentMethod: { type: String, default: 'wallet' },     
    balanceBefore: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },
    bonusBefore: { type: Number, default: 0 }, // New field
    bonusAfter: { type: Number, default: 0 },  // New field

    metadata: { type: mongoose.Schema.Types.Mixed } 
}, { timestamps: true });

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
const orderSchema = new mongoose.Schema({
    userEmail: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    fullName: { type: String },        
    productType: { 
        type: String, 
        enum: ['VPN', 'Proxy', 'eSIM', 'eSIM_Refill', 'eSIM_Activation', 'RDP', 'RentedNumber', 'SmsNumber', 'Account'],
        required: true 
    },
    vendorOrderId: { type: String, index: true },
    
    // --- ADD SERVICE NAME & CODE FIELDS HERE ---
    serviceName: { type: String }, // e.g., 'WhatsApp', 'Telegram'
    serviceCode: { type: String }, // e.g., 'wa', 'tg'
    // -------------------------------------------

    planName: String, 
    nodeName: String, 
    amount: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },        
    mainBalanceUsed: { type: Number, default: 0 }, 
    bonusBalanceUsed: { type: Number, default: 0 }, 
    status: { 
        type: String, 
        enum: ['pending', 'processing', 'successful', 'failed', 'completed', 'cancelled'], 
        default: 'pending' 
    },
    paymentReference: { type: String, unique: true },    
    targetNumber: String, 
    country: String,
    
    smsCode: { type: String },
    fullMessage: { type: String },

    target: {
        number: String,
        country: String
    },
    carrier: {
        id: String,
        name: String,
        image: String
    },
    confirmationNumber: { type: String },
    instructions: String, 
    adminNote: String, 
    receiptUrl: String,
    ram: String,
    cpu: String, 
    storage: String,
    net: String, 
    os: String,
    ipAddress: String,    
    port: { type: String, default: '3389' }, 
    rdpUsername: String,  
    rdpPassword: String,  
    deliveredAt: Date,
    extraCPU: { type: Number, default: 0 },
    extraStorage: { type: Number, default: 0 },    
    activationCode: String, 
    vpnCredentials: { username: String, password: { type: String } },
    pcUsername: String,
    pcPassword: String,
    pcMethod: String,
    refundedAt: Date, // Set once when the wallet is refunded, so a refund can never run twice
    metadata: { type: mongoose.Schema.Types.Mixed }

}, { timestamps: true });

orderSchema.index({ createdAt: -1 });
orderSchema.index({ productType: 1, status: 1, createdAt: -1 }); // Cron expiry and admin eSIM/RDP lists
orderSchema.index({ userId: 1, createdAt: -1 }); // Per-user lookups (cancel, refund, history)
orderSchema.index({ 'metadata.tzid': 1 }, { sparse: true }); // SMS activation lookups

const Order =mongoose.models.Order || mongoose.model('Order', orderSchema);

// One document per action + IP + time window (see isRateLimited)
const rateLimitSchema = new mongoose.Schema({
    _id: { type: String }, // `${action}:${ip}:${windowStart}`
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });

rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo deletes finished windows

const RateLimit = mongoose.models.RateLimit || mongoose.model('RateLimit', rateLimitSchema, 'rate_limits');

// --- PURCHASE ATTEMPT SCHEMA ---
// A wallet purchase that failed before producing an order (vendor out of funds or stock,
// low balance, supplier error...). Written by trackPurchaseAttempt for the admin User Activity page.
const purchaseAttemptSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userEmail: { type: String },
    productType: { type: String }, // Order productType the user tried to buy, when known
    reason: { type: String, required: true }, // Machine code, e.g. 'provider_out_of_funds'
    message: { type: String, default: '' }, // What the user was told
    httpStatus: { type: Number },
    label: { type: String }, // Service or product name
    country: { type: String },
    amount: { type: Number } // Price in NGN they'd have paid, when known
}, { timestamps: true });

purchaseAttemptSchema.index({ createdAt: -1 });
purchaseAttemptSchema.index({ userId: 1, createdAt: -1 });

const PurchaseAttempt = mongoose.models.PurchaseAttempt || mongoose.model('PurchaseAttempt', purchaseAttemptSchema, 'purchase_attempts');

// --- TOP-UP INTENT SCHEMA ---
// What initiate-topup asked Flutterwave to charge and what it will credit, keyed by tx_ref.
// settleFlutterwaveTopup takes the user and both amounts from here, never from the payment's
// meta: anyone holding the public key can open a Flutterwave checkout with any meta they like.
const topupIntentSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true }, // The TOPUP-... tx_ref sent to Flutterwave
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    creditNGN: { type: Number, required: true }, // Lands in the wallet
    chargeNGN: { type: Number, required: true } // The user must pay at least this (credit + top-up fee)
}, { timestamps: true });

const TopupIntent = mongoose.models.TopupIntent || mongoose.model('TopupIntent', topupIntentSchema, 'topup_intents');

let isConnected = false;

let connectPromise = null; // One shared attempt, so parallel requests don't each start their own

mongoose.connection.on('disconnected', () => { isConnected = false; });

const connectDB = async () => {
    if (mongoose.connection.readyState === 1) {
        isConnected = true;
        return;
    }

    // 1. Start An Attempt Only If None Is Already Running
    if (!connectPromise) {
        connectPromise = mongoose.connect(process.env.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 10000, // Cold starts to Atlas can take over 5s
            socketTimeoutMS: 45000,
            autoSelectFamily: false, // Prevents IPv6 handshake issues on serverless
        }).then(() => {
            isConnected = true;
        }).catch(async (err) => {
            isConnected = false;
            console.error("DB Error:", err);
            // 2. Drop The Failed Client, Otherwise Later Attempts Can Stay Stuck On It
            try { await mongoose.disconnect(); } catch (closeErr) { /* Nothing to close */ }
            throw err;
        }).finally(() => {
            connectPromise = null;
        });
    }

    // 3. Every Waiting Request Shares The Same Result
    return connectPromise;
};

async function getCountriesMeta() {
    const NOW = Date.now();
    if (cachedCountriesMeta && (NOW - lastMetaFetchTime < META_CACHE_TTL)) {
        return cachedCountriesMeta;
    }
    
    try {
        const response = await smsBowerClient.get('', { params: { action: 'getCountries' } });
        cachedCountriesMeta = response?.data;
        lastMetaFetchTime = NOW;
        return cachedCountriesMeta;
    } catch (err) {
        if (cachedCountriesMeta) return cachedCountriesMeta;
        throw err;
    }
}

// --- 4. HELPERS ---
function getBearerToken(req) {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
}

// Status -> reason when the purchase handler didn't name a more specific one
const ATTEMPT_REASON_BY_STATUS = {
    400: 'rejected',
    403: 'unverified',
    404: 'unavailable',
    429: 'duplicate',
    502: 'provider_error',
    503: 'provider_unavailable'
};

/**
 * Failed-purchase recorder for the admin User Activity page (ported from DanSMS).
 * Call once at the top of a purchase handler, then fill fields in as they become known:
 *
 *   const attempt = trackPurchaseAttempt(res);
 *   attempt.user = user;                    // nothing is recorded without a user
 *   attempt.reason = 'provider_out_of_funds';
 *
 * It hooks res.json, so every reply with status >= 400 is saved with the message the user saw,
 * and a new failure path is recorded without anyone remembering to. The reply waits for the
 * write (at most 1.5 seconds) because a serverless instance is frozen once it has answered.
 * A failed write is logged and never affects the purchase.
 */
function trackPurchaseAttempt(res) {
    const attempt = {};
    const sendJson = res.json.bind(res);

    res.json = (payload) => {
        if (res.statusCode < 400 || !attempt.user || attempt.skip) return sendJson(payload);

        const write = PurchaseAttempt.create({
            userId: attempt.user._id,
            userEmail: attempt.user.email,
            productType: attempt.productType || null,
            reason: String(attempt.reason || ATTEMPT_REASON_BY_STATUS[res.statusCode] || 'error').slice(0, 64),
            message: String(payload?.message || '').slice(0, 500),
            httpStatus: res.statusCode,
            label: attempt.label ? String(attempt.label).slice(0, 200) : null,
            country: attempt.country ? String(attempt.country).slice(0, 80) : null,
            amount: Number.isFinite(Number(attempt.amount)) && attempt.amount !== null ? Math.round(Number(attempt.amount)) : null
        }).catch(err => console.error("Purchase Attempt Log Error:", err.message));

        Promise.race([write, new Promise(resolve => setTimeout(resolve, 1500))]).finally(() => sendJson(payload));
        return res;
    };

    return attempt;
}

/**
 * Verifies the admin JWT against a real Admin record.
 * Returns the admin, or sends a 401 and returns null.
 */
async function requireAdmin(req, res) {
    const token = getBearerToken(req);
    if (!token) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return null;
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        res.status(401).json({ success: false, message: "Session expired. Please log in again." });
        return null;
    }

    const admin = decoded.role === 'admin' && mongoose.isValidObjectId(decoded.id)
        ? await Admin.findById(decoded.id)
        : null;

    if (!admin) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return null;
    }
    return admin;
}

/**
 * Verifies a user JWT and loads the active user.
 * Returns the user, or sends 401/403/404 and returns null.
 */
async function requireUser(req, res, select = '') {
    const token = getBearerToken(req);
    if (!token) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return null;
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        res.status(401).json({ success: false, message: "Unauthorized or expired session" });
        return null;
    }

    if (decoded.role === 'admin' || !mongoose.isValidObjectId(decoded.id)) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return null;
    }

    const user = await User.findById(decoded.id).select(select);
    if (!user) {
        res.status(404).json({ success: false, message: "User not found" });
        return null;
    }
    if (user.status === 'suspended') {
        res.status(403).json({ success: false, message: "Your account has been suspended. Contact support.", isSuspended: true, status: 'suspended' });
        return null;
    }
    return user;
}

// Same 24h token shape as handleUserLogin, shared by every flow that signs a user in
function buildUserSession(user) {
    const token = jwt.sign(
        { id: user._id, email: user.email, type: 'user' },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
    return {
        token,
        user: {
            name: user.fullName,
            email: user.email,
            balance: user.balance || 0,
            bonusBalance: user.bonusBalance || 0,
            hasDeposited: user.hasDeposited || false,
            referralCount: user.referralCount || 0,
            referralCode: user.referralCode
        }
    };
}

// Admins sign in on the normal /login page too. Call this only after the user is fully
// signed in (verified, not suspended): an Admin record with the same email gets an admin
// session instead of the user one (see signInResponse). `proof` says how the sign-in proved it is the admin:
//   { password } - the password typed at /login; it must also match the Admin record
//   { google: true } - Google confirmed the person owns the admin's email address
// ⚠️ CRITICAL: A matching email alone is never enough. A customer account can be pre-registered
// with someone else's email, has a weaker password rule and its own reset link.
async function buildAdminSessionFor(user, proof = {}) {
    const email = String(user.email || '').toLowerCase();
    if (!email) return null;
    const admin = await Admin.findOne({ email: { $in: [user.email, email] } });
    if (!admin) return null;

    const isProven = proof.google === true ||
        (typeof proof.password === 'string' && await bcrypt.compare(proof.password, admin.password));
    if (!isProven) return null;

    return jwt.sign(
        { id: admin._id, email: admin.email, role: 'admin' },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

// Promoted admins only get the admin side (owner's decision, 2026-10-23): a sign-in that proves
// the admin role returns the admin session and no customer session. Admins still shop through User View.
function signInResponse(user, adminToken) {
    if (adminToken) return { success: true, adminOnly: true, adminToken };
    return { success: true, ...buildUserSession(user) };
}

// Password reset tokens are stored as this hash and only the emailed link holds the raw token,
// so someone who can read the database can't use a pending reset. SHA-256 is enough: the token
// is 32 random bytes, so there is nothing to guess.
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Escapes user-supplied text before it goes into an HTML email
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// Only allows http(s) links into emails (blocks javascript: URLs)
function safeUrl(value) {
    const url = String(value || '');
    return /^https?:\/\//i.test(url) ? escapeHtml(url) : '';
}

/**
 * Runs a Mongo transaction, retrying when Atlas drops for a moment.
 * Used after a vendor sale, where giving up means refunding goods already bought.
 * Only errors Mongo labels as transient are retried: those are guaranteed not to
 * have committed, so a retry can never write the order twice.
 */
async function runTransactionWithRetry(work, attempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let session;
        try {
            await connectDB(); // Reconnects if the last attempt lost the connection
            session = await mongoose.startSession();
            session.startTransaction();
            const result = await work(session);
            await session.commitTransaction();
            return result;
        } catch (err) {
            lastErr = err;
            if (session) await session.abortTransaction().catch(() => {});
            const isTransient = err?.hasErrorLabel?.('TransientTransactionError') || err?.name === 'MongooseServerSelectionError';
            if (!isTransient || attempt === attempts) break;
            console.warn(`Transaction attempt ${attempt} failed (${err.message}). Retrying...`);
            await new Promise(resolve => setTimeout(resolve, 750 * attempt)); // 0.75s, then 1.5s
        } finally {
            if (session) session.endSession();
        }
    }
    throw lastErr;
}

async function getUsdToNgnRate() {
    const settings = await getSystemSettingsCached();
    return Number(settings?.usdToNgnRate) > 0 ? Number(settings.usdToNgnRate) : 1400;
}

async function generateUniqueCode() {
    let isUnique = false;
    let code = "";
    while (!isUnique) {
        code = crypto.randomBytes(3).toString('hex').toUpperCase();
        const existing = await User.findOne({ referralCode: code });
        if (!existing) isUnique = true;
    }
    return code;
}

function normalizeDeviceType(type) {
    if (!type) return 'Phone';
    const t = type.toLowerCase();
    if (t === 'phone') return 'Phone';
    if (t === 'pc') return 'PC';
    if (t === 'both') return 'Both';
    return 'Phone'; // Default fallback
}

// --- EMAIL TRANSPORT ---
// SendByte SMTP when SMTP_HOST is set, otherwise the old Gmail account (EMAIL_USER / EMAIL_PASS)
function createMailTransporter(extraOptions = {}) {
    if (process.env.SMTP_HOST) {
        const port = Number(process.env.SMTP_PORT) || 587;
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure: port === 465, // 587 and 2525 upgrade with STARTTLS
            auth: {
                user: process.env.SMTP_USER || 'apikey',
                pass: process.env.SMTP_PASS
            },
            ...extraOptions
        });
    }

    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        ...extraOptions
    });
}

// Sender header, e.g. "DeemaxHub Support" <noreply@deemaxhub.com>. SendByte only sends from a verified domain
function mailFrom(name) {
    const address = process.env.EMAIL_FROM || process.env.EMAIL_USER;
    return `"${name}" <${address}>`;
}

const transporter = createMailTransporter();

// Actions that only an authenticated admin may call (any method)
const ADMIN_ACTIONS = new Set([
    'dashboard-stats', 'get-users', 'manage-user', 'user-footprint', 'transactions',
    'esim-refills', 'update-esim-status', 'esim-activation', 'esim-activations',
    'esim-activation-complete', 'update-esim-activation', 'rdps',
    'rdp-requests', 'rdp-request-complete', 'update-system-settings',
    'get-system-settings', 'system-settings', 'upload-receipt', 'wallet-check',
    'sms-pool-overrides', 'sms-price-overrides', 'sms-country-list', 'sms-operators', 'admin-sms-orders', 'admin-account-orders', 'admin-deposits', 'sms-stats', 'smsbower-balance',
    'sameeha-balance', 'admin-account-products', 'account-prices', 'daily-stats', 'user-activity',
    'admin-user-session', 'admin-wallet'
]);

// Catalog actions: anyone may read, only admins may write
const ADMIN_WRITE_ACTIONS = new Set(['products', 'proxies']);

app.all(['/api/:action', '/:action'], async (req, res) => {
    let action = req.params.action;
    if (!action && req.url) {
        const parts = req.url.split('?')[0].split('/').filter(Boolean);
        action = parts[0] === 'api' ? parts[1] : parts[0];
    }

    action = (action || '').toLowerCase().trim();
    console.log("Incoming Action:", action, "Method:", req.method, "URL:", req.url.split('?')[0]);

    // DB-FREE ACTIONS (answered even while the database is slow or unreachable)
    if (action === 'status') {
        return res.json({ success: true, message: "DeemaxHub API Active", db: isConnected });
    }
    if (action === 'demo-login-status') return handleDemoLoginStatus(req, res);

    try {
        await connectDB();
    } catch (err) {
        return res.status(503).json({ success: false, message: "Service temporarily unavailable. Please try again." });
    }

    if (await isRateLimited(req, action)) {
        return res.status(429).json({ success: false, message: "Too many attempts. Please wait a few minutes and try again." });
    }

    // ADMIN GATE
    const needsAdmin = ADMIN_ACTIONS.has(action) || (ADMIN_WRITE_ACTIONS.has(action) && req.method !== 'GET');
    if (needsAdmin) {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        req.admin = admin;
    }

    switch (action) {
        case 'login': return handleLogin(req, res);
        case 'demo-login':
            if (req.method === 'POST') return handleDemoLogin(req, res);
            break;
        case 'google-login': return handleGoogleLogin(req, res);
        case 'dashboard-stats': return handleDashboardStats(req, res);
        case 'get-users': return handleGetUsers(req, res);
        case 'manage-user': return handleManageUser(req, res);
        case 'user-footprint':
            if (req.method === 'GET') return handleGetUserFootprint(req, res);
            break;
        case 'admin-credit-user':
            if (req.method === 'POST') return handleAdminCreditUser(req, res);
            break;
        case 'admin-user-session':
            if (req.method === 'POST') return handleAdminUserSession(req, res);
            break;
        case 'admin-wallet':
            if (req.method === 'GET') return handleGetAdminWallet(req, res);
            break;
        case 'products':
            if (req.method === 'GET') return handleGetVPNs(req, res);
            if (req.method === 'POST') return handleAddVPN(req, res);
            if (req.method === 'PATCH') return handleUpdateVPN(req, res);
            if (req.method === 'DELETE') return handleDeleteVPN(req, res);
            break;
        case 'user-register': return handleUserRegister(req, res);
        case 'verify-otp': return handleVerifyOTP(req, res);
        case 'user-login': return handleUserLogin(req, res);
        case 'user-profile': return handleGetUserProfile(req, res);
        case 'user-orders': return handleGetUserOrders(req, res);
        case 'sms-receive': return handleSmsBowerWebhook(req, res);
        case 'order-details': return handleGetOrderDetails(req, res);
        case 'change-password': return handleChangePassword(req, res);
        case 'forgot-password': return handleForgotPasswordRequest(req, res);
        case 'reset-password': return handleResetPassword(req, res);
        case 'initiate-topup': return handleInitiateTopup(req, res);
        case 'verify-topup': return handleVerifyTopup(req, res);
        case 'flutterwave-webhook':
            if (req.method === 'POST') return handleFlutterwaveWebhook(req, res);
            break;
        case 'purchase-with-wallet': return handlePurchaseWithWallet(req, res);
        case 'recheck-sms': return handleRecheckSms(req, res);
        case 'request-another-code':
            if (req.method === 'POST') return handleRequestAnotherCode(req, res);
            break;
        case 'cancel-order': return handleCancelOrder(req, res);
        case 'expire-sms-orders': return handleExpireSmsOrders(req, res);
        case 'proxies':
            if (req.method === 'GET') return handleGetProxies(req, res);
            if (req.method === 'POST') return handleAddProxy(req, res);
            if (req.method === 'PATCH') return handleUpdateProxy(req, res);
            if (req.method === 'DELETE') return handleDeleteProxy(req, res);
            break;
        case 'transactions': return handleAllTransactions(req, res);
        case 'wallet-check':
            if (req.method === 'GET') return handleWalletCheck(req, res);
            break;
        case 'user-transactions': return handleGetUserTransactions(req, res);
        case 'esim-refills': return getEsimRefills(req, res);
        case 'update-esim-status': return handleAdminEsimUpdate(req, res);
        case 'esim-activation':
        case 'esim-activations':
            if (req.method === 'GET') return handleGetEsimActivations(req, res);
            break;
        case 'esim-activation-complete':
        case 'update-esim-activation':
            if (req.method === 'POST' || req.method === 'PATCH') return handleAdminEsimActivationUpdate(req, res);
            break;
        case 'rdps':
            if (req.method === 'GET') return handleGetRDPs(req, res);
            if (req.method === 'POST') return handleAddRDP(req, res);
            if (req.method === 'PATCH') return handleCompleteRDPOrder(req, res);
            if (req.method === 'DELETE') return handleDeleteRDP(req, res);
            break;
        case 'rdp-requests':
            if (req.method === 'GET') return handleGetRdpRequests(req, res);
            break;
        case 'rdp-request-complete':
            if (req.method === 'POST') return handleCompleteRDPOrder(req, res);
            break;
        case 'upload-receipt':
            if (req.method === 'POST') return handleUploadReceipt(req, res);
            break;
        case 'countries':
            if (req.method === 'GET') return handleGetCountries(req, res);
            break;
        case 'services':
            if (req.method === 'GET') return handleGetServicesAndPrices(req, res);
            break;
        case 'sms-pool-overrides':
            if (req.method === 'GET') return handleGetSmsPoolOverrides(req, res);
            if (req.method === 'POST') return handleSaveSmsPoolOverride(req, res);
            if (req.method === 'DELETE') return handleDeleteSmsPoolOverride(req, res);
            break;
        case 'sms-price-overrides':
            if (req.method === 'GET') return handleGetSmsPriceOverrides(req, res);
            if (req.method === 'POST') return handleSaveSmsPriceOverride(req, res);
            if (req.method === 'DELETE') return handleDeleteSmsPriceOverride(req, res);
            break;
        case 'sms-country-list':
            if (req.method === 'GET') return handleGetSmsCountryList(req, res);
            break;
        case 'sms-operators':
            if (req.method === 'GET') return handleGetSmsOperators(req, res);
            break;
        case 'admin-sms-orders':
            if (req.method === 'GET') return handleGetAdminSmsOrders(req, res);
            break;
        case 'admin-account-orders':
            if (req.method === 'GET') return handleGetAdminAccountOrders(req, res);
            break;
        case 'admin-deposits':
            if (req.method === 'GET') return handleGetAdminDeposits(req, res);
            break;
        case 'sms-stats':
            if (req.method === 'GET') return handleGetSmsStats(req, res);
            break;
        case 'smsbower-balance':
            if (req.method === 'GET') return handleGetSmsBowerBalance(req, res);
            break;
        case 'daily-stats':
            if (req.method === 'GET') return handleGetDailyStats(req, res);
            break;
        case 'user-activity':
            if (req.method === 'GET') return handleGetUserActivity(req, res);
            break;
        case 'sameeha-balance':
            if (req.method === 'GET') return handleGetSameehaBalance(req, res);
            break;
        case 'account-products':
            if (req.method === 'GET') return handleGetAccountProducts(req, res);
            break;
        case 'admin-account-products':
            if (req.method === 'GET') return handleGetAdminAccountProducts(req, res);
            break;
        case 'account-prices':
            if (req.method === 'POST') return handleSaveAccountPrice(req, res);
            if (req.method === 'DELETE') return handleDeleteAccountPrice(req, res);
            break;
        case 'service-image':
            if (req.method === 'GET') return handleProxyServiceImage(req, res);
            break;
        case 'change-passwords':
            if (req.method === 'POST') return handleAdminChangePassword(req, res);
            break;
        case 'admin-forgot-password':
            if (req.method === 'POST') return handleAdminForgotPasswordRequest(req, res);
            break;
        case 'admin-reset-password':
            if (req.method === 'POST') return handleAdminResetPassword(req, res);
            break;
        case 'update-system-settings':
            if (req.method === 'POST') return handleUpdateSystemSettings(req, res);
            break;
        case 'get-system-settings':
        case 'system-settings':
            if (req.method === 'GET') return handleGetSystemSettings(req, res);
            break;
        case 'system-status': // Public route for the frontend to check
            return handleGetSystemStatus(req, res);
    }

    return res.status(404).json({
        success: false,
        message: `Action '${action}' not found on this server.`
    });
});

// --- 7. LOGIC HANDLERS ---
async function handleLogin(req, res) {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    try {
        // Older admin records were saved without lowercasing, so match either form
        const admin = await Admin.findOne({ email: { $in: [email.trim(), email.toLowerCase().trim()] } });

        if (!admin || !(await bcrypt.compare(password, admin.password))) {
            return res.status(401).json({ success: false, message: "Invalid admin credentials" });
        }
        const token = jwt.sign(
            { id: admin._id, email: admin.email, role: 'admin' }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );
        return res.json({ success: true, token });
    } catch (err) {
        console.error("Admin Login Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
}

// --- DEMO LOGIN (LOCAL DEVELOPMENT ONLY) ---
// Gated three ways: DEMO_LOGIN_ENABLED=true in .env, NODE_ENV is not 'production'
// (Vercel always sets production), and the request must come from localhost.
// DEMO_LOGIN_ALLOW_LAN=true also lets devices on the home network in (phone testing).
function isPrivateLanIp(ip) {
    return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function isDemoLoginAllowed(req) {
    if (process.env.DEMO_LOGIN_ENABLED !== 'true') return false;
    if (process.env.NODE_ENV === 'production') return false;

    const localHosts = ['localhost', '127.0.0.1', '::1'];
    const remoteIp = (req.socket?.remoteAddress || '').replace('::ffff:', '');
    if (localHosts.includes(req.hostname) && localHosts.includes(remoteIp)) return true;

    // Phone on the same Wi-Fi, opening http://<PC LAN IP>:3000
    return process.env.DEMO_LOGIN_ALLOW_LAN === 'true'
        && isPrivateLanIp(req.hostname) && isPrivateLanIp(remoteIp);
}

async function handleDemoLoginStatus(req, res) {
    return res.json({ success: true, enabled: isDemoLoginAllowed(req) });
}

async function handleDemoLogin(req, res) {
    if (!isDemoLoginAllowed(req)) {
        return res.status(404).json({ success: false, message: "Action 'demo-login' not found on this server." });
    }

    const { accountType } = req.body; // 'admin' or 'user'
    const isAdmin = accountType === 'admin';
    const email = isAdmin ? process.env.DEMO_ADMIN_EMAIL : process.env.DEMO_USER_EMAIL;
    const password = isAdmin ? process.env.DEMO_ADMIN_PASSWORD : process.env.DEMO_USER_PASSWORD;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Demo credentials are missing from .env" });
    }

    try {
        // 1. Verify the demo account with the same password check as a normal login
        const account = isAdmin
            ? await Admin.findOne({ email: email.toLowerCase().trim() })
            : await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

        if (!account || !(await bcrypt.compare(password, account.password))) {
            return res.status(401).json({ success: false, message: "Demo account not found or password mismatch." });
        }

        // 2. Issue the same token shape as the real login handlers
        if (isAdmin) {
            const token = jwt.sign(
                { id: account._id, email: account.email, role: 'admin' },
                JWT_SECRET,
                { expiresIn: '24h' }
            );
            return res.json({ success: true, token });
        }

        // Same as /login: a demo user who is also an admin gets the admin session only
        const adminToken = await buildAdminSessionFor(account, { password });
        return res.json(signInResponse(account, adminToken));
    } catch (err) {
        console.error("Demo Login Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleGoogleLogin(req, res) {
    const { idToken, loginType, friendReferralCode } = req.body; // 'admin' or 'user'
    if (typeof idToken !== 'string') {
        return res.status(400).json({ success: false, message: "Missing Google credential." });
    }
    if (friendReferralCode !== undefined && friendReferralCode !== null && typeof friendReferralCode !== 'string') {
        return res.status(400).json({ success: false, message: "The referral code provided is invalid." });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const { email, name, email_verified } = ticket.getPayload();
        if (!email || email_verified === false) {
            return res.status(401).json({ success: false, message: "Your Google email address is not verified." });
        }
        const normalizedEmail = email.toLowerCase();

        // 1. Admin Sign-In: Only Existing Admin Accounts (never auto-create)
        if (loginType === 'admin') {
            const admin = await Admin.findOne({ email: { $in: [email, normalizedEmail] } });
            if (!admin) {
                return res.status(403).json({ success: false, message: "No admin account exists for this Google address." });
            }
            const token = jwt.sign(
                { id: admin._id, email: admin.email, role: 'admin' },
                JWT_SECRET,
                { expiresIn: '24h' }
            );
            return res.json({ success: true, token, user: { name: admin.fullName, email: admin.email } });
        }

        // 2. User Sign-In: Same Gates As Password Login
        const settings = await getSystemSettingsCached();
        if (settings?.maintenanceMode === true) {
            return res.status(503).json({ success: false, message: "DeemaxHub is currently under maintenance. Please try again later." });
        }

        let user = await User.findOne({ email: normalizedEmail });

        // A referral code only matters for a signup (new or still unverified)
        let referredBy = null;
        if (!user || !user.isVerified) {
            referredBy = await resolveReferralCode(friendReferralCode, normalizedEmail);
            if (referredBy === false) {
                return res.status(400).json({ success: false, message: "The referral code provided is invalid." });
            }
        }

        if (!user) {
            if (settings?.allowSignups === false) {
                return res.status(403).json({ success: false, message: "New signups are currently closed." });
            }
            user = new User({
                fullName: name || normalizedEmail.split('@')[0],
                email: normalizedEmail,
                password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
                hasPassword: false, // Nobody knows this random password; Forgot Password sets a real one
                referralCode: await generateUniqueCode(),
                referredBy,
                referralStatus: referredBy ? 'pending' : undefined,
                isVerified: true // Google has already verified this address
            });
            await user.save();
        } else if (!user.isVerified) {
            // Google proves ownership of the address, so finish any pending verification.
            // Same atomic claim as verify-otp; keep the signup's code, else take the one given now.
            // ⚠️ CRITICAL: Anyone can start a signup with someone else's email, so the unverified
            // signup's password is replaced. Otherwise its maker could sign in once Google verified it.
            const finalReferredBy = user.referredBy || referredBy;
            const verifiedSet = {
                isVerified: true,
                otpAttempts: 0,
                referredBy: finalReferredBy,
                password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
                hasPassword: false, // As for a new Google signup: Forgot Password sets a real one
                ...(name ? { fullName: name } : {})
            };
            if (finalReferredBy) verifiedSet.referralStatus = 'pending';
            const verifiedUser = await User.findOneAndUpdate(
                { _id: user._id, isVerified: { $ne: true } },
                { $set: verifiedSet, $unset: { otpCode: 1, otpExpires: 1 } },
                { returnDocument: 'after' }
            );
            user = verifiedUser || await User.findById(user._id);
        }

        if (user.status === 'suspended') {
            return res.status(403).json({ success: false, message: "Your account has been suspended. Contact support." });
        }

        const adminToken = await buildAdminSessionFor(user, { google: true });
        return res.json(signInResponse(user, adminToken));

    } catch (err) {
        console.error("Google Auth Error:", err);
        return res.status(401).json({ success: false, message: "Google Auth Failed" });
    }
}

async function handleDashboardStats(req, res) {
    try {
        const totalUsers = await User.countDocuments();

        const now = new Date();
        // Day, month and year boundaries follow Lagos time (not the server's UTC clock)
        const startOfDay = startOfLagosDay(now);
        const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const lagosNow = new Date(now.getTime() + LAGOS_OFFSET_MS);
        const startOfMonth = new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), 1) - LAGOS_OFFSET_MS);
        const startOfYear = new Date(Date.UTC(lagosNow.getUTCFullYear(), 0, 1) - LAGOS_OFFSET_MS);
        const startOfChart = new Date(startOfDay.getTime() - 6 * 24 * 60 * 60 * 1000);

        const validStatuses = ['successful', 'completed', 'paid'];

        // 1. Sum Revenue In The Database Instead Of Loading Every Order
        const sumSince = (date) => ({ $sum: { $cond: [{ $gte: ['$createdAt', date] }, '$amount', 0] } });
        const [totals] = await Order.aggregate([
            { $match: { status: { $in: validStatuses } } },
            { $group: {
                _id: null,
                totalRevenue: { $sum: '$amount' },
                daily: sumSince(startOfDay),
                weekly: sumSince(startOfWeek),
                monthly: sumSince(startOfMonth),
                yearly: sumSince(startOfYear)
            } }
        ]);

        let ngnStats = {
            totalRevenue: totals?.totalRevenue || 0,
            daily: totals?.daily || 0,
            weekly: totals?.weekly || 0,
            monthly: totals?.monthly || 0,
            yearly: totals?.yearly || 0
        };

        // 2. Order Counts For The Last 7 Days (Chart)
        const chartOrders = await Order.find({
            status: { $in: validStatuses },
            createdAt: { $gte: startOfChart }
        }).select('createdAt').lean();

        const rawRecentOrders = await Order.find({
            status: { $in: validStatuses } 
        })
        .sort({ createdAt: -1 })
        .limit(10);

        const recentOrders = rawRecentOrders.map(order => ({
            userEmail: order.userEmail,
            productType: order.productType || order.planName,
            status: order.status,
            amount: parseFloat(order.amount || 0), 
            createdAt: order.createdAt
        }));

        // Chart logic
        const chartLabels = [];
        const chartData = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            chartLabels.push(d.toLocaleDateString('en-US', { weekday: 'short' }));

            const start = new Date(d); start.setHours(0,0,0,0);
            const end = new Date(d); end.setHours(23,59,59,999);

            const dayCount = chartOrders.filter(o => {
                const orderDate = new Date(o.createdAt);
                return orderDate >= start && orderDate <= end;
            }).length;
            
            chartData.push(dayCount);
        }

        return res.json({ 
            success: true, 
            totalUsers,
            revenue: ngnStats, // Renamed to generic revenue
            recentOrders,
            chart: { labels: chartLabels, data: chartData } 
        });
    } catch (err) {
        console.error("Stats Error:", err);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}

// --- USER MANAGEMENT (ADMIN) ---
// Ported from DanSMS's users panel: server-side search, sort and paging, admin roles, suspension
// with a reason, and a footprint check before delete. Admins live in their own collection here, so
// a user "is an admin" when an Admin account shares their email.
const USER_SORTS = {
    createdAt: 'createdAt',
    balance: 'balance',
    totalDeposit: 'totalDeposit',
    orders: 'orderCount',
    email: 'email',
    fullName: 'fullName'
};

/**
 * GET ?page=1&limit=25&search=&sort=createdAt&dir=desc&filter=all|active|suspended|admins
 * Returns { users, total, page, pages, counts: { all, active, suspended, admins } }.
 */
async function handleGetUsers(req, res) {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
    const sortKey = USER_SORTS[req.query.sort] ? req.query.sort : 'createdAt';
    const dir = req.query.dir === 'asc' ? 1 : -1;
    const filterName = ['active', 'suspended', 'admins'].includes(req.query.filter) ? req.query.filter : 'all';

    try {
        // 1. Admin Emails (the "role" column) And The Filter
        const adminEmails = (await Admin.find({}).select('email').lean()).map(a => String(a.email).toLowerCase());
        const filter = {};
        if (filterName === 'active') filter.status = { $ne: 'suspended' };
        if (filterName === 'suspended') filter.status = 'suspended';
        if (filterName === 'admins') filter.email = { $in: adminEmails };
        if (search) {
            const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ email: pattern }, { fullName: pattern }, { referralCode: pattern }];
        }

        // 2. Lifetime Deposits And Order Count Per User
        const statsLookups = [
            { $lookup: {
                from: Transaction.collection.name,
                let: { uid: '$_id' },
                pipeline: [
                    { $match: { $expr: { $eq: ['$userId', '$$uid'] }, purpose: 'deposit', status: 'successful' } },
                    { $group: { _id: null, total: { $sum: '$amountNGN' }, count: { $sum: 1 } } }
                ],
                as: 'depositStats'
            } },
            { $lookup: {
                from: Order.collection.name,
                let: { uid: '$_id' },
                pipeline: [{ $match: { $expr: { $eq: ['$userId', '$$uid'] } } }, { $count: 'n' }],
                as: 'orderStats'
            } },
            { $addFields: {
                totalDeposit: { $ifNull: [{ $first: '$depositStats.total' }, 0] },
                depositCount: { $ifNull: [{ $first: '$depositStats.count' }, 0] },
                orderCount: { $ifNull: [{ $first: '$orderStats.n' }, 0] }
            } }
        ];

        // 3. Sort And Page (per-user stats are looked up after paging unless the sort needs them)
        const sortStage = { $sort: { [USER_SORTS[sortKey]]: dir, _id: 1 } };
        const pageStages = [{ $skip: (page - 1) * limit }, { $limit: limit }];
        const computedSort = sortKey === 'totalDeposit' || sortKey === 'orders';
        const rowsPipeline = computedSort
            ? [...statsLookups, sortStage, ...pageStages]
            : [sortStage, ...pageStages, ...statsLookups];

        const [[result], countRows] = await Promise.all([
            User.aggregate([
                { $match: filter },
                { $facet: { rows: rowsPipeline, total: [{ $count: 'n' }] } }
            ]),
            User.aggregate([
                { $group: {
                    _id: null,
                    all: { $sum: 1 },
                    suspended: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
                    admins: { $sum: { $cond: [{ $in: [{ $toLower: '$email' }, adminEmails] }, 1, 0] } }
                } }
            ])
        ]);
        const total = result?.total?.[0]?.n || 0;
        const counts = countRows[0] || { all: 0, suspended: 0, admins: 0 };

        // 4. Only What The Admin Page Shows (no password, OTP or reset tokens)
        const users = (result?.rows || []).map(u => ({
            _id: u._id,
            fullName: u.fullName || 'Member',
            email: u.email,
            status: u.status || 'active',
            suspendedAt: u.suspendedAt || null,
            suspendedReason: u.suspendedReason || null,
            isVerified: Boolean(u.isVerified),
            isAdmin: adminEmails.includes(String(u.email).toLowerCase()),
            isSelf: String(u.email).toLowerCase() === String(req.admin.email).toLowerCase(),
            balance: u.balance || 0,
            bonusBalance: u.bonusBalance || 0,
            totalDeposit: Math.round(u.totalDeposit || 0),
            depositCount: u.depositCount || 0,
            orderCount: u.orderCount || 0,
            referralCode: u.referralCode || 'N/A',
            referralCount: u.referralCount || 0,
            referredBy: u.referredBy || null,
            createdAt: u.createdAt
        }));

        return res.json({
            success: true,
            users,
            total,
            page,
            pages: Math.max(Math.ceil(total / limit), 1),
            counts: { all: counts.all, active: counts.all - counts.suspended, suspended: counts.suspended, admins: counts.admins }
        });
    } catch (err) {
        console.error("Fetch Users Error:", err);
        return res.status(500).json({ success: false, message: "Database Error" });
    }
}

// What deleting a user would leave behind: their orders and payments stay in the database without an owner
async function getUserFootprint(user) {
    const [orders, [deposits]] = await Promise.all([
        Order.countDocuments({ userId: user._id }),
        Transaction.aggregate([
            { $match: { userId: user._id, purpose: 'deposit', status: 'successful' } },
            { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amountNGN' } } }
        ])
    ]);
    return {
        orders,
        deposits: deposits?.count || 0,
        paidNGN: Math.round(deposits?.total || 0),
        balanceNGN: Math.round(user.balance || 0),
        bonusNGN: Math.round(user.bonusBalance || 0)
    };
}

// GET ?userId= : the counts the delete screen shows before the admin confirms
async function handleGetUserFootprint(req, res) {
    const { userId } = req.query;
    if (typeof userId !== 'string' || !mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID." });
    }
    try {
        const user = await User.findById(userId).select('balance bonusBalance').lean();
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        return res.json({ success: true, footprint: await getUserFootprint(user) });
    } catch (err) {
        console.error("User Footprint Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

/**
 * POST { action, userId, reason?, force? }
 *   suspend / activate - block or restore sign-in and purchases (history and balance are kept)
 *   make-admin         - creates an Admin account with the user's email and password, so they sign
 *                        in at /admin/login with the password they already use
 *   remove-admin       - deletes that Admin account (never your own, never the last one)
 *   delete             - removes the user; needs force when they have orders or deposits
 * Admin accounts can't be suspended or deleted from here: remove their admin access first.
 */
async function handleManageUser(req, res) {
    const { action, userId, reason, force } = req.body;

    if (!userId || !action || typeof userId !== 'string' || typeof action !== 'string' || !mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ success: false, message: "Missing User ID or Action." });
    }

    try {
        const user = await User.findById(userId).select('+password');
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const email = String(user.email).toLowerCase();
        const isSelf = email === String(req.admin.email).toLowerCase();
        const adminAccount = await Admin.findOne({ email });
        console.log(`Admin ${req.admin.email} ran '${action}' on user ${user.email}`);

        // 1. Roles
        if (action === 'make-admin') {
            if (adminAccount) return res.status(400).json({ success: false, message: "This user is already an admin." });
            if (user.status === 'suspended') return res.status(400).json({ success: false, message: "Activate this user before making them an admin." });
            await Admin.create({ fullName: user.fullName || 'Admin', email, password: user.password });
            return res.json({ success: true, message: `${user.email} is now an admin. They sign in on the normal login page and get an Admin Panel link.` });
        }

        if (action === 'remove-admin') {
            if (!adminAccount) return res.status(400).json({ success: false, message: "This user is not an admin." });
            if (isSelf) return res.status(400).json({ success: false, message: "You can't remove your own admin access." });
            // Losing the last admin means nobody can ever sign in to this panel again
            if ((await Admin.countDocuments()) <= 1) {
                return res.status(400).json({ success: false, message: "You can't remove the last admin." });
            }
            await Admin.deleteOne({ _id: adminAccount._id });
            return res.json({ success: true, message: `${user.email} is no longer an admin.` });
        }

        if (isSelf) return res.status(400).json({ success: false, message: "You can't suspend or delete your own account." });
        if (adminAccount && (action === 'suspend' || action === 'delete')) {
            return res.status(400).json({ success: false, message: "Remove this user's admin access first." });
        }

        // 2. Deletion (orders and payments keep their records, so the admin sees what they'd orphan)
        if (action === 'delete') {
            const footprint = await getUserFootprint(user);
            const hasHistory = footprint.orders + footprint.deposits > 0;
            if (hasHistory && force !== true) {
                return res.status(409).json({ success: false, needsForce: true, footprint, message: "This user has orders or deposits. Confirm to delete anyway." });
            }
            await User.deleteOne({ _id: user._id });
            return res.json({ success: true, message: "User deleted." });
        }

        // 3. Suspend / Activate
        if (action === 'suspend' || action === 'activate') {
            const suspend = action === 'suspend';
            const update = suspend
                ? { $set: { status: 'suspended', suspendedAt: new Date(), suspendedReason: typeof reason === 'string' ? reason.trim().slice(0, 200) : '' } }
                : { $set: { status: 'active' }, $unset: { suspendedAt: 1, suspendedReason: 1 } };
            const updatedUser = await User.findByIdAndUpdate(user._id, update, { returnDocument: 'after' });
            return res.json({ success: true, message: `User is now ${updatedUser.status}.`, status: updatedUser.status });
        }

        return res.status(400).json({ success: false, message: "Invalid action type." });
    } catch (err) {
        console.error("Manage User Error:", err);
        return res.status(500).json({ success: false, message: "Could not update user." });
    }
}

// --- ADMIN USER VIEW ---
// Signs an admin into their own customer account (same email) so they can buy from the admin
// User View. The account is created on first use with the admin's password. Purchases pay from
// that account's own wallet, which the admin tops up from the Users page (admin-credit-user), as for any customer.
async function handleAdminUserSession(req, res) {
    try {
        const email = String(req.admin.email).toLowerCase().trim();
        let user = await User.findOne({ email });

        // 1. First Visit: Create The Admin's Customer Account
        if (!user) {
            user = await User.create({
                fullName: req.admin.fullName || 'Admin',
                email,
                password: req.admin.password, // Same bcrypt hash, so /login works with the admin password too
                referralCode: await generateUniqueCode(),
                isVerified: true // The admin account already proves who this is
            });
            console.log(`✅ Created customer account for admin ${email} (User View)`);
        }

        // 2. Same Rules As Any Customer
        if (user.status === 'suspended') {
            return res.status(403).json({ success: false, isSuspended: true, message: "Your customer account is suspended. Activate it on the Users page first." });
        }
        if (!user.isVerified) {
            // Finish a pending signup; a referral starts at 'pending' as it would on verify-otp.
            // ⚠️ CRITICAL: Someone else may have started that signup with this email, so its
            // password is replaced with the admin's (the same as a first-visit account gets).
            const verifiedSet = { isVerified: true, otpAttempts: 0, password: req.admin.password, hasPassword: true };
            if (user.referredBy && !user.referralStatus) verifiedSet.referralStatus = 'pending';
            user = await User.findByIdAndUpdate(user._id, { $set: verifiedSet, $unset: { otpCode: 1, otpExpires: 1 } }, { returnDocument: 'after' });
        }

        return res.json({ success: true, message: "Signed in to your customer account.", ...buildUserSession(user) });
    } catch (err) {
        console.error("Admin User Session Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// The admin's own customer wallet, shown in the admin top bar. ₦0 until User View creates the account.
async function handleGetAdminWallet(req, res) {
    try {
        const email = String(req.admin.email).toLowerCase().trim();
        const user = await User.findOne({ email }).select('balance bonusBalance').lean();
        return res.json({ success: true, balance: user?.balance || 0, bonusBalance: user?.bonusBalance || 0 });
    } catch (err) {
        console.error("Admin Wallet Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- ADMIN WALLET CREDIT ---
// Lets an admin manually top up a user's main wallet (e.g. a bank transfer
// confirmed outside Flutterwave). Logged as a 'deposit' so it shows in the
// user's top-up history, tagged with paymentMethod 'admin_credit'.
// direction 'debit' takes money back out of the main wallet (purpose 'admin_debit', so it never
// counts as a deposit or a purchase, while Wallet Check still balances).
const ADMIN_CREDIT_MAX_NGN = 1000000; // Guards against typos (an extra zero)

async function handleAdminCreditUser(req, res) {
    const { userId, amount, note, direction } = req.body;
    const isDebit = direction === 'debit';
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: "Unauthorized" });

    // 1. Validate Input (strings only for IDs, so no query operators get through)
    if (typeof userId !== 'string' || !mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID." });
    }

    const amountNGN = Math.round(Number(amount));
    if (!Number.isFinite(amountNGN) || amountNGN <= 0) {
        return res.status(400).json({ success: false, message: "Amount must be a positive number." });
    }
    if (amountNGN > ADMIN_CREDIT_MAX_NGN) {
        return res.status(400).json({ success: false, message: `Amount cannot exceed ₦${ADMIN_CREDIT_MAX_NGN.toLocaleString()} per credit.` });
    }

    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 200) : '';

    try {
        // 2. Verify The Admin Token Against A Real Admin Account
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
        }

        if (decoded.role !== 'admin') {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const admin = await Admin.findById(decoded.id);
        if (!admin) return res.status(401).json({ success: false, message: "Unauthorized" });

        // ATOMIC USER DEBIT (conditional on the main wallet covering it, logged in the same transaction)
        if (isDebit) {
            let debitedUser;
            await runTransactionWithRetry(async (session) => {
                debitedUser = await User.findOneAndUpdate(
                    { _id: userId, balance: { $gte: amountNGN } },
                    { $inc: { balance: -amountNGN } },
                    { returnDocument: 'after', session }
                );
                if (!debitedUser) return;

                // TRANSACTION LOG
                await new Transaction({
                    userId: debitedUser._id,
                    type: 'debit',
                    purpose: 'admin_debit',
                    amountNGN,
                    status: 'successful',
                    reference: `ADMIN-DR-${Date.now()}-${debitedUser._id.toString().slice(-4)}`,
                    paymentMethod: 'admin_debit',
                    balanceBefore: debitedUser.balance + amountNGN,
                    balanceAfter: debitedUser.balance,
                    bonusBefore: debitedUser.bonusBalance || 0,
                    bonusAfter: debitedUser.bonusBalance || 0,
                    metadata: { payment_type: 'Admin Debit', adminId: admin._id, adminEmail: admin.email, note: cleanNote }
                }).save({ session });
            });

            if (!debitedUser) {
                const exists = await User.exists({ _id: userId });
                return res.status(exists ? 400 : 404).json({ success: false, message: exists ? "The main wallet holds less than that amount." : "User not found" });
            }
            console.log(`✅ Admin ${admin.email} debited ₦${amountNGN} from ${debitedUser.email}`);
            return res.json({
                success: true,
                message: `₦${amountNGN.toLocaleString()} taken from ${debitedUser.email}.`,
                newBalance: debitedUser.balance
            });
        }

        // ATOMIC USER CREDIT
        const updatedUser = await User.findOneAndUpdate(
            { _id: userId },
            { $inc: { balance: amountNGN } },
            { returnDocument: 'after' }
        );

        if (!updatedUser) return res.status(404).json({ success: false, message: "User not found" });

        const balanceAfter = updatedUser.balance || 0;
        const balanceBefore = balanceAfter - amountNGN;

        // TRANSACTION LOG
        try {
            await Transaction.create({
                userId: updatedUser._id,
                type: 'credit',
                purpose: 'deposit',
                amountNGN,
                status: 'successful',
                reference: `ADMIN-${Date.now()}-${updatedUser._id.toString().slice(-4)}`,
                paymentMethod: 'admin_credit',
                balanceBefore,
                balanceAfter,
                bonusBefore: updatedUser.bonusBalance || 0,
                bonusAfter: updatedUser.bonusBalance || 0,
                metadata: {
                    payment_type: 'Admin Credit', // Label shown in the user's top-up history
                    adminId: admin._id,
                    adminEmail: admin.email,
                    note: cleanNote
                }
            });
        } catch (logErr) {
            // ⚠️ CRITICAL: No record means no audit trail, so undo the credit
            await User.findByIdAndUpdate(updatedUser._id, { $inc: { balance: -amountNGN } });
            throw logErr;
        }

        console.log(`✅ Admin ${admin.email} credited ₦${amountNGN} to ${updatedUser.email}`);

        return res.json({
            success: true,
            message: `₦${amountNGN.toLocaleString()} added to ${updatedUser.email}.`,
            newBalance: balanceAfter
        });
    } catch (err) {
        console.error("Admin Credit Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// Returns the admin for a valid admin token, or null (never sends a response)
async function getOptionalAdmin(req) {
    const token = getBearerToken(req);
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin' || !mongoose.isValidObjectId(decoded.id)) return null;
        return await Admin.findById(decoded.id);
    } catch (err) {
        return null;
    }
}

async function handleGetVPNs(req, res) {
    try {
        const isAdmin = Boolean(await getOptionalAdmin(req));

        // ⚠️ CRITICAL: Unsold credentials are only ever sent to admins
        const vpns = await VPN.find({})
            .sort({ createdAt: -1 })
            .select(isAdmin ? '' : '-phoneAccounts -pcAccounts')
            .lean();

        res.json({ success: true, products: vpns });
    } catch (err) {
        console.error("Fetch VPN Error:", err);
        res.status(500).json({ success: false, message: "Failed to fetch VPN list" });
    }
}
async function handleAddVPN(req, res) {
    try {
        const { plans, deviceType, deviceLimit, phoneAccounts, pcAccounts, ...otherData } = req.body;

        // 1. Format Plans
        let formattedPlans = [];
        if (plans && Array.isArray(plans)) {
            formattedPlans = plans.map(p => ({
                duration: p.duration || "1 Month",
                price: Math.round(parseFloat(p.price)) || 0
            }));
        }

        const newVPN = new VPN({
            ...otherData,
            plans: formattedPlans,
            phoneAccounts: phoneAccounts || [],
            pcAccounts: pcAccounts || [],
            deviceType: normalizeDeviceType(deviceType),
            deviceLimit: parseInt(deviceLimit) || 1,
            // Price is taken from the first plan tier for display
            price: formattedPlans.length > 0 ? formattedPlans[0].price : 0
        });

        // This triggers the pre('save') middleware in your schema to auto-calculate stock
        await newVPN.save();

        res.status(201).json({ 
            success: true, 
            message: "VPN Node & Stock Synced Successfully",
            productId: newVPN._id 
        });
        
    } catch (err) {
        console.error("Add VPN Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Upload failed: " + err.message 
        });
    }
}

async function handleUpdateVPN(req, res) {
    try {
        const { vpnId, id, plans, phoneAccounts, pcAccounts, deviceType, expectedUpdatedAt, _id, stock, createdAt, updatedAt, ...updateData } = req.body;
        const targetId = vpnId || id;

        if (!targetId || !mongoose.isValidObjectId(targetId)) {
            return res.status(400).json({ success: false, message: "VPN ID is required" });
        }

        // 0. Reject Stale Forms: The account lists replace what's stored, so if anything
        // sold since the admin opened the form, saving would put sold accounts back on sale
        if ((phoneAccounts || pcAccounts) && expectedUpdatedAt) {
            const current = await VPN.findById(targetId).select('updatedAt').lean();
            if (current && new Date(current.updatedAt).getTime() !== new Date(expectedUpdatedAt).getTime()) {
                return res.status(409).json({ success: false, message: "Stock changed since you opened this form (a sale or another edit). Reload the page and try again." });
            }
        }

        // 1. Explicitly Map Bulk Accounts & Normalize Type
        if (phoneAccounts) updateData.phoneAccounts = phoneAccounts;
        if (pcAccounts) updateData.pcAccounts = pcAccounts;
        if (deviceType) updateData.deviceType = normalizeDeviceType(deviceType);

        // 2. Format Plans
        if (plans && Array.isArray(plans)) {
            updateData.plans = plans.map(p => ({
                duration: p.duration || "1 Month",
                price: Math.round(parseFloat(p.price)) || 0
            }));
            
            if (updateData.plans.length > 0) {
                updateData.price = updateData.plans[0].price;
            }
        }

        let updated = await VPN.findByIdAndUpdate(
            targetId,
            { $set: updateData },
            { returnDocument: 'after', runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({ success: false, message: "VPN node not found" });
        }

        // 3. Sync Stock Count From Both Lists (findByIdAndUpdate skips the pre-save hook)
        if (phoneAccounts || pcAccounts) {
            updated = await VPN.findByIdAndUpdate(
                targetId,
                [{ $set: { stock: { $add: [
                    { $size: { $ifNull: ['$phoneAccounts', []] } },
                    { $size: { $ifNull: ['$pcAccounts', []] } }
                ] } } }],
                { returnDocument: 'after', updatePipeline: true }
            );
        }

        res.json({ 
            success: true, 
            message: "VPN Configuration Updated Successfully",
            data: updated 
        });

    } catch (err) {
        console.error("Update VPN Error:", err);
        res.status(500).json({ 
            success: false, 
            message: "Update failed: " + err.message 
        });
    }
}
async function handleDeleteVPN(req, res) {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).json({ success: false, message: "ID is required" });
        
        const deleted = await VPN.findByIdAndDelete(id);
        
        if (!deleted) {
            return res.status(404).json({ success: false, message: "VPN node not found" });
        }
        res.json({ success: true, message: "VPN Node Deleted Successfully" });
    } catch (err) {
        console.error("Delete VPN Error:", err);
        res.status(500).json({ success: false, message: "Delete failed" });
    }
}

async function handleUserLogin(req, res) {
    const { email, password } = req.body;
    
    if (!email || typeof email !== 'string') {
        return res.status(400).json({ success: false, message: "Valid email is required." });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: "Password is required." });
    }
    try {
        const settings = await SystemSettings.findOne(); 
        if (settings && settings.maintenanceMode === true) {
            return res.status(503).json({ 
                success: false, 
                message: "DeemaxHub is currently under maintenance. Please try again later." 
            });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }

        // Check if the user has verified their email via OTP
        if (user.isVerified === false) {
            return res.status(403).json({
                success: false,
                isUnverified: true, // Frontend flag to trigger OTP modal
                email: user.email,
                message: "Please verify your email address to continue."
            });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({
                success: false,
                message: "Your account has been suspended. Contact support."
            });
        }

        if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined.");

        const adminToken = await buildAdminSessionFor(user, { password });
        return res.json(signInResponse(user, adminToken));

    } catch (err) {
        console.error("========== LOGIN ERROR ==========");
        console.error(err.message);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleUserRegister(req, res) {
    const { fullName, email, password, friendReferralCode } = req.body;

    if (typeof fullName !== 'string' || typeof email !== 'string' || typeof password !== 'string' || !fullName.trim()) {
        return res.status(400).json({ success: false, message: "Full name, email and password are required." });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }
    if (friendReferralCode !== undefined && friendReferralCode !== null && typeof friendReferralCode !== 'string') {
        return res.status(400).json({ success: false, message: "The referral code provided is invalid." });
    }

    try {
        const settings = await getSystemSettingsCached();
        if (settings?.maintenanceMode === true) {
            return res.status(503).json({ success: false, message: "DeemaxHub is currently under maintenance. Please try again later." });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const existingUser = await User.findOne({ email: normalizedEmail });

        if (existingUser && existingUser.isVerified) {
            return res.status(400).json({ success: false, message: "This email is already registered." });
        }

        if (!existingUser && settings?.allowSignups === false) {
            return res.status(403).json({ success: false, message: "New signups are currently closed." });
        }

        const referredBy = await resolveReferralCode(friendReferralCode, normalizedEmail);
        if (referredBy === false) {
            return res.status(400).json({ success: false, message: "The referral code provided is invalid." });
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpExpires = Date.now() + 10 * 60 * 1000;

        const myNewReferralCode = await generateUniqueCode();
        const hashedPassword = await bcrypt.hash(password, 12);

        const userData = {
            fullName: fullName.trim(),
            email: normalizedEmail,
            password: hashedPassword,
            balance: 0,
            bonusBalance: 0,
            hasDeposited: false,
            referralCode: myNewReferralCode,
            referredBy,
            referralCount: 0,
            isVerified: false,
            otpCode: otp,
            otpExpires: otpExpires,
            otpAttempts: 0
        };

        if (existingUser) {
            // Only an unverified signup can be replaced. Taking it over still needs the
            // emailed code, and verify-otp caps guesses (see OTP_MAX_ATTEMPTS)
            await User.updateOne({ email: normalizedEmail, isVerified: false }, userData);
        } else {
            const newUser = new User(userData);
            await newUser.save();
        }

       await transporter.sendMail({
    from: mailFrom('DeemaxHub'),
    to: normalizedEmail,
    subject: "Verify your DeemaxHub Account",
    html: `
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                @media only screen and (max-width: 480px) {
                    .container { padding: 20px !important; }
                    .otp-text { font-size: 24px !important; letter-spacing: 4px !important; }
                    .brand-logo { height: 24px !important; }
                }
            </style>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F0F5FE; font-family: 'Inter', Helvetica, Arial, sans-serif;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                    <td align="center" style="padding: 40px 10px;">
                        <table class="container" role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 440px; background-color: #ffffff; border: 1px solid #EAECF0; border-radius: 24px; padding: 32px; box-shadow: 0 4px 12px rgba(15, 84, 198, 0.05);">
                            <tr>
                                <td align="center" style="padding-bottom: 24px;">
                                    <img src="${APP_BASE_URL}/assets/logo.png" alt="DeemaxHub" class="brand-logo" style="height: 28px; width: auto; display: block; outline: none; border: none; text-decoration: none;">
                                </td>
                            </tr>
                            
                            <tr>
                                <td align="center">
                                    <h2 style="margin: 0; color: #101828; font-size: 20px; font-weight: 700; line-height: 1.2;">Verify your email</h2>
                                    <p style="margin: 12px 0 0 0; color: #667085; font-size: 14px; line-height: 1.5;">
                                        Thanks for joining DeemaxHub! Please use the verification code below to complete your registration.
                                    </p>
                                </td>
                            </tr>

                            <tr>
                                <td align="center" style="padding: 32px 0;">
                                    <div class="otp-text" style="background-color: #F9FAFB; border: 1px dashed #D0D5DD; border-radius: 12px; padding: 16px; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0F54C6; display: inline-block;">
                                        ${otp}
                                    </div>
                                    <p style="margin: 12px 0 0 0; color: #F9861E; font-size: 12px; font-weight: 600;">Code expires in 10 minutes</p>
                                </td>
                            </tr>

                            <tr>
                                <td align="center" style="border-top: 1px solid #EAECF0; padding-top: 24px;">
                                    <p style="margin: 0; color: #98A2B3; font-size: 11px; line-height: 1.4;">
                                        If you didn't request this code, you can safely ignore this email.
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #98A2B3; font-size: 11px;">
                                        &copy; 2026 DeemaxHub. All rights reserved.
                                    </p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
    `
});

        return res.status(200).json({ 
            success: true, 
            message: "Verification code sent to your email!" 
        });

    } catch (err) {
        console.error("Registration Error:", err);
        return res.status(500).json({ success: false, message: "Failed to process registration." });
    }
}

const OTP_MAX_ATTEMPTS = 5; // Wrong guesses before the code is thrown away

// --- REFERRAL PROGRAM ---
// A referral counts only after the referee verifies their email AND tops up at least
// referralMinDepositNGN, so throwaway signups earn nothing. Lifecycle on the referee:
// verify -> 'pending', qualifying top-up -> 'qualified', referrer counted -> 'credited'.

async function getReferralSettings() {
    const settings = await getSystemSettingsCached();
    return {
        bonusNGN: Math.max(Math.round(Number(settings?.referralBonusNGN ?? 3000)), 0),
        milestone: Math.max(Math.round(Number(settings?.referralMilestone ?? 10)), 1),
        minDepositNGN: Math.max(Math.round(Number(settings?.referralMinDepositNGN ?? 1000)), 0)
    };
}

/**
 * Cleans a referral code typed at signup.
 * Returns the code, null when none was given, or false when it is unknown or the user's own.
 */
async function resolveReferralCode(code, signupEmail) {
    if (typeof code !== 'string' || !code.trim()) return null;
    const cleanCode = code.trim().toUpperCase();
    const referrer = await User.findOne({ referralCode: cleanCode }).select('email').lean();
    if (!referrer || referrer.email === signupEmail) return false;
    return cleanCode;
}

/**
 * Counts a qualified referee against their referrer, exactly once.
 * The referee's status flip and the referrer's count share one transaction, so a crash
 * leaves the referee 'qualified' and the next profile load retries it.
 * Every `milestone`-th referral pays bonusNGN into bonus balance with its own Transaction.
 */
async function creditReferrer(refereeId) {
    const { bonusNGN, milestone } = await getReferralSettings();

    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        // 1. Claim The Referee (only one request can move 'qualified' -> 'credited')
        const referee = await User.findOneAndUpdate(
            { _id: refereeId, referralStatus: 'qualified' },
            { $set: { referralStatus: 'credited' } },
            { returnDocument: 'after', session }
        );
        if (!referee) {
            await session.abortTransaction();
            return;
        }

        // 2. Count The Referral (a deleted referrer code still closes the claim)
        const referrer = referee.referredBy ? await User.findOneAndUpdate(
            { referralCode: referee.referredBy, _id: { $ne: referee._id } },
            { $inc: { referralCount: 1 } },
            { returnDocument: 'after', session }
        ) : null;

        // 3. Every Milestone Pays The Bonus
        if (referrer && bonusNGN > 0 && referrer.referralCount % milestone === 0) {
            const credited = await User.findOneAndUpdate(
                { _id: referrer._id },
                { $inc: { bonusBalance: bonusNGN } },
                { returnDocument: 'after', session }
            );

            // TRANSACTION LOG (reference is unique, so a milestone can only pay once)
            await new Transaction({
                userId: referrer._id,
                type: 'credit',
                purpose: 'referral_bonus',
                amountNGN: bonusNGN,
                status: 'successful',
                reference: `REF-${referrer._id}-${referrer.referralCount}`,
                paymentMethod: 'referral_bonus',
                balanceBefore: credited.balance || 0,
                balanceAfter: credited.balance || 0,
                bonusBefore: credited.bonusBalance - bonusNGN,
                bonusAfter: credited.bonusBalance,
                metadata: { referralCount: referrer.referralCount, referredUserId: referee._id }
            }).save({ session });
            console.log(`✅ Referral bonus ₦${bonusNGN} paid to ${referrer.email} (referral #${referrer.referralCount})`);
        }

        await session.commitTransaction();
    } catch (err) {
        await session.abortTransaction().catch(() => {});
        throw err;
    } finally {
        session.endSession();
    }
}

async function handleVerifyOTP(req, res) {
    const { email, otp } = req.body;

    if (typeof email !== 'string' || (typeof otp !== 'string' && typeof otp !== 'number')) {
        return res.status(400).json({ success: false, message: "Email and verification code are required." });
    }
    const otpInput = String(otp).trim();

    try {
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user || user.isVerified || !user.otpCode || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
        }

        // 1. Compare In Constant Time And Count Wrong Guesses
        const codeMatches = otpInput.length === user.otpCode.length &&
            crypto.timingSafeEqual(Buffer.from(otpInput), Buffer.from(user.otpCode));

        if (!codeMatches) {
            // Atomic count, so parallel guesses can't all read the same attempt number
            const counted = await User.findOneAndUpdate(
                { _id: user._id },
                { $inc: { otpAttempts: 1 } },
                { returnDocument: 'after' }
            );
            if ((counted?.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
                await User.updateOne({ _id: user._id }, { $unset: { otpCode: 1, otpExpires: 1 }, $set: { otpAttempts: 0 } });
                return res.status(400).json({ success: false, message: "Too many incorrect attempts. Please sign up again to get a new code." });
            }
            return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
        }

        // 2. Claim The Verification (a referral now waits for the first qualifying top-up)
        const verifiedSet = { isVerified: true, otpAttempts: 0 };
        if (user.referredBy) verifiedSet.referralStatus = 'pending';
        const verifiedUser = await User.findOneAndUpdate(
            { _id: user._id, isVerified: { $ne: true } },
            { $set: verifiedSet, $unset: { otpCode: 1, otpExpires: 1 } },
            { returnDocument: 'after' }
        );
        if (!verifiedUser) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
        }

        // 3. Sign The User In So Signup Lands On The Dashboard
        return res.status(200).json({
            success: true,
            message: "Email verified successfully!",
            ...buildUserSession(verifiedUser)
        });

    } catch (err) {
        console.error("OTP Verification Error:", err);
        return res.status(500).json({ success: false, message: "Verification failed." });
    }
}

async function handleGetUserProfile(req, res) {
    // 1. Verify token
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: "No token provided" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Select all fields except password
        const user = await User.findById(decoded.id).select('-password');
        
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // --- ADDED VERIFICATION CHECK ---
        if (user.isVerified === false) {
            return res.status(403).json({
                success: false,
                isUnverified: true,
                email: user.email,
                message: "Email verification required",
                status: 'unverified'
            });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({
                success: false,
                message: "Account suspended",
                status: 'suspended'
            });
        }

        // 2. Refund Any Of This User's Expired SMS Numbers Before Showing The Balance
        const expiry = await expireStaleSmsOrders({ userId: user._id }, 5).catch(err => {
            console.error("Lazy SMS Expiry Error:", err.message);
            return { refunded: 0 };
        });
        if (expiry.refunded > 0) {
            const fresh = await User.findById(user._id).select('balance bonusBalance').lean();
            user.balance = fresh?.balance ?? user.balance;
            user.bonusBalance = fresh?.bonusBalance ?? user.bonusBalance;
        }

        // 3. Retry A Referral Credit That Failed After A Qualifying Top-Up
        if (user.referralStatus === 'qualified') {
            await creditReferrer(user._id).catch(err => console.error("Referral Retry Error:", err));
        }

        // 4. Referral Program Terms And Friends Still Waiting To Top Up
        const referral = await getReferralSettings();
        const pendingReferralCount = user.referralCode
            ? await User.countDocuments({ referredBy: user.referralCode, referralStatus: 'pending' })
            : 0;

        // 5. Return user data (Removed USD fields)
        return res.json({
            success: true, 
            _id: user._id,
            fullName: user.fullName,
            email: user.email, 
            status: user.status || 'active',
            isVerified: user.isVerified, // Included for frontend UI state
            balance: user.balance || 0, 
            bonusBalance: user.bonusBalance || 0, 
            hasDeposited: user.hasDeposited || "",
            referralCode: user.referralCode || "",
            referralCount: user.referralCount || 0,
            pendingReferralCount,
            referralBonusNGN: referral.bonusNGN,
            referralMilestone: referral.milestone,
            referralMinDepositNGN: referral.minDepositNGN,
            createdAt: user.createdAt // Shown as "Joined <month year>" on the profile page
        });

    } catch (err) {
        console.error("JWT Verification Error:", err.message);
        return res.status(401).json({ success: false, message: "Unauthorized or expired token" });
    }
}

// --- 1. Initiate Topup (NGN Only) ---
const TOPUP_MIN_NGN = 100;
const TOPUP_MAX_NGN = 5000000;

async function handleInitiateTopup(req, res) {
    const { amountNGN } = req.body; // Amount the user wants credited to their wallet

    const creditNGN = Math.round(Number(amountNGN));
    if (!Number.isFinite(creditNGN) || creditNGN < TOPUP_MIN_NGN || creditNGN > TOPUP_MAX_NGN) {
        return res.status(400).json({ success: false, message: `Enter an amount between ₦${TOPUP_MIN_NGN.toLocaleString()} and ₦${TOPUP_MAX_NGN.toLocaleString()}.` });
    }

    try {
        const user = await requireUser(req, res);
        if (!user) return;

        // Final charge = wallet credit + globalMarkup (the markup is kept as the fee)
        const settings = await getSystemSettingsCached();
        const MARKUP = Math.max(Number(settings?.globalMarkup || 0), 0);
        const finalAmountNGN = Math.round(creditNGN + MARKUP);

        const tx_ref = `TOPUP-${Date.now()}-${user._id.toString().slice(-4)}`;

        // Record what this top-up charges and credits before the user can pay (see TopupIntent)
        await TopupIntent.create({ reference: tx_ref, userId: user._id, creditNGN, chargeNGN: finalAmountNGN });

        // Initiate Flutterwave Payment
        const response = await fetch("https://api.flutterwave.com/v3/payments", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                tx_ref,
                amount: finalAmountNGN,
                currency: "NGN",
                redirect_url: `${APP_BASE_URL}/fund-wallet`,
                customer: {
                    email: user.email,
                    name: user.fullName
                },
                meta: {
                    userId: user._id.toString(),
                    type: "WALLET_TOPUP",
                    amountNGN: finalAmountNGN, // Kept for older verify logic
                    chargeNGN: finalAmountNGN, // What the user must pay
                    creditNGN // What lands in the wallet
                },
                customizations: {
                    title: "DeemaxHub Wallet Topup",
                    logo: `${APP_BASE_URL}/assets/logo.png`
                }
            }),
        });

        const data = await response.json();
        if (data.status !== "success") throw new Error(data.message);

        return res.json({ success: true, link: data.data.link });

    } catch (err) {
        console.error("Topup Init Error:", err);
        return res.status(500).json({ success: false, message: "Could not initiate payment" });
    }
}

/**
 * Verifies a Flutterwave transaction and credits the wallet exactly once.
 * Shared by the redirect check (verify-topup) and the Flutterwave webhook.
 * Returns { httpStatus, body }.
 */
async function settleFlutterwaveTopup(transactionId) {
    const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
            "Content-Type": "application/json"
        },
    });

    const flwData = await response.json();
    if (!flwData || flwData.status !== "success" || !flwData.data) {
        return { httpStatus: 400, body: { success: false, message: "Gateway verification failed" } };
    }

    const flwStatus = flwData.data.status;
    const txRef = String(flwData.data.tx_ref || '');
    const flwAmountNGN = Number(flwData.data.amount);

    // 1. Only Our Own NGN Wallet Top-Ups Are Accepted
    if (!txRef.startsWith('TOPUP-') || flwData.data.currency !== 'NGN') {
        return { httpStatus: 400, body: { success: false, message: "This payment is not a wallet top-up." } };
    }

    // ⚠️ CRITICAL: The user and the amounts come from the top-up initiate-topup recorded, never from
    // the payment's meta (a checkout opened with our public key can carry any meta it likes)
    const intent = await TopupIntent.findOne({ reference: txRef }).lean();
    if (!intent) {
        console.error(`⚠️ CRITICAL: Flutterwave payment ${transactionId} (${txRef}) has no top-up record. Not credited; check it in the Flutterwave dashboard.`);
        return { httpStatus: 400, body: { success: false, message: "This payment wasn't started from your DeemaxHub wallet. Contact support." } };
    }
    const userId = intent.userId;

    const existingTx = await Transaction.findOne({ reference: txRef }).lean();
    if (existingTx && existingTx.status === 'successful') {
        return { httpStatus: 200, body: { success: true, newBalance: existingTx.balanceAfter, message: "Transaction already processed." } };
    }

    // 2. Pending / Failed: Record The State (with the required fields) And Stop
    if (flwStatus !== "successful") {
        const finalStatus = flwStatus === "pending" ? "pending" : "failed";
        await Transaction.findOneAndUpdate(
            { reference: txRef, status: { $ne: 'successful' } },
            { $set: {
                userId, type: 'credit', purpose: 'deposit',
                amountNGN: intent.creditNGN,
                status: finalStatus,
                paymentMethod: flwData.data.payment_type || 'card',
                metadata: flwData.data
            } },
            { upsert: true }
        ).catch(err => {
            if (err.code !== 11000) throw err; // A concurrent success already won
        });
        return { httpStatus: 200, body: { success: (finalStatus === 'pending'), status: finalStatus, message: `Transaction ${finalStatus}.` } };
    }

    // 3. Check The Amount Paid Covers The Charge We Created
    const chargeNGN = Number(intent.chargeNGN);
    if (!Number.isFinite(flwAmountNGN) || flwAmountNGN + 0.01 < chargeNGN) {
        console.error(`⚠️ Top-up ${txRef} underpaid: paid ₦${flwAmountNGN}, expected ₦${chargeNGN}`);
        return { httpStatus: 400, body: { success: false, message: "Amount paid does not match the top-up. Contact support." } };
    }

    // Credit the requested amount and keep the markup (the top-up fee)
    const creditNGN = Math.round(Number(intent.creditNGN));

    const { minDepositNGN } = await getReferralSettings();

    // 4. Credit Wallet And Write The Record In One Transaction
    // The unique reference index makes a second concurrent credit fail and roll back.
    let referralQualified = false;
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const updatedUser = await User.findOneAndUpdate(
            { _id: userId },
            { $inc: { balance: creditNGN }, $set: { hasDeposited: true } },
            { returnDocument: 'after', session }
        );
        if (!updatedUser) throw new Error("User record not found");

        const balanceAfter = Number(updatedUser.balance || 0);
        const balanceBefore = balanceAfter - creditNGN;

        await Transaction.findOneAndUpdate(
            { reference: txRef, status: { $ne: 'successful' } },
            { $set: {
                userId: updatedUser._id,
                type: 'credit',
                purpose: 'deposit',
                amountNGN: creditNGN,
                status: 'successful',
                paymentMethod: flwData.data.payment_type || 'card',
                balanceBefore,
                balanceAfter,
                bonusBefore: updatedUser.bonusBalance || 0,
                bonusAfter: updatedUser.bonusBalance || 0,
                metadata: { ...flwData.data, chargedNGN: flwAmountNGN, feeNGN: Math.max(flwAmountNGN - creditNGN, 0) }
            } },
            { upsert: true, session }
        );

        // 5. A Big Enough Top-Up Qualifies A Pending Referral (committed with the deposit)
        if (updatedUser.referralStatus === 'pending' && creditNGN >= minDepositNGN) {
            const qualified = await User.updateOne(
                { _id: updatedUser._id, referralStatus: 'pending' },
                { $set: { referralStatus: 'qualified' } },
                { session }
            );
            referralQualified = qualified.modifiedCount === 1;
        }

        await session.commitTransaction();
        console.log(`✅ Top-up ${txRef}: ₦${creditNGN} credited to ${updatedUser.email}`);

        // 6. Count The Referral (a failure here is retried on the next profile load)
        if (referralQualified) {
            await creditReferrer(updatedUser._id).catch(err => console.error("Referral Credit Error:", err));
        }

        return { httpStatus: 200, body: { success: true, amountNGN: creditNGN, newBalance: balanceAfter, message: "Wallet funded successfully!" } };
    } catch (err) {
        await session.abortTransaction().catch(() => {});
        if (err.code === 11000 || err.codeName === 'WriteConflict') {
            const settled = await Transaction.findOne({ reference: txRef }).lean();
            return { httpStatus: 200, body: { success: true, newBalance: settled?.balanceAfter, message: "Transaction already processed." } };
        }
        throw err;
    } finally {
        session.endSession();
    }
}

// --- Verify Topup (called by the Fund Wallet page after the Flutterwave redirect) ---
async function handleVerifyTopup(req, res) {
    const { transactionId } = req.body;

    if (!transactionId || !/^\d+$/.test(String(transactionId))) {
        return res.status(400).json({ success: false, message: "Transaction ID is required" });
    }

    try {
        const result = await settleFlutterwaveTopup(String(transactionId));
        return res.status(result.httpStatus).json(result.body);
    } catch (err) {
        console.error("VERIFICATION ERROR:", err.message);
        return res.status(500).json({ success: false, message: "Could not verify payment. If you were charged, contact support." });
    }
}

// --- Flutterwave Webhook (credits payments even if the user closed the tab) ---
// Set the same secret hash in Flutterwave Dashboard > Settings > Webhooks and in FLW_WEBHOOK_HASH.
async function handleFlutterwaveWebhook(req, res) {
    const expectedHash = process.env.FLW_WEBHOOK_HASH;
    const receivedHash = String(req.headers['verif-hash'] || '');

    if (!expectedHash || receivedHash.length !== expectedHash.length ||
        !crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash))) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const transactionId = req.body?.data?.id;
    if (!transactionId) return res.status(200).json({ success: true, message: "Ignored" });

    try {
        // Never trust the webhook body itself: re-verify with Flutterwave's API
        const result = await settleFlutterwaveTopup(String(transactionId));
        return res.status(200).json({ success: result.body.success, message: result.body.message });
    } catch (err) {
        console.error("Flutterwave Webhook Error:", err.message);
        return res.status(500).json({ success: false, message: "Webhook processing failed" }); // Flutterwave retries
    }
}

// --- SERVER-SIDE PRICE CATALOGS ---
// Prices are only ever read from here, never from the request body.
// Keep these in step with the carrier lists in smsuser/esim-refill.html and esim-activation.html.
const ESIM_REFILL_PLANS = {
    tmobile: { name: 'T-Mobile $15 (Prepaid)', price: 28000 },
    tmobile_3months: { name: 'T-Mobile 3 Months Carrier eSIM', price: 65000 },
    tmobile_6months: { name: 'T-Mobile 6 Months Carrier eSIM', price: 115000 },
    att: { name: 'AT&T $35 (Prepaid)', price: 58000 },
    att_3months: { name: 'AT&T 3 Months Carrier eSIM', price: 95000 },
    att_6months: { name: 'AT&T 6 Months Carrier eSIM', price: 165000 },
    '1month': { name: 'One Month Carrier eSIM', price: 41000 },
    '3months': { name: '3 Months Carrier eSIM', price: 63000 }
};

const ESIM_ACTIVATION_PLANS = {
    tmobile: { name: 'T-Mobile (Prepaid)', price: 45000, label: 'One Month' },
    tmobile_3months: { name: 'T-Mobile 3 Months (Prepaid)', price: 120000, label: '3 Months' },
    tmobile_6months: { name: 'T-Mobile 6 Months (Prepaid)', price: 220000, label: '6 Months' },
    att: { name: 'AT&T (Prepaid)', price: 75000, label: 'One Month' },
    att_3months: { name: 'AT&T 3 Months (Prepaid)', price: 200000, label: '3 Months' },
    att_6months: { name: 'AT&T 6 Months (Prepaid)', price: 380000, label: '6 Months' },
    '1month': { name: 'One Month Carrier eSIM', price: 25000, label: 'One Month' },
    '3months': { name: '3 Months Carrier eSIM', price: 60000, label: '3 Months' },
    '1year': { name: 'One Year Carrier eSIM', price: 100000, label: 'One Year' }
};

const RDP_PLANS = {
    tier1: { id: "tier1", name: "USA Tier 1", price: 30000, ram: "4GB", cpu: "2 Cores", storage: "60GB SSD", net: "1Gbps" },
    tier2: { id: "tier2", name: "USA Tier 2", price: 40000, ram: "6GB", cpu: "3 Cores", storage: "100GB SSD", net: "1Gbps" },
    tier3: { id: "tier3", name: "USA Tier 3", price: 50000, ram: "8GB", cpu: "4 Cores", storage: "140GB SSD", net: "2Gbps" },
    tier4: { id: "tier4", name: "USA Tier 4", price: 65000, ram: "12GB", cpu: "6 Cores", storage: "180GB SSD", net: "2Gbps" },
    tier5: { id: "tier5", name: "USA Tier 5", price: 80000, ram: "18GB", cpu: "8 Cores", storage: "240GB SSD", net: "3Gbps" },
    tier6: { id: "tier6", name: "USA Tier 6", price: 95000, ram: "24GB", cpu: "8 Cores", storage: "280GB SSD", net: "3Gbps" }
};
const RDP_ADDON_PRICE_NGN = 5000; // Per extra CPU core or GB of storage
const RDP_MAX_EXTRA_CPU = 32;
const RDP_MAX_EXTRA_STORAGE_GB = 2000;

// Finds a catalog entry by id, falling back to the display name older pages send
function findCatalogPlan(catalog, id, name) {
    if (typeof id === 'string' && catalog[id]) return { id, ...catalog[id] };
    const match = Object.entries(catalog).find(([, plan]) => plan.name === name);
    return match ? { id: match[0], ...match[1] } : null;
}

// Trims a client string and caps its length (null for non-strings)
function cleanText(value, maxLength = 200) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim().slice(0, maxLength);
    return text || null;
}

async function handlePurchaseWithWallet(req, res) {
    // 1. DESTRUCTURING (All body variables defined here)
    const {
        vpnId, proxyId, rdpId,
        accountProductId, quantity,
        carrierName, carrierId, productImage,
        coverageCountry, mobileNumber,
        planIndex,
        metadata, useBonus
    } = req.body;
    const meta = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : {};
    const attempt = trackPurchaseAttempt(res); // Any failure below is logged for the admin User Activity page

    try {
        const user = await requireUser(req, res);
        if (!user) return;
        attempt.user = user;

        if (!user.isVerified) {
            return res.status(403).json({ success: false, isUnverified: true, email: user.email, message: "Please verify your email address to continue." });
        }

        let itemType;
        let costNGN = 0;
        let productDetails = { name: "", plan: "" };
        let orderSpecifics = {};
        let orderMetadata = {};
        let isOnlineSimFlow = false; // Flag to execute downstream vendor calls safely
        let smsQuote = null; // Server-side SMS price and provider details
        let accountQuote = null; // Server-side Sameeha product, price and quantity
        const targetServiceCode = cleanText(meta.serviceCode || req.body.serviceCode, 40);
        const planIdx = Number.isInteger(Number(planIndex)) ? Number(planIndex) : -1;

        const recentOrder = await Order.findOne({
            userId: user._id,
            createdAt: { $gt: new Date(Date.now() - 1500) }, // 1.5 seconds prevents double-clicks, allows fast multi-buys
            $or: [
                ...(targetServiceCode ? [{ "metadata.serviceCode": targetServiceCode }] : []),
                ...(vpnId ? [{ productType: "VPN" }] : []),
                ...(proxyId ? [{ productType: "Proxy" }] : []),
                ...(rdpId ? [{ productType: "RDP" }] : []),
                ...(accountProductId !== undefined ? [{ productType: "Account" }] : [])
            ]
        });

        if (recentOrder) {
            return res.status(429).json({
                success: false,
                message: "Duplicate submission detected. Please wait a moment."
            });
        }

        // 2. RESOLVE PRODUCT AND PRICE (no writes yet)
        if (vpnId) {
            attempt.productType = "VPN";
            if (!mongoose.isValidObjectId(vpnId)) return res.status(400).json({ success: false, message: "Invalid VPN selected" });
            const vpnLookup = await VPN.findById(vpnId).select('name plans stock').lean();
            if (!vpnLookup || (vpnLookup.stock || 0) <= 0) {
                return res.status(404).json({ success: false, message: "VPN unavailable or out of stock" });
            }
            if (!vpnLookup.plans || !vpnLookup.plans[planIdx]) {
                return res.status(400).json({ success: false, message: "Invalid plan selected" });
            }

            itemType = "VPN";
            costNGN = Math.round(Number(vpnLookup.plans[planIdx].price));
            productDetails.name = vpnLookup.name;
            productDetails.plan = vpnLookup.plans[planIdx].duration;
        }

        else if (proxyId) {
            attempt.productType = "Proxy";
            if (!mongoose.isValidObjectId(proxyId)) return res.status(400).json({ success: false, message: "Invalid proxy selected" });
            const proxyLookup = await Proxy.findById(proxyId).select('name plans stock').lean();
            if (!proxyLookup || (proxyLookup.stock || 0) <= 0) {
                return res.status(404).json({ success: false, message: "Proxy unavailable or out of stock" });
            }
            if (!proxyLookup.plans || !proxyLookup.plans[planIdx]) {
                return res.status(400).json({ success: false, message: "Invalid plan selected" });
            }

            itemType = "Proxy";
            costNGN = Math.round(Number(proxyLookup.plans[planIdx].price));
            productDetails.name = proxyLookup.name;
            productDetails.plan = `${proxyLookup.plans[planIdx].ip_count || 0} IPs`;
        }

        else if (accountProductId !== undefined) {
            itemType = "Account";
            attempt.productType = itemType;
            const productId = Number(accountProductId);
            const keyCount = quantity === undefined ? 1 : Number(quantity);
            if (!Number.isInteger(productId) || productId <= 0) {
                return res.status(400).json({ success: false, message: "Invalid product selected" });
            }
            if (!Number.isInteger(keyCount) || keyCount < 1 || keyCount > ACCOUNT_MAX_QUANTITY) {
                return res.status(400).json({ success: false, message: `Quantity must be between 1 and ${ACCOUNT_MAX_QUANTITY}.` });
            }

            // 1. Find The Product's Category, Then Reload That Category For A Live Price And Stock
            let product = null;
            try {
                const catalog = await getAccountCatalog();
                const cached = catalog.vendorProducts.find(p => Number(p.id) === productId);
                if (cached) {
                    const live = (await fetchSameehaProducts(cached.category_id)).find(p => Number(p.id) === productId);
                    if (live) [product] = await priceAccountCatalog([live], catalog.categories);
                }
            } catch (err) {
                console.error("Account Price Lookup Error:", err.message);
                return res.status(502).json({ success: false, message: "Could not reach the supplier. Please try again shortly." });
            }

            if (!product || product.hidden) {
                return res.status(404).json({ success: false, message: "This product is no longer available. Refresh the page." });
            }
            attempt.label = product.name;
            if (!product.inStock || product.stock < keyCount) {
                attempt.reason = 'out_of_stock';
                return res.status(404).json({ success: false, message: product.inStock ? `Only ${product.stock} left in stock.` : "This product is out of stock." });
            }

            // 2. Price Comes From The Server (admin fixed price or vendor price + markup)
            costNGN = Math.round(product.priceNGN * keyCount);
            accountQuote = { ...product, quantity: keyCount };
            productDetails.name = product.name;
            productDetails.plan = `${product.categoryName} × ${keyCount}`;
        }

        else if (meta.serviceType === 'virtual_number') {
            itemType = "SmsNumber";

            // 1. Price Comes From The Live Vendor Catalog, Never The Request
            const serviceCode = (targetServiceCode || '').toLowerCase();
            const countryId = cleanText(req.body.countryId ?? meta.countryId ?? meta.countryCode, 20);
            Object.assign(attempt, { productType: itemType, label: cleanText(meta.serviceName, 80) || serviceCode.toUpperCase(), country: cleanText(meta.countryName, 80) });

            if (!serviceCode || !countryId) {
                return res.status(400).json({ success: false, message: "Select a service and country first." });
            }

            // One price per country: the admin's fixed operator, or the automatic pool
            const countries = await getSmsCountryPrices(serviceCode);
            const country = countries.find(c => String(c.countryId) === countryId);
            if (!country) {
                attempt.reason = 'unavailable';
                return res.status(400).json({ success: false, message: "This number is no longer available. Refresh and pick again." });
            }
            const tier = country.tier;
            attempt.country = country.countryName;

            costNGN = Math.round(tier.amount);
            smsQuote = {
                serviceCode,
                countryId: country.countryId,
                countryName: country.countryName,
                providerId: tier.providerId,
                poolMode: country.poolMode,
                costUsd: tier.costUsd,
                baseCostNGN: tier.baseCostNGN,
                pricing: tier.pricing // Which price rule set the amount
            };

            productDetails.name = `DeemaxHub Global Provision (${country.countryId})`;
            productDetails.plan = cleanText(meta.serviceName, 80) || "SMS Verification";
            isOnlineSimFlow = true;

            // 2. Check SMSBower Has Enough Provider Funds To Cover The Base Cost (skipped in demo mode)
            if (!isSmsDemoMode()) {
            try {
                const balanceRes = await smsBowerClient.get('', { params: { action: 'getBalance' } });

                let providerBalanceUSD = 0;
                const balanceText = typeof balanceRes.data === 'string' ? balanceRes.data : JSON.stringify(balanceRes.data);

                if (balanceText.startsWith('ACCESS_BALANCE:')) {
                    providerBalanceUSD = parseFloat(balanceText.split(':')[1]) || 0;
                } else if (typeof balanceRes.data?.balance === 'number') {
                    providerBalanceUSD = balanceRes.data.balance;
                }

                const providerBalanceNGN = providerBalanceUSD * (await getUsdToNgnRate());
                if (providerBalanceNGN < smsQuote.baseCostNGN) {
                    attempt.reason = 'provider_out_of_funds';
                    return res.status(400).json({
                        success: false,
                        message: "System provider balance is currently low. Please try again later."
                    });
                }
            } catch (err) {
                console.error("SMS Balance Verification Error:", err.response?.data || err.message);
                return res.status(502).json({
                    success: false,
                    message: "Failed to communicate with SMS provider gateway."
                });
            }
            }
        }
        else if (rdpId) {
            itemType = "RDP";
            const selectedTier = typeof rdpId === 'string' ? RDP_PLANS[rdpId] : null;
            if (!selectedTier) return res.status(404).json({ success: false, message: "RDP Plan not found" });

            const extraCPUCount = parseInt(meta.extraCPU || 0) || 0;
            const extraStorageGB = parseInt(meta.extraStorage || 0) || 0;
            if (extraCPUCount < 0 || extraStorageGB < 0 || extraCPUCount > RDP_MAX_EXTRA_CPU || extraStorageGB > RDP_MAX_EXTRA_STORAGE_GB) {
                return res.status(400).json({ success: false, message: "Invalid extra CPU or storage amount." });
            }

            const osChoice = cleanText(meta.osChoice, 60) || "Windows Server";
            costNGN = Math.round(Number(selectedTier.price) + (extraCPUCount * RDP_ADDON_PRICE_NGN) + (extraStorageGB * RDP_ADDON_PRICE_NGN));
            productDetails.name = selectedTier.name;
            productDetails.plan = `${selectedTier.ram} RAM | ${osChoice}`;

            orderSpecifics = {
                ram: selectedTier.ram,
                cpu: selectedTier.cpu,
                storage: selectedTier.storage,
                net: selectedTier.net,
                os: osChoice,
                extraCPU: extraCPUCount,
                extraStorage: extraStorageGB,
                ipAddress: "",
                rdpUsername: "",
                rdpPassword: "",
                port: ""
            };
            orderMetadata = {
                fullName: cleanText(meta.fullName, 100),
                ram: selectedTier.ram,
                cpu: selectedTier.cpu,
                storage: selectedTier.storage,
                net: selectedTier.net,
                extraCPU: extraCPUCount,
                extraStorage: extraStorageGB,
                osChoice
            };
        }
        else if (meta.activationEmail && meta.firstName) {
            itemType = "eSIM_Activation";
            const plan = findCatalogPlan(ESIM_ACTIVATION_PLANS, carrierId, carrierName);
            const deviceName = cleanText(mobileNumber, 100);
            if (!plan) return res.status(400).json({ success: false, message: "Select a valid eSIM plan." });
            if (!deviceName) return res.status(400).json({ success: false, message: "Device name is required." });

            costNGN = plan.price;
            productDetails.name = plan.name;
            productDetails.plan = `₦${costNGN.toLocaleString()} ${plan.label} Activation`;

            orderMetadata = {
                firstName: cleanText(meta.firstName, 100),
                lastName: cleanText(meta.lastName, 100),
                activationEmail: cleanText(meta.activationEmail, 200),
                address: cleanText(meta.address, 300) || 'N/A',
                zip: cleanText(meta.zip, 20) || 'N/A',
                activationType: cleanText(meta.activationType, 40) || 'Prepaid',
                carrierId: plan.id
            };

            orderSpecifics = {
                carrier: { id: plan.id, name: plan.name, image: cleanText(productImage, 300) },
                targetNumber: deviceName,
                deviceName,
                customerDetails: {
                    firstName: orderMetadata.firstName,
                    lastName: orderMetadata.lastName,
                    address: orderMetadata.address,
                    zipCode: orderMetadata.zip,
                    email: orderMetadata.activationEmail
                },
                instructions: "Payment Confirmed. DeemaxHub is verifying your activation details."
            };
        }
        else if (carrierName && mobileNumber) {
            itemType = "eSIM_Refill";
            const plan = findCatalogPlan(ESIM_REFILL_PLANS, carrierId, carrierName);
            const targetNumber = cleanText(mobileNumber, 40);
            const country = cleanText(coverageCountry, 80) || 'Global';
            if (!plan) return res.status(400).json({ success: false, message: "Select a valid eSIM carrier." });
            if (!targetNumber) return res.status(400).json({ success: false, message: "eSIM mobile number is required." });

            costNGN = plan.price;
            productDetails.name = plan.name;
            productDetails.plan = `₦${costNGN.toLocaleString()}`;
            orderSpecifics = {
                carrier: { id: plan.id, name: plan.name, image: cleanText(productImage, 300) },
                target: { number: targetNumber, country },
                targetNumber,
                country,
                instructions: "Payment Confirmed. Your refill is being processed by the technical team."
            };
        }

        if (!itemType) {
            return res.status(400).json({ success: false, message: "No product selected." });
        }
        Object.assign(attempt, { productType: itemType, label: attempt.label || productDetails.name, amount: costNGN });
        if (!Number.isFinite(costNGN) || costNGN <= 0) {
            attempt.reason = 'pricing_misconfigured';
            console.error(`⚠️ Refusing ${itemType} purchase with invalid price:`, costNGN);
            return res.status(400).json({ success: false, message: "This product has no valid price. Contact support." });
        }

        // --- WALLET CALCULATIONS ---
        const mainBal = Number(user.balance || 0);
        const bonusBal = Number(user.bonusBalance || 0);
        const isBonusUnlocked = user.hasDeposited === true; // Only the user's own Flutterwave top-up unlocks it (an admin credit doesn't)
        const canUseBonus = useBonus === true && isBonusUnlocked && bonusBal > 0;
        const buyingPower = canUseBonus ? (mainBal + bonusBal) : mainBal;

        if (buyingPower < costNGN) {
            let errorMsg = `Insufficient Funds. Required: ₦${costNGN.toLocaleString()}.`;
            if (!useBonus && (mainBal + bonusBal) >= costNGN) {
                errorMsg += " (Try enabling your Bonus Balance)";
            } else if (!isBonusUnlocked && bonusBal > 0) {
                errorMsg += " (Bonus locked. Deposit to unlock)";
            }
            attempt.reason = 'insufficient_balance';
            return res.status(400).json({ success: false, message: errorMsg });
        }

        let remainingToPay = costNGN;
        let bonusDeduction = 0;

        if (canUseBonus) {
            bonusDeduction = Math.min(bonusBal, remainingToPay);
            remainingToPay -= bonusDeduction;
        }
        const mainDeduction = remainingToPay;
        const paymentReference = `WAL-${Date.now()}-${user._id.toString().slice(-4)}`;

        // ATOMIC USER DEBIT CONTEXT
        // Both balances are guarded so concurrent requests can't overspend either wallet
        const debitFilter = { _id: user._id, balance: { $gte: mainDeduction } };
        if (bonusDeduction > 0) debitFilter.bonusBalance = { $gte: bonusDeduction };
        const debitUpdate = { $inc: { balance: -mainDeduction, bonusBalance: -bonusDeduction } };

        // --- SAMEEHA ACCOUNT VEND & ORDER RECORDING ---
        // The vendor call can't sit inside a Mongo transaction: debit first, buy, refund on any failure
        if (itemType === "Account") {
            const updatedUser = await User.findOneAndUpdate(debitFilter, debitUpdate, { returnDocument: 'after' });
            if (!updatedUser) {
                attempt.reason = 'insufficient_balance';
                return res.status(400).json({ success: false, message: "Transaction failed. Please check your balance and try again." });
            }

            const refundWallet = () => User.findByIdAndUpdate(user._id, {
                $inc: { balance: mainDeduction, bonusBalance: bonusDeduction }
            }).catch(err => console.error(`⚠️ CRITICAL: Refund failed for ${user.email} (₦${costNGN}):`, err.message));

            // 1. Buy The Keys (wallet already debited)
            let vendorReply;
            try {
                vendorReply = await sameehaRequest('post', '/buy', {
                    body: { product: accountQuote.id, quantity: accountQuote.quantity },
                    timeout: ACCOUNT_BUY_TIMEOUT_MS
                });
            } catch (apiErr) {
                // No reply at all: Sameeha may still have filled it, so leave a trail to check its order history
                console.error(`⚠️ CRITICAL: Sameeha /buy gave no reply for ${user.email} (${paymentReference}, product ${accountQuote.id} × ${accountQuote.quantity}). Refunded the user; check Sameeha order history.`, apiErr.message);
                await refundWallet();
                return res.status(502).json({ success: false, message: "The supplier did not respond. You have not been charged. Please try again." });
            }

            const rawKeys = Array.isArray(vendorReply.data?.keys) ? vendorReply.data.keys : [];
            const keys = rawKeys.map(formatSameehaKey).filter(Boolean);
            if ((vendorReply.status !== 200 && vendorReply.status !== 201) || keys.length === 0) {
                console.error("Sameeha Buy Rejected:", vendorReply.status, vendorReply.data);
                await refundWallet();
                const VENDOR_ERROR_MESSAGES = {
                    402: "This product is temporarily unavailable. Please try again later.", // Our Sameeha wallet is low
                    404: "This product is no longer available. Refresh the page.",
                    409: "Not enough stock left for that quantity. Refresh the page.",
                    429: "The supplier is busy. Please try again in a minute."
                };
                attempt.reason = { 402: 'provider_out_of_funds', 404: 'unavailable', 409: 'out_of_stock' }[vendorReply.status] || 'provider_error';
                return res.status(502).json({
                    success: false,
                    message: `${VENDOR_ERROR_MESSAGES[vendorReply.status] || "Purchase failed at the supplier."} You have not been charged.`
                });
            }
            if (keys.length < accountQuote.quantity) {
                console.warn(`⚠️ Sameeha delivered ${keys.length} of ${accountQuote.quantity} keys for ${paymentReference}`);
            }
            const vendorOrderId = String(vendorReply.data.order_id ?? vendorReply.data.id ?? vendorReply.data.order?.id ?? '');

            // 2. Record The Sale (order and wallet log together)
            let createdOrder;
            try {
                await runTransactionWithRetry(async (session) => {
                    createdOrder = await new Order({
                        userId: user._id,
                        userEmail: user.email,
                        fullName: user.fullName || "Customer",
                        productType: 'Account',
                        vendorOrderId,
                        planName: productDetails.plan,
                        nodeName: productDetails.name,
                        amount: costNGN,
                        currency: 'NGN',
                        mainBalanceUsed: mainDeduction,
                        bonusBalanceUsed: bonusDeduction,
                        status: 'successful',
                        paymentReference,
                        activationCode: keys.join('\n'),
                        instructions: "Copy your account details below and keep them safe. They are also saved in your order history.",
                        metadata: {
                            vendor: 'sameeha',
                            vendorProductId: accountQuote.id,
                            categoryId: accountQuote.categoryId,
                            categoryName: accountQuote.categoryName,
                            quantity: accountQuote.quantity,
                            unitPriceNGN: accountQuote.priceNGN,
                            accountKeys: keys,
                            vendorKeys: rawKeys, // Sameeha's keys exactly as sent, in case the readable form drops a field
                            pricing: accountQuote.pricing, // { level, type, value } of the price rule used
                            vendorCostNGN: Number(vendorReply.data.charge) || Math.round(accountQuote.vendorPriceNGN * accountQuote.quantity)
                        },
                        deliveredAt: new Date()
                    }).save({ session });

                    // TRANSACTION LOG
                    await new Transaction({
                        userId: user._id,
                        type: 'debit',
                        purpose: 'purchase',
                        amountNGN: costNGN,
                        status: 'successful',
                        reference: paymentReference,
                        paymentMethod: 'wallet_combined',
                        balanceBefore: updatedUser.balance + mainDeduction,
                        balanceAfter: updatedUser.balance,
                        bonusBefore: updatedUser.bonusBalance + bonusDeduction,
                        bonusAfter: updatedUser.bonusBalance,
                        metadata: { orderId: createdOrder._id, product: productDetails.name, usedBonus: bonusDeduction > 0 }
                    }).save({ session });
                });
            } catch (recordErr) {
                // Keys are already bought; the admin can recover them from Sameeha's order history
                console.error(`⚠️ CRITICAL: Account Order Record Error (Sameeha order ${vendorOrderId}, ${user.email}). Refunded the user.`, recordErr);
                await refundWallet();
                attempt.reason = 'order_write_failed';
                return res.status(500).json({ success: false, message: "Could not record your order. You have not been charged." });
            }

            sendDeliveryEmail(user.email, {
                productType: 'Account',
                nodeName: productDetails.name,
                planName: productDetails.plan,
                amount: costNGN,
                paymentReference,
                accountKeys: keys,
                instructions: createdOrder.instructions,
                purchaseDate: createdOrder.createdAt || new Date()
            }).catch(err => console.error("📧 Customer Email Error:", err.message));

            return res.json({
                success: true,
                message: "Purchase successful!",
                balance: updatedUser.balance,
                bonusBalance: updatedUser.bonusBalance,
                order: toUserOrder(createdOrder),
                keys
            });
        }

        // --- EXCLUSIVE LIVE SMSBOWER API ALLOCATION & ORDER RECORDING ---
        if (isOnlineSimFlow) {
            const updatedUser = await User.findOneAndUpdate(debitFilter, debitUpdate, { returnDocument: 'after' });
            if (!updatedUser) {
                attempt.reason = 'insufficient_balance';
                return res.status(400).json({ success: false, message: "Transaction failed. Please check your balance and try again." });
            }

            const refundWallet = () => User.findByIdAndUpdate(user._id, {
                $inc: { balance: mainDeduction, bonusBalance: bonusDeduction }
            }).catch(err => console.error(`⚠️ CRITICAL: Refund failed for ${user.email} (₦${costNGN}):`, err.message));

            let trackingTzid, allocatedNumber, allocation;
            // DEMO NUMBER: no vendor call, the wallet is still debited so the money flow is real
            if (isSmsDemoMode()) {
                const demo = allocateSmsDemoNumber(smsQuote.countryId);
                trackingTzid = demo.tzid;
                allocatedNumber = demo.phoneNumber;
                allocation = {
                    poolMode: smsQuote.poolMode,
                    operatorUsed: 'demo',
                    vendorCostUsd: smsQuote.costUsd,
                    canGetAnotherSms: true
                };
            } else
            try {
                // ⚠️ CRITICAL: The wallet is already debited here. Both attempts share one time
                // budget, well inside Vercel's function limit, so the refund below always gets to run.
                const allocationDeadline = Date.now() + SMS_ALLOCATION_TIMEOUT_MS;
                const requestNumber = async (extraParams) => {
                    const timeLeft = allocationDeadline - Date.now();
                    if (timeLeft < 1500) return null; // Not enough time left for a second try
                    const sbResponse = await smsBowerClient.get('', {
                        params: { action: 'getNumberV2', service: smsQuote.serviceCode, country: smsQuote.countryId, ...extraParams },
                        timeout: timeLeft
                    });
                    return sbResponse.data;
                };
                // SMSBower getNumberV2 returns a JSON object on success
                const isAllocated = (reply) => Boolean(reply && (reply.phoneNumber || reply.activationId));

                // 1. Admin's Fixed Operator First, Otherwise The Automatic Pool
                let poolMode = smsQuote.poolMode;
                let data;
                if (poolMode === 'fixed') {
                    data = await requestNumber({ providerIds: smsQuote.providerId });

                    // 2. Fixed Operator Sold Out: Any Operator At Or Below Its Cost Keeps The Price And Margin
                    if (!isAllocated(data)) {
                        console.warn(`SMS fixed operator ${smsQuote.providerId} empty for ${smsQuote.serviceCode}/${smsQuote.countryId}:`, data);
                        poolMode = 'fallback';
                        data = await requestNumber({ maxPrice: smsQuote.costUsd });
                    }
                } else {
                    data = await requestNumber(smsQuote.providerId && smsQuote.providerId.length <= 3 ? { providerIds: smsQuote.providerId } : {});
                }

                if (!isAllocated(data)) {
                    await refundWallet();
                    const errorMsg = typeof data === 'string' ? data : (data?.error || data?.message || "Vendor out of stock or request rejected");
                    attempt.reason = /NO_NUMBERS|stock/i.test(String(errorMsg)) ? 'out_of_stock' : 'provider_error';
                    return res.status(400).json({ success: false, message: `Line Allocation Failed: ${errorMsg}` });
                }
                trackingTzid = String(data.activationId);
                allocatedNumber = String(data.phoneNumber);

                // 3. What SMSBower Actually Sold (admin reporting only)
                const reportedCostUsd = Number(data.activationCost) > 0 ? Number(data.activationCost) : null;
                allocation = {
                    poolMode,
                    operatorUsed: data.activationOperator != null
                        ? String(data.activationOperator).slice(0, 64)
                        : (poolMode === 'fallback' ? null : smsQuote.providerId),
                    vendorCostUsd: reportedCostUsd ?? (poolMode === 'fallback' ? null : smsQuote.costUsd),
                    canGetAnotherSms: data.canGetAnotherSms == null ? true : ['1', 'true', 'yes'].includes(String(data.canGetAnotherSms).toLowerCase())
                };
            } catch (apiErr) {
                console.error("Critical SMS API connection error:", apiErr.message);
                await refundWallet();
                return res.status(502).json({ success: false, message: "External vendor API processing timeout." });
            }

            // RECORD THE SALE (order, SMS tracker and wallet log together)
            let createdOrder;
            try {
                await runTransactionWithRetry(async (session) => {
                    await new SmsNumber({
                        userId: user._id,
                        userEmail: user.email,
                        vendorOrderId: trackingTzid,
                        countryId: smsQuote.countryId,
                        phoneNumber: allocatedNumber,
                        serviceName: smsQuote.serviceCode,
                        amount: costNGN,
                        status: 'pending'
                    }).save({ session });

                    createdOrder = await new Order({
                        userId: user._id,
                        userEmail: user.email,
                        fullName: user.fullName || 'User',
                        productType: 'SmsNumber',
                        vendorOrderId: trackingTzid,
                        planName: `${smsQuote.serviceCode.toUpperCase()} Virtual Number`,
                        amount: costNGN,
                        currency: 'NGN',
                        mainBalanceUsed: mainDeduction,
                        bonusBalanceUsed: bonusDeduction,
                        status: 'pending',
                        paymentReference: `SMS_${trackingTzid}_${Date.now()}`,
                        targetNumber: allocatedNumber,
                        country: smsQuote.countryId,
                        instructions: "Line allocated successfully. Waiting for SMS code...",
                        metadata: {
                            tzid: trackingTzid,
                            serviceCode: smsQuote.serviceCode,
                            serviceName: productDetails.plan,
                            countryCode: smsQuote.countryId,
                            countryName: smsQuote.countryName,
                            operator: smsQuote.providerId || null, // Operator the price was quoted from
                            operatorUsed: allocation.operatorUsed, // Operator SMSBower actually sold from
                            poolMode: allocation.poolMode, // 'auto', 'fixed' or 'fallback'
                            vendorCostUsd: allocation.vendorCostUsd,
                            vendorCostNGN: allocation.vendorCostUsd != null ? Math.round(allocation.vendorCostUsd * (await getUsdToNgnRate())) : null,
                            canGetAnotherSms: allocation.canGetAnotherSms,
                            markupApplied: smsQuote.pricing?.type === 'markup' ? smsQuote.pricing.value : null,
                            pricing: smsQuote.pricing || null // { level, type, value } of the price rule used
                        },
                        deliveredAt: new Date()
                    }).save({ session });

                    // TRANSACTION LOG
                    await new Transaction({
                        userId: user._id,
                        type: 'debit',
                        purpose: 'purchase',
                        amountNGN: costNGN,
                        status: 'successful',
                        reference: createdOrder.paymentReference,
                        paymentMethod: 'wallet_combined',
                        balanceBefore: updatedUser.balance + mainDeduction,
                        balanceAfter: updatedUser.balance,
                        bonusBefore: updatedUser.bonusBalance + bonusDeduction,
                        bonusAfter: updatedUser.bonusBalance,
                        metadata: { orderId: createdOrder._id, product: productDetails.name, usedBonus: bonusDeduction > 0 }
                    }).save({ session });
                });
            } catch (recordErr) {
                console.error("SMS Order Record Error:", recordErr);
                // Give the number back to the vendor and refund the user (demo numbers need no vendor call)
                if (!isSmsDemoVendorId(trackingTzid)) {
                    await smsBowerClient.get('', { params: { action: 'setStatus', status: 8, id: trackingTzid } }).catch(() => {});
                }
                await refundWallet();
                attempt.reason = 'order_write_failed';
                return res.status(500).json({ success: false, message: "Could not record your order. You have not been charged." });
            }

            // 3. Return a fully populated payload matching what frontend state checks
            return res.status(200).json({
                success: true,
                message: "Virtual number purchased successfully",
                order: {
                    ...toUserOrder(createdOrder),
                    phoneNumber: allocatedNumber,
                    targetNumber: allocatedNumber
                },
                phoneNumber: allocatedNumber,
                number: allocatedNumber,
                targetNumber: allocatedNumber,
                data: {
                    phoneNumber: allocatedNumber,
                    number: allocatedNumber,
                    targetNumber: allocatedNumber,
                    tzid: trackingTzid,
                    service: smsQuote.serviceCode
                }
            });
        }

        // DEBIT, VEND, ORDER AND LOG IN ONE DATABASE TRANSACTION
        // If any step fails nothing is kept: no charge, no lost credential, no orphan order.
        const session = await mongoose.startSession();
        let newOrder, updatedUser;
        try {
            session.startTransaction();

            updatedUser = await User.findOneAndUpdate(debitFilter, debitUpdate, { returnDocument: 'after', session });
            if (!updatedUser) {
                const failure = new Error("Insufficient funds at debit time");
                failure.userMessage = "Transaction failed. Please check your balance and try again.";
                throw failure;
            }

            // VEND STOCK: pop the first item and read it from the pre-update document,
            // so the credential handed out is exactly the one removed
            if (itemType === "VPN") {
                let before = await VPN.findOneAndUpdate(
                    { _id: vpnId, stock: { $gt: 0 }, 'pcAccounts.0': { $exists: true } },
                    { $pop: { pcAccounts: -1 }, $inc: { stock: -1 } },
                    { returnDocument: 'before', session }
                );
                let assigned = before?.pcAccounts?.[0];
                if (!before) {
                    before = await VPN.findOneAndUpdate(
                        { _id: vpnId, stock: { $gt: 0 }, 'phoneAccounts.0': { $exists: true } },
                        { $pop: { phoneAccounts: -1 }, $inc: { stock: -1 } },
                        { returnDocument: 'before', session }
                    );
                    assigned = before?.phoneAccounts?.[0];
                }
                if (!before || !assigned) {
                    const failure = new Error("VPN out of stock at vend time");
                    failure.userMessage = "VPN unavailable or out of stock";
                    failure.status = 404;
                    throw failure;
                }

                orderSpecifics = {
                    vpnCredentials: { username: assigned.username || "", password: assigned.password || "" },
                    username: assigned.username || "",
                    password: assigned.password || "",
                    pcUsername: assigned.username || "",
                    pcPassword: assigned.password || "",
                    activationCode: assigned.activationCode || "",
                    instructions: before.instructions || "Check your dashboard for setup steps.",
                    deviceLimit: before.deviceLimit || 1
                };
            }
            else if (itemType === "Proxy") {
                const before = await Proxy.findOneAndUpdate(
                    { _id: proxyId, stock: { $gt: 0 }, 'activationCodes.0': { $exists: true } },
                    { $pop: { activationCodes: -1 }, $inc: { stock: -1 } },
                    { returnDocument: 'before', session }
                );
                const assignedCode = before?.activationCodes?.[0];
                if (!assignedCode) {
                    const failure = new Error("Proxy out of stock at vend time");
                    failure.userMessage = "No activation codes available";
                    failure.status = 404;
                    throw failure;
                }

                orderSpecifics = {
                    activationCode: assignedCode,
                    instructions: before.instructions || "To activate your proxy, copy the code above into your provider's portal."
                };
                orderMetadata = { deliveredCode: assignedCode };
            }

            // CREATE SYSTEM ORDER ENTRY
            const targetNumber = orderSpecifics.targetNumber || orderSpecifics.target?.number;
            const targetCountry = orderSpecifics.country || orderSpecifics.target?.country || "NG";
            newOrder = await new Order({
                userId: user._id,
                userEmail: user.email,
                fullName: user.fullName || "Customer",
                productType: itemType,
                planName: productDetails.plan,
                nodeName: productDetails.name,
                amount: costNGN,
                mainBalanceUsed: mainDeduction,
                bonusBalanceUsed: bonusDeduction,
                currency: "NGN",
                status: itemType === "eSIM_Refill" ? "pending" : "successful", // Same statuses the admin pages already expect
                paymentReference: paymentReference,
                targetNumber,
                country: targetCountry,
                target: { number: targetNumber, country: targetCountry },
                ...orderSpecifics,
                metadata: {
                    ...orderMetadata,
                    isManualProcess: (itemType === "eSIM_Refill" || itemType === "eSIM_Activation" || itemType === "RDP")
                }
            }).save({ session });

            // TRANSACTION LOG
            await new Transaction({
                userId: user._id,
                type: 'debit',
                purpose: 'purchase',
                amountNGN: costNGN,
                status: 'successful',
                reference: paymentReference,
                paymentMethod: 'wallet_combined',
                balanceBefore: updatedUser.balance + mainDeduction,
                balanceAfter: updatedUser.balance,
                bonusBefore: updatedUser.bonusBalance + bonusDeduction,
                bonusAfter: updatedUser.bonusBalance,
                metadata: { orderId: newOrder._id, product: productDetails.name, usedBonus: bonusDeduction > 0 }
            }).save({ session });

            await session.commitTransaction();
        } catch (purchaseErr) {
            await session.abortTransaction().catch(() => {});
            if (purchaseErr.userMessage) {
                attempt.reason = purchaseErr.status === 404 ? 'out_of_stock' : 'insufficient_balance';
                return res.status(purchaseErr.status || 400).json({ success: false, message: purchaseErr.userMessage });
            }
            throw purchaseErr;
        } finally {
            session.endSession();
        }

        const manualProducts = ["eSIM_Refill", "eSIM_Activation", "RDP"];
        const isManual = manualProducts.includes(itemType);

        if (!isManual) {
            const deliveryCode = orderSpecifics.activationCode || "N/A";
            const deliveryInstructions = orderSpecifics.instructions || "Check dashboard for details.";

            sendDeliveryEmail(user.email, {
                ...orderSpecifics,
                productType: itemType,
                nodeName: productDetails.name,
                planName: productDetails.plan,
                amount: costNGN,
                paymentReference: paymentReference,
                confirmationNumber: paymentReference,
                activationCode: deliveryCode,
                instructions: deliveryInstructions,
                mainBalanceUsed: mainDeduction,
                bonusBalanceUsed: bonusDeduction,
                metadata: newOrder.metadata,
                purchaseDate: newOrder.createdAt || new Date()
            }).catch(err => console.error("📧 Customer Email Error:", err.message));
        }

        if (isManual) {
            try {
                await sendAdminNotification({
                    type: itemType,
                    email: user.email,
                    product: productDetails.name,
                    amount: `₦${costNGN.toLocaleString()}`,
                    reference: paymentReference,
                    target: newOrder.targetNumber || orderMetadata.activationEmail || 'N/A',
                    country: newOrder.country || 'N/A',
                    metadata: newOrder.metadata,
                    orderSpecifics: orderSpecifics,
                    planName: productDetails.plan || 'Standard',
                    ...(itemType === "RDP" ? orderSpecifics : {})
                });
                console.log("✅ Admin notification sent successfully");
            } catch (err) {
                console.error("📧 Admin Notification Error:", err.message);
            }
        }

        return res.json({
            success: true,
            message: isManual
                ? "Request submitted! Our team is processing your order."
                : "Purchase successful!",
            balance: updatedUser.balance,
            bonusBalance: updatedUser.bonusBalance,
            order: newOrder
        });

    } catch (err) {
        console.error("Wallet Purchase Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// Escapes every string in an object tree (for HTML templates built from order data)
function escapeDeep(value) {
    if (typeof value === 'string') return escapeHtml(value);
    if (Array.isArray(value)) return value.map(escapeDeep);
    if (value && typeof value === 'object' && !(value instanceof Date) && !mongoose.isValidObjectId(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeDeep(v)]));
    }
    return value;
}

const sendAdminNotification = async (rawOrderData) => {
    // ⚠️ CRITICAL: Names, numbers and addresses come from customers, so escape them first
    const orderData = escapeDeep(rawOrderData);

    // 1. Create Transporter inside the function
    const adminTransporter = createMailTransporter({ pool: true });

    const { type, email, amount, product, reference, target, metadata, orderSpecifics, country } = orderData;
    
    // Styles
    const labelStyle = "font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: bold; margin-bottom: 2px; display: block;";
    const valueStyle = "font-size: 13px; color: #1e293b; font-weight: 600;";
    
    let specificDetailsHtml = '';

    // Normalize type for comparison
    const orderType = type ? type.toLowerCase() : "";

  // --- RDP DETAILS ---
// --- RDP DETAILS ---
if (orderType === "rdp") {
    // 1. Extract values from root orderData (priority) or nested metadata
    const ram = orderData.ram || metadata?.ram || 'N/A';
    const os = orderData.os || metadata?.osChoice || 'Windows Server';
    const cpu = orderData.cpu || metadata?.cpu || 'N/A';
    const storage = orderData.storage || metadata?.storage || 'N/A';
    const net = orderData.net || metadata?.net || '1Gbps';
    
    // 2. Explicitly grab the extras
    const extraCPU = parseInt(orderData.extraCPU || metadata?.extraCPU || 0);
    const extraStorage = parseInt(orderData.extraStorage || metadata?.extraStorage || 0);

    specificDetailsHtml = `
        <div style="background: #f8fafc; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; margin: 12px 0;">
            <p style="font-size: 12px; margin:0 0 10px 0; color: #0F54C6; border-bottom: 1px solid #cbd5e1; padding-bottom: 5px;">
                <b>🖥️ RDP PROVISIONING SPECS</b>
            </p>
            <table width="100%" cellspacing="0" cellpadding="0">
                <tr>
                    <td width="50%" style="padding-bottom: 10px;">
                        <span style="${labelStyle}">OS</span>
                        <span style="${valueStyle}">${os}</span>
                    </td>
                    <td width="50%" style="padding-bottom: 10px;">
                        <span style="${labelStyle}">RAM</span>
                        <span style="${valueStyle}">${ram}</span>
                    </td>
                </tr>
                <tr>
                    <td width="50%" style="padding-bottom: 10px;">
                        <span style="${labelStyle}">Base CPU</span>
                        <span style="${valueStyle}">${cpu}</span>
                        ${extraCPU > 0 ? `<br><span style="color: #dc2626; font-size: 11px; font-weight: bold;">🔥 +${extraCPU} EXTRA CORES</span>` : ''}
                    </td>
                    <td width="50%" style="padding-bottom: 10px;">
                        <span style="${labelStyle}">Base Storage</span>
                        <span style="${valueStyle}">${storage}</span>
                        ${extraStorage > 0 ? `<br><span style="color: #dc2626; font-size: 11px; font-weight: bold;">🔥 +${extraStorage}GB EXTRA</span>` : ''}
                    </td>
                </tr>
                <tr>
                    <td colspan="2" style="border-top: 1px dashed #cbd5e1; padding-top: 10px;">
                        <span style="${labelStyle}">Network Speed</span>
                        <span style="${valueStyle}">${net}</span>
                    </td>
                </tr>
            </table>
            <div style="margin-top: 10px; background: #fffbeb; border: 1px solid #fef3c7; padding: 8px; border-radius: 4px;">
                <p style="font-size: 11px; color: #92400e; margin: 0;">
                    <b>Admin Note:</b> Please ensure the extra resources are added to the instance before sending credentials.
                </p>
            </div>
        </div>`;
}
    else if (orderType === "esim_refill") {
        specificDetailsHtml = `
            <div style="background: #f0fdf4; padding: 10px; border: 1px solid #bbf7d0; border-radius: 8px; margin: 12px 0;">
                <p style="font-size: 12px; margin:0 0 8px 0; color: #166534;"><b>📲 REFILL DETAILS</b></p>
                <table width="100%" cellspacing="0" cellpadding="2">
                    <tr>
                        <td width="50%"><span style="${labelStyle}">Target Number</span><span style="${valueStyle}">${target || 'N/A'}</span></td>
                        <td width="50%"><span style="${labelStyle}">Carrier</span><span style="${valueStyle}">${product || 'eSIM'}</span></td>
                    </tr>
                    <tr>
                        <td width="50%" style="padding-top:8px;"><span style="${labelStyle}">Country</span><span style="${valueStyle}">${country || 'N/A'}</span></td>
                        <td width="50%" style="padding-top:8px;"><span style="${labelStyle}">Plan</span><span style="${valueStyle}">${orderData.planName || 'Standard'}</span></td>
                    </tr>
                </table>
            </div>`;
    }
    // --- ESIM ACTIVATION DETAILS (NEW) ---
    else if (orderType === "esim_activation") {
        specificDetailsHtml = `
            <div style="background: #fff7ed; padding: 10px; border: 1px solid #ffedd5; border-radius: 8px; margin: 12px 0;">
                <p style="font-size: 12px; margin:0 0 8px 0; color: #9a3412;"><b>📶 ACTIVATION REQUEST</b></p>
                <table width="100%" cellspacing="0" cellpadding="2">
                    <tr>
                        <td width="50%"><span style="${labelStyle}">Subscriber</span><span style="${valueStyle}">${metadata?.firstName || ''} ${metadata?.lastName || ''}</span></td>
                        <td width="50%"><span style="${labelStyle}">Device</span><span style="${valueStyle}">${target || 'N/A'}</span></td>
                    </tr>
                    <tr>
                        <td colspan="2" style="padding-top:8px;">
                            <span style="${labelStyle}">Address</span>
                            <span style="${valueStyle}">${metadata?.address || 'N/A'}, ${metadata?.zip || ''}</span>
                        </td>
                    </tr>
                    <tr>
                        <td width="50%" style="padding-top:8px;"><span style="${labelStyle}">Carrier</span><span style="${valueStyle}">${product || 'N/A'}</span></td>
                        <td width="50%" style="padding-top:8px;"><span style="${labelStyle}">Type</span><span style="${valueStyle}">${metadata?.activationType || 'Prepaid'}</span></td>
                    </tr>
                </table>
            </div>`;
    }

    const htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; max-width: 450px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background: #ffffff;">
            <div style="background: #0F54C6; padding: 15px; text-align: center;">
                <img src="${APP_BASE_URL}/assets/logo.png" alt="DeemaxHub" width="100">
            </div>
            
            <div style="padding: 20px;">
                <h3 style="color: #0F54C6; font-size: 16px; margin: 0 0 15px 0; text-align: center;">🚨 New ${type.replace('_', ' ')} Order</h3>
                
                <div style="border-bottom: 1px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 10px;">
                    <span style="${labelStyle}">Customer Email</span>
                    <span style="${valueStyle}">${email}</span>
                </div>

                <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                    <div style="width: 48%;">
                        <span style="${labelStyle}">Amount</span>
                        <span style="font-size: 15px; color: #101828; font-weight: 800;">${amount}</span>
                    </div>
                    <div style="width: 48%;">
                        <span style="${labelStyle}">Ref</span>
                        <code style="font-size: 11px; background:#f1f5f9; padding:2px 4px; border-radius:4px;">${reference}</code>
                    </div>
                </div>

                ${specificDetailsHtml}

                <div style="text-align: center; margin-top: 20px;">
                    <a href="${APP_BASE_URL}/admin/dashboard"
                       style="background: #0F54C6; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: bold; display: inline-block; width: 80%;">
                        Complete Order
                    </a>
                </div>
            </div>
            
            <div style="background: #f8fafc; padding: 12px; text-align: center;">
                <p style="font-size: 10px; color: #94a3b8; margin: 0;">Priority System Alert &bull; DeemaxHub Admin</p>
            </div>
        </div>
    `;

    try {
        await adminTransporter.sendMail({
            from: mailFrom('DeemaxHub Alert'),
            to: process.env.ADMIN_EMAIL,
            subject: `🚨 ${rawOrderData.type.toUpperCase()}: ${rawOrderData.amount} from ${rawOrderData.email}`,
            html: htmlContent
        });
        console.log(`Admin alert sent for ${type}`);
    } catch (error) {
        console.error("Admin Mail Error:", error.message);
    }
};


const sendDeliveryEmail = async (userEmail, rawCredentials) => {
    // ⚠️ CRITICAL: Product names, instructions and codes come from admins and suppliers, and eSIM
    // details from customers, so every string is escaped before it goes into the HTML
    const credentials = escapeDeep(rawCredentials);

    // Receipt links and the attachment use the raw URL, https only: nodemailer reads any other
    // attachment path (C:\..., /etc/...) as a file on this server
    const rawReceiptUrl = String(rawCredentials.receiptUrl || rawCredentials.metadata?.receiptUrl || '');
    const safeReceiptUrl = /^https:\/\//i.test(rawReceiptUrl) ? rawReceiptUrl : '';
    const receiptHref = escapeHtml(safeReceiptUrl);

    const transporter = createMailTransporter();

   const type =(credentials.type || credentials.productType || "").trim();
const upperType = type.toUpperCase(); // Define this to use for the checks below

// 2. Format the Date
const rawDate = credentials.purchaseDate || new Date();
const purchaseDate = new Date(rawDate).toLocaleString('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short'
});

if (!type) {
    console.error("📧 Email Error: No product type provided in credentials object.");
    return;
}

const isVPN = upperType === "VPN";
const isRDP = upperType === "RDP";
const isProxy = upperType === "PROXY" || upperType === "PREMIUM PROXY"; 
const isESIM_Refill = type === "eSIM_Refill";       
const isESIM_Activation = type === "eSIM_Activation"; 
const isAccount = type === "Account";

    let subject, headerTitle, subHeader;

    // 2. Determine Subject and Headers
    if (isRDP) {
        subject = "🖥️ Your RDP Server is Ready!";
        headerTitle = "Server Provisioned!";
        subHeader = "Your high-performance RDP access details are below.";
    } else if (isVPN) {
        subject = "🔑 Your VPN Access Credentials";
        headerTitle = "VPN Activated!";
        subHeader = "Your Premium VPN Access is ready.";
    } else if (isESIM_Activation) {
        subject = "✅ eSIM Activated Successfully";
        headerTitle = "Activation Complete!";
        subHeader = "Your eSIM profile is now active and ready for use.";
    } else if (isAccount) {
        subject = "🔑 Your Account Details";
        headerTitle = "Order Delivered!";
        subHeader = "Your purchased account details are below. Keep them safe.";
    } else if (isESIM_Refill) {
        subject = "✅ eSIM Refill Confirmed";
        headerTitle = "Refill Successful!";
        subHeader = "Your eSIM has been successfully topped up.";
    } else {
        subject = `🌐 Your ${type} Activation Details`;
        headerTitle = `${type} Ready! 🌐`;
        subHeader = `Your ${type} details are provided below.`;
    }
    
    let dataTableHtml = '';
if (isProxy) {
    const displayCode = credentials.activationCode || 
                        (credentials.activationCodes && credentials.activationCodes.length > 0 ? credentials.activationCodes[0] : 'PENDING');
    const displayInstructions = credentials.instructions || 'Follow the dashboard instructions to activate.';    
    const displayService = credentials.name || credentials.nodeName || 'Proxy Service';
    const displayPlan = credentials.category || credentials.planName || 'Standard Plan';
        const displayAmount = Number(credentials.amount || 0).toLocaleString();
    const displayRef = credentials.paymentReference || credentials._id || 'N/A';

    dataTableHtml = `
        <tr>
            <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Service</span><br>
                <strong style="font-size: 13px; color: #0F54C6;">${displayService}</strong>
            </td>
            <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Category</span><br>
                <strong style="font-size: 13px; color: #101828;">${displayPlan}</strong>
            </td>
        </tr>
        <tr>
            <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Purchase Date</span><br>
                <strong style="font-size: 11px; color: #101828;">${new Date().toLocaleDateString()}</strong>
            </td>
            <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Amount Paid</span><br>
                <strong style="font-size: 13px; color: #101828;">₦${displayAmount}</strong>
            </td>
        </tr>
        <tr>
            <td colspan="2" style="border-top: 1px solid #D1E0FF; padding-top: 20px; text-align: center;">
                <div style="background: #f8faff; border: 1px dashed #0F54C6; padding: 20px; border-radius: 12px;">
                    <span style="font-size: 10px; color: #0F54C6; text-transform: uppercase; font-weight: 800; letter-spacing: 1px;">Your Activation Code</span><br>
                    <div style="margin-top: 10px; background: #ffffff; padding: 10px; border-radius: 8px; display: inline-block; border: 1px solid #e2e8f0;">
                        <strong style="font-size: 22px; font-family: 'Courier New', monospace; color: #101828; letter-spacing: 2px;">
                            ${displayCode}
                        </strong>
                    </div>
                    <p style="font-size: 11px; color: #E11D48; margin-top: 12px; font-weight: bold; text-transform: uppercase;">
                        ${displayInstructions}
                    </p>
                    <p style="font-size: 10px; color: #667085; margin-top: 5px;">
                        Use this code to activate your <strong>${displayService}</strong> subscription.
                    </p>
                </div>
            </td>
        </tr>
        <tr>
            <td colspan="2" style="padding-top: 15px; text-align: center;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase;">Transaction ID:</span><br>
                <code style="font-size: 10px; color: #98A2B3;">${displayRef}</code>
            </td>
        </tr>
    `;
}

if (isRDP) {
    // 1. Extract Hardware Values (Root Level priority)
    const ramValue = credentials.ram || credentials.metadata?.ram || "4GB";
    const osValue = credentials.os || credentials.osChoice || credentials.metadata?.osChoice || 'Windows Server';
    const netValue = credentials.net || credentials.metadata?.net || '1Gbps';    
    const extraCPU = parseInt(credentials.extraCPU || credentials.metadata?.extraCPU || 0);
    const extraStorage = parseInt(credentials.extraStorage || credentials.metadata?.extraStorage || 0);
    const baseCPU = credentials.cpu || credentials.metadata?.cpu || "2 Cores";
    const baseStorage = credentials.storage || credentials.metadata?.storage || "60GB SSD";
    const displayCpu = extraCPU > 0 ? `${baseCPU} (+${extraCPU} vCPU)` : baseCPU;
    const displayStorage = extraStorage > 0 ? `${baseStorage} (+${extraStorage}GB)` : baseStorage;

    // 5. Build the HTML
    dataTableHtml = `
        <tr>
            <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Confirmation ID</span><br>
                <strong style="font-size: 13px; font-family: 'Courier New', monospace; color: #0F54C6;">
                    ${credentials.confirmationNumber || 'N/A'}
                </strong>
            </td>
            <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Operating System</span><br>
                <strong style="font-size: 13px; color: #101828;">${osValue}</strong>
            </td>
        </tr>

        <tr>
            <td colspan="2" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; margin-bottom: 20px;">
                <div style="margin-bottom: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">
                    <span style="font-size: 10px; color: #0F54C6; text-transform: uppercase; font-weight: bold;">Login Credentials</span>
                </div>
                <table width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                        <td width="50%" style="padding-bottom: 8px;">
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase;">IP Address:</span><br>
                            <strong style="font-size: 12px; font-family: monospace;">${credentials.ipAddress || 'Check Dashboard'}</strong>
                        </td>
                        <td width="50%" style="padding-bottom: 8px;">
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase;">Port:</span><br>
                            <strong style="font-size: 12px; font-family: monospace;">${credentials.port || '3389'}</strong>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase;">Username:</span><br>
                            <strong style="font-size: 12px; font-family: monospace;">${credentials.rdpUsername || 'Administrator'}</strong>
                        </td>
                        <td>
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase;">Password:</span><br>
                            <strong style="font-size: 12px; font-family: monospace; color: #d946ef;">${credentials.rdpPassword || '********'}</strong>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>

        <tr>
            <td colspan="2" style="padding-top: 15px;">
                <table width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                        <td width="33%" valign="top">
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">RAM</span><br>
                            <strong style="font-size: 12px; color: #101828;">${ramValue}</strong>
                        </td>
                        <td width="33%" valign="top" style="text-align: center;">
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">CPU</span><br>
                            <strong style="font-size: 12px; color: #101828;">${displayCpu}</strong>
                        </td>
                        <td width="33%" valign="top" style="text-align: right;">
                            <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Storage</span><br>
                            <strong style="font-size: 12px; color: #101828;">${displayStorage}</strong>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>

        <tr>
            <td colspan="2" style="border-top: 1px dashed #e2e8f0; padding-top: 10px; margin-top: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Network Speed</span><br>
                        <strong style="font-size: 12px; color: #101828;">${netValue}</strong>
                    </div>
                    
                    ${safeReceiptUrl ? `
                    <div style="text-align: right;">
                        <a href="${receiptHref}" target="_blank"
                           style="display: inline-block; padding: 8px 12px; background-color: #0F54C6; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 10px; font-weight: bold; text-transform: uppercase;">
                           View Receipt
                        </a>
                    </div>
                    ` : ''}
                </div>
            </td>
        </tr>
    `;
}
else if (isVPN) {
    // 1. Data Extraction
    const vpnCreds = credentials.vpnCredentials || {};        
    
    // Normalize the target device (Phone vs PC)
    const targetType = (credentials.targetDevice || credentials.deviceType || "Phone").toLowerCase(); 
    
    // Extract potential credential values
    const mUser = vpnCreds.username || credentials.username || "";
    const mPass = vpnCreds.password || credentials.password || "";    
    const pcUser = credentials.pcUsername || "";
    const pcPass = credentials.pcPassword || "";    
    const aCode = credentials.activationCode || "";    
    const adminInstructions = credentials.instructions || "Follow the setup guide in your dashboard.";

    // 2. Strict Logic Flags
    const isPC = targetType === 'pc';
    const isPhone = targetType === 'phone' || targetType === "";

    // Determine what to display based on the device intent
    const showCode = isPC && !!(aCode && aCode !== "N/A");
    
    // PC section: only show if device is PC and data exists
    const showPC = isPC && !!(pcUser || mUser) && !showCode; 
    
    // Mobile section: only show if device is Phone and data exists
    const showMobile = isPhone && !!(mUser && mUser !== "N/A");

    // Dynamic Labeling
    const label = isPC ? "PC" : "Mobile";
    const displayUser = isPC ? (pcUser || mUser) : mUser;
    const displayPass = isPC ? (pcPass || mPass) : mPass;

    // 3. Build HTML
    dataTableHtml = `
        <tr>
            <td colspan="2" valign="top" style="padding-bottom: 20px;">
                <div style="background: #f9fafb; border: 1px solid #eaecf0; padding: 12px; border-radius: 8px; text-align: center;">
                    <span style="font-size: 10px; color: #667085; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Connection Limit</span><br>
                    <strong style="font-size: 15px; color: #0F54C6;">${credentials.deviceLimit || 1} Device(s) Allowed</strong>
                </div>
            </td>
        </tr>
        
        ${showCode ? `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #f2f4f7;"><strong>Activation Code:</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #f2f4f7; text-align:right;">
                <span style="font-family: monospace; color: #0F54C6; background: #f0f5ff; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 14px;">
                    ${aCode}
                </span>
            </td>
        </tr>` : ''}

        ${(showMobile || showPC) ? `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>${label} Username:</strong></td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align:right; color: #101828;">${displayUser}</td>
        </tr>
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>${label} Password:</strong></td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align:right; color: #101828;">${displayPass}</td>
        </tr>` : ''}

        <tr>
            <td colspan="2" style="padding-top: 20px;">
                <div style="background: #FFF5F5; border-left: 4px solid #E11D48; padding: 15px; border-radius: 4px;">
                    <span style="font-size: 10px; color: #E11D48; text-transform: uppercase; font-weight: bold;">Setup Instructions:</span>
                    <p style="margin: 5px 0 0 0; font-size: 12px; color: #101828; line-height: 1.5; font-weight: 500;">
                        ${adminInstructions}
                    </p>
                </div>
            </td>
        </tr>
    `;
}

 else if (isESIM_Activation) {
        const confNo = credentials.confirmationNumber || credentials.activationCode;
        const meta = credentials.metadata || {};
        
        // Map Subscriber Info from Metadata
        const fName = meta.firstName || credentials.firstName || "";
        const lName = meta.lastName || credentials.lastName || "";
        const subscriberName = `${fName} ${lName}`.trim() || "Customer";
        
        const displayEmail = meta.activationEmail || meta.email || credentials.email || 'N/A';
        const displayAddress = meta.address || credentials.address || 'Digital Delivery';
        const displayZip = meta.zip || credentials.zip || 'N/A';
        const displayType = meta.activationType || credentials.activationType || 'Prepaid';
        
        // Handle Receipt Link
        const receiptUrl = receiptHref;
        let receiptSection = "";

        if (receiptUrl) {
            receiptSection = `
                <tr>
                    <td colspan="2" style="padding-top: 10px; padding-bottom: 20px; text-align: center;">
                        <a href="${receiptUrl}" target="_blank" style="display: inline-block; background-color: #0F54C6; color: #ffffff; padding: 12px 25px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px; shadow: 0 4px 6px rgba(0,0,0,0.1);">
                            📄 Download Official Receipt
                        </a>
                        <p style="font-size: 10px; color: #667085; margin-top: 8px;">Valid for official records and reimbursements</p>
                    </td>
                </tr>
            `;
        }

        dataTableHtml = `
            ${receiptSection}
            <tr>
                <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Carrier</span><br>
                    <strong style="font-size: 13px; color: #0F54C6;">${credentials.nodeName || 'Global eSIM'}</strong>
                </td>
                <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Device Model</span><br>
                    <strong style="font-size: 13px; color: #101828;">${credentials.targetNumber || 'N/A'}</strong>
                </td>
            </tr>
            <tr>
                <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Subscription Plan</span><br>
                    <strong style="font-size: 13px; color: #101828;">${credentials.planName || 'Standard Activation'}</strong>
                </td>
                <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Amount Paid</span><br>
                    <strong style="font-size: 13px; color: #101828;">₦${Number(credentials.amount || 0).toLocaleString()}</strong>
                </td>
            </tr>
            <tr>
                <td colspan="2" style="border-top: 1px solid #f2f4f7; padding-top: 15px; padding-bottom: 15px;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Subscriber Details</span><br>
                    <div style="font-size: 12px; color: #344054; line-height: 1.6; background: #f9fafb; padding: 12px; border-radius: 8px; margin-top: 5px; border: 1px solid #eaecf0;">
                        <strong style="color: #667085;">Name:</strong> ${subscriberName}<br>
                        <strong style="color: #667085;">Email:</strong> ${displayEmail}<br>
                        <strong style="color: #667085;">Address:</strong> ${displayAddress}<br>
                        <strong style="color: #667085;">ZIP:</strong> ${displayZip} | <strong style="color: #667085;">Type:</strong> ${displayType}
                    </div>
                </td>
            </tr>
            <tr>
                <td colspan="2" style="border-top: 1px solid #D1E0FF; padding-top: 15px; text-align: center;">
                    <div style="background: #ECFDF3; border: 1px solid #ABEFC6; padding: 15px; border-radius: 8px;">
                        <span style="font-size: 9px; color: #067647; text-transform: uppercase; font-weight: bold;">Confirmation Number</span><br>
                        <strong style="font-size: 20px; font-family: 'Courier New', monospace; color: #101828; letter-spacing: 1px;">${confNo || 'SUCCESSFUL'}</strong>
                    </div>
                </td>
            </tr>`;
    }
   else if (isESIM_Refill) {
    const confNo = credentials.confirmationNumber || credentials.confNo;
    const rawAmount = String(credentials.amount || 0).replace(/[^0-9.-]+/g, "");
    const displayAmount = Number(rawAmount) || 0;
    const displayCountry = credentials.country || (credentials.target && credentials.target.country) || 'N/A';
    const displayTarget = credentials.targetNumber || (credentials.target && credentials.target.number) || 'N/A';

    // Conditional Receipt Button
    let receiptBtn = '';
    if (safeReceiptUrl) {
        receiptBtn = `
            <div style="margin-top: 15px;">
                <a href="${receiptHref}"
                   style="display: inline-block; padding: 12px 24px; background-color: #0F54C6; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
                   View Transaction Receipt
                </a>
            </div>`;
    }

    dataTableHtml = `
        <tr>
            <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Carrier</span><br>
                <strong style="font-size: 13px; color: #0F54C6;">${credentials.nodeName || 'eSIM Carrier'}</strong>
            </td>
            <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Target Number</span><br>
                <strong style="font-size: 13px; font-family: 'Courier New', monospace; color: #101828;">${displayTarget}</strong>
            </td>
        </tr>
        <tr>
            <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Country</span><br>
                <strong style="font-size: 13px; color: #101828;">${displayCountry}</strong>
            </td>
            <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Price Paid</span><br>
                <strong style="font-size: 13px; color: #101828;">₦${displayAmount.toLocaleString()}</strong>
            </td>
        </tr>
        <tr>
            <td colspan="2" style="border-top: 1px solid #D1E0FF; padding-top: 15px; text-align: center;">
                <div style="background: #ECFDF3; border: 1px solid #ABEFC6; padding: 15px; border-radius: 8px;">
                    <span style="font-size: 9px; color: #067647; text-transform: uppercase; font-weight: bold;">Confirmation Number</span><br>
                    <strong style="font-size: 20px; font-family: 'Courier New', monospace; color: #101828; letter-spacing: 1px;">${confNo || 'SUCCESSFUL'}</strong>
                </div>
                ${receiptBtn}
            </td>
        </tr>`;
}
else if (isAccount) {
    // Keys come from the supplier, so every value is escaped before it reaches the HTML
    const keyRows = (credentials.accountKeys || []).map((key, i) => `
        <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; margin-top: 6px; text-align: left;">
            <span style="font-size: 9px; color: #667085; font-weight: bold;">#${i + 1}</span>
            <code style="display: block; font-size: 12px; font-family: 'Courier New', monospace; color: #101828; word-break: break-all;">${escapeHtml(key)}</code>
        </div>`).join('');

    dataTableHtml = `
        <tr>
            <td class="mobile-full" width="50%" valign="top" style="padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Product</span><br>
                <strong style="font-size: 13px; color: #0F54C6;">${escapeHtml(credentials.nodeName || 'Account')}</strong>
            </td>
            <td class="mobile-full" width="50%" valign="top" style="text-align: right; padding-bottom: 15px;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Amount Paid</span><br>
                <strong style="font-size: 13px; color: #101828;">₦${Number(credentials.amount || 0).toLocaleString()}</strong>
            </td>
        </tr>
        <tr>
            <td colspan="2" style="border-top: 1px solid #D1E0FF; padding-top: 20px;">
                <div style="background: #f8faff; border: 1px dashed #0F54C6; padding: 15px; border-radius: 12px;">
                    <span style="font-size: 10px; color: #0F54C6; text-transform: uppercase; font-weight: 800; letter-spacing: 1px;">${escapeHtml(credentials.planName || '')}</span>
                    ${keyRows || '<p style="font-size: 12px;">Check your order history for details.</p>'}
                    <p style="font-size: 10px; color: #667085; margin-top: 10px;">${escapeHtml(credentials.instructions || '')}</p>
                </div>
            </td>
        </tr>
        <tr>
            <td colspan="2" style="padding-top: 15px; text-align: center;">
                <span style="font-size: 9px; color: #667085; text-transform: uppercase;">Transaction ID:</span><br>
                <code style="font-size: 10px; color: #98A2B3;">${escapeHtml(credentials.paymentReference || 'N/A')}</code>
            </td>
        </tr>
    `;
}
else {
        // Generic fallback
        dataTableHtml = `
            <tr>
                <td class="mobile-full" width="50%" valign="top">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Product</span><br>
                    <strong style="font-size: 14px; color: #0F54C6;">${credentials.nodeName || 'Service'}</strong>
                </td>
                <td class="mobile-full" width="50%" valign="top" style="text-align: right;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Price Paid</span><br>
                    <strong style="font-size: 14px; color: #101828;">₦${Number(credentials.amount || 0).toLocaleString()}</strong>
                </td>
            </tr>
            <tr>
                <td colspan="2" style="padding-top: 10px;">
                    <span style="font-size: 9px; color: #667085; text-transform: uppercase; font-weight: bold;">Confirmation Number</span><br>
                    <strong style="font-size: 14px; font-family: 'Courier New', monospace; color: #101828;">
                        ${credentials.confirmationNumber || credentials.activationCode || 'N/A'}
                    </strong>
                </td>
            </tr>`;
    }
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @media screen and (max-width: 480px) {
                .mobile-full { width: 100% !important; display: block !important; text-align: left !important; padding-bottom: 15px !important; }
            }
        </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f7ff;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
                <td align="center" style="padding: 20px 0;">
                    <div style="font-family: 'Inter', Helvetica, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
                        <div style="background-color: #ffffff; padding: 20px; text-align: center; border-bottom: 1px solid #f0f0f0;">
                            <img src="${APP_BASE_URL}/assets/logo.png" alt="DeemaxHub" style="height: 24px; width: auto; display: block; margin: 0 auto;">
                        </div>
                        <div style="background-color: #0F54C6; color: white; padding: 35px 24px; text-align: center;">
                            <h2 style="margin: 0; font-size: 22px;">${headerTitle}</h2>
                            <p style="opacity: 0.8; font-size: 13px; margin-top: 8px;">${subHeader}</p>
                        </div>
                        <div style="padding: 24px; color: #344054; text-align: left;">
                            <p style="font-size: 14px; line-height: 1.5; margin-bottom: 24px;">
                                Hello, thank you for choosing <strong>DeemaxHub</strong>. Your service details are provided below.
                            </p>
                            <div style="background: #F0F5FE; padding: 20px; border-radius: 12px; border: 1px solid #D1E0FF; margin-bottom: 24px;">
                                <p style="margin: 0 0 10px 0; font-size: 10px; color: #0F54C6; font-weight: 800; text-transform: uppercase;">Service Order Info</p>
                                <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                    ${dataTableHtml}
                                </table>
                            </div>
                            <div style="text-align: center; margin-top: 30px;">
                                <a href="https://www.deemaxhub.com" style="background-color: #0F54C6; color: #ffffff; padding: 12px 24px; text-decoration: none; font-size: 13px; font-weight: bold; border-radius: 8px; display: inline-block;">Access Dashboard</a>
                            </div>
                        </div>
                        <div style="background: #F9FAFB; padding: 20px; text-align: center; border-top: 1px solid #EAECF0;">
                            <p style="font-size: 11px; color: #667085; margin: 0;">&copy; 2026 <strong>DeemaxHub</strong>. All rights reserved.</p>
                        </div>
                    </div>
                </td>
            </tr>
        </table>
    </body>
    </html>`;

const emailAttachments = [];
    if (safeReceiptUrl) {
        const extension = safeReceiptUrl.split('?')[0].split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'pdf'; // Handle query params
        emailAttachments.push({
            filename: `DeemaxHub_Receipt_${String(rawCredentials.confirmationNumber || 'Order').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'Order'}.${extension}`,
            path: safeReceiptUrl
        });
    }

    try {
        await transporter.sendMail({
            from: mailFrom('DeemaxHub Support'),
            to: userEmail,
            subject: `${subject} - DeemaxHub`,
            html: htmlContent,
            attachments: emailAttachments // Physical file attachment
        });
        console.log(`Delivery email sent to: ${userEmail}`);
    } catch (error) {
        console.error("Nodemailer Error:", error);
    }
};

const sendResetPasswordEmail = async (userEmail, resetLink, isAdmin = false) => {
    const transporter = createMailTransporter();

    // Dynamic content based on account type
    const accountType = isAdmin ? "Admin Control Panel" : "User Account";
    const subject = isAdmin ? "🔐 Urgent: Admin Password Reset" : "🔐 Reset Your DeemaxHub Password";
    const headerTitle = isAdmin ? "Admin Security Update" : "Password Reset Request";
    const subHeader = `Security credentials for your ${accountType} are being updated.`;

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @media screen and (max-width: 480px) {
                .mobile-full { width: 100% !important; display: block !important; text-align: left !important; padding-bottom: 15px !important; }
            }
        </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f7ff;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
                <td align="center" style="padding: 20px 0;">
                    <div style="font-family: 'Inter', Helvetica, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
                        
                        <div style="background-color: #ffffff; padding: 20px; text-align: center; border-bottom: 1px solid #f0f0f0;">
                            <img src="${APP_BASE_URL}/assets/logo.png" alt="DeemaxHub" style="height: 24px; width: auto; display: block; margin: 0 auto;">
                        </div>

                        <div style="background-color: ${isAdmin ? '#101828' : '#0F54C6'}; color: white; padding: 35px 24px; text-align: center;">
                            <h2 style="margin: 0; font-size: 22px;">${headerTitle}</h2>
                            <p style="opacity: 0.8; font-size: 13px; margin-top: 8px;">${subHeader}</p>
                        </div>

                        <div style="padding: 24px; color: #344054; text-align: left;">
                            <p style="font-size: 14px; line-height: 1.5; margin-bottom: 24px;">
                                Hello, a request was made to reset the password for the <strong>${accountType}</strong> associated with this email. Click the button below to proceed. <strong>This link is valid for 1 hour.</strong>
                            </p>
                            
                            <div style="background: #F0F5FE; padding: 20px; border-radius: 12px; border: 1px solid #D1E0FF; margin-bottom: 24px; text-align: center;">
                                <p style="margin: 0 0 10px 0; font-size: 10px; color: #0F54C6; font-weight: 800; text-transform: uppercase;">Security Action Required</p>
                                
                                <div style="margin: 20px 0;">
                                    <a href="${resetLink}" style="background-color: #0F54C6; color: #ffffff; padding: 14px 30px; text-decoration: none; font-size: 14px; font-weight: bold; border-radius: 8px; display: inline-block; shadow: 0 4px 6px -1px rgba(15, 84, 198, 0.2);">
                                        Reset ${isAdmin ? 'Admin' : 'My'} Password
                                    </a>
                                </div>
                            </div>

                            <p style="font-size: 12px; color: #667085;">
                                If you did not request this, please contact technical support immediately.
                            </p>
                        </div>

                        <div style="background: #F9FAFB; padding: 20px; text-align: center; border-top: 1px solid #EAECF0;">
                            <p style="font-size: 11px; color: #667085; margin: 0;">&copy; 2026 <strong>DeemaxHub</strong>. Secure Digital Services.</p>
                        </div>
                    </div>
                </td>
            </tr>
        </table>
    </body>
    </html>`;

    await transporter.sendMail({
        from: mailFrom('DeemaxHub Security'),
        to: userEmail,
        subject: subject,
        html: htmlContent
    });
};

// 2. GET ALL Proxies (Sorted by Newest)
async function handleGetProxies(req, res) {
    try {
        // ⚠️ CRITICAL: Unsold codes (activationCodes and the activationCode preview) are admin-only
        const isAdmin = Boolean(await getOptionalAdmin(req));
        const proxies = await Proxy.find({})
            .sort({ createdAt: -1 })
            .select(isAdmin ? '' : '-activationCodes -activationCode')
            .lean();
        return res.json({ success: true, proxies });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Fetch failed" });
    }
}

// 3. ADD Proxy (Vending Machine Logic)
async function handleAddProxy(req, res) {
    try {
        const { name, category, imageUrl, activationCode, activationCodes, instructions, plans, stock } = req.body;

        // Clean and parse the plans
        let formattedPlans = [];
        if (plans && Array.isArray(plans)) {
            formattedPlans = plans.map(p => ({
                ip_count: parseInt(p.ip_count) || 0,
                price: Math.round(parseFloat(p.price)) || 0 
            }));
        }

        // Logic: Use the array length for stock if codes were uploaded
        const finalCodes = Array.isArray(activationCodes) ? activationCodes : [];
        const finalStock = finalCodes.length > 0 ? finalCodes.length : (parseInt(stock) || 0);

        const newProxy = new Proxy({
            name,
            category: category || 'Standard', 
            imageUrl,
            // Single code for backward compatibility
            activationCode: activationCode || (finalCodes.length > 0 ? finalCodes[0] : ""),
            // The full array for the vending machine
            activationCodes: finalCodes,
            instructions,
            stock: finalStock,
            plans: formattedPlans
        });

        await newProxy.save();
        return res.json({ success: true, message: "Proxy Package Deployed with " + finalStock + " codes" });
    } catch (err) {
        console.error("Add Proxy Error:", err);
        return res.status(500).json({ success: false, message: "Deployment failed" });
    }
}

// 4. UPDATE Proxy (With Bulk Code Support)
async function handleUpdateProxy(req, res) {
    try {
        const { proxyId, plans, stock, activationCodes, expectedUpdatedAt, _id, createdAt, updatedAt, ...restOfData } = req.body;

        if (!proxyId || !mongoose.isValidObjectId(proxyId)) {
            return res.status(400).json({ success: false, message: "Proxy ID is required" });
        }

        // Reject Stale Forms: saving an old code list would put sold codes back on sale
        if (Array.isArray(activationCodes) && expectedUpdatedAt) {
            const current = await Proxy.findById(proxyId).select('updatedAt').lean();
            if (current && new Date(current.updatedAt).getTime() !== new Date(expectedUpdatedAt).getTime()) {
                return res.status(409).json({ success: false, message: "Stock changed since you opened this form (a sale or another edit). Reload the page and try again." });
            }
        }

        // Prepare the update object
        const updatePayload = { ...restOfData };

        // Handle plans parsing
        if (plans && Array.isArray(plans)) {
            updatePayload.plans = plans.map(p => ({
                ip_count: parseInt(p.ip_count) || 0,
                price: Math.round(parseFloat(p.price)) || 0 
            }));
        }

if (Array.isArray(activationCodes)) {
    updatePayload.activationCodes = activationCodes;
    updatePayload.stock = activationCodes.length;
    
    updatePayload.activationCode = activationCodes.length > 0 ? activationCodes[0] : "";
} else {
    updatePayload.stock = parseInt(stock) || 0;
}
        const updated = await Proxy.findByIdAndUpdate(
            proxyId, 
            { $set: updatePayload }, 
            { new: true }
        );
        
        if (!updated) return res.status(404).json({ success: false, message: "Proxy not found" });

        return res.json({ success: true, message: "Proxy Package Updated successfully" });
    } catch (err) {
        console.error("Update Proxy Error:", err);
        return res.status(500).json({ success: false, message: "Update failed" });
    }
}

// 5. DELETE Proxy
async function handleDeleteProxy(req, res) {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).json({ success: false, message: "ID is required" });
        
        await Proxy.findByIdAndDelete(id);
        return res.json({ success: true, message: "Proxy Package Deleted" });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Delete failed" });
    }
}

/**
 * Wallet Reconciliation (admin only)
 * Every balance change writes a Transaction, so for each user:
 * successful credits - successful debits should equal balance + bonusBalance.
 * Users whose wallet doesn't match are listed, biggest gap first.
 */
async function handleWalletCheck(req, res) {
    try {
        // 1. Net Movement Per User From The Transaction Log
        const ledger = await Transaction.aggregate([
            { $match: { status: 'successful' } },
            { $group: {
                _id: '$userId',
                net: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$amountNGN', { $multiply: ['$amountNGN', -1] }] } },
                count: { $sum: 1 }
            } }
        ]);
        const ledgerByUser = new Map(ledger.map(row => [String(row._id), row]));

        // 2. Compare With What The Wallets Actually Hold
        const users = await User.find({}, 'email fullName balance bonusBalance').lean();
        const mismatches = [];
        let walletTotal = 0;

        for (const u of users) {
            const wallet = Math.round((u.balance || 0) + (u.bonusBalance || 0));
            const row = ledgerByUser.get(String(u._id));
            const expected = Math.round(row?.net || 0);
            walletTotal += wallet;

            if (wallet !== expected) {
                mismatches.push({
                    userId: u._id,
                    email: u.email,
                    fullName: u.fullName,
                    wallet,
                    expected,
                    difference: wallet - expected, // Positive: wallet holds more than its history explains
                    transactions: row?.count || 0
                });
            }
        }

        mismatches.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

        return res.json({
            success: true,
            message: mismatches.length ? `${mismatches.length} wallet(s) don't match their history.` : "Every wallet matches its transaction history.",
            usersChecked: users.length,
            walletTotal,
            mismatchCount: mismatches.length,
            mismatches: mismatches.slice(0, 100)
        });
    } catch (err) {
        console.error("Wallet Check Error:", err);
        return res.status(500).json({ success: false, message: "Wallet check failed." });
    }
}

async function handleAllTransactions(req, res) {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const orders = await Order.find()
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select('createdAt fullName userEmail productType nodeName planName amount currency')
            .lean();

        // 2. Map the transactions for the frontend
        const formattedTransactions = orders.map(order => ({
            id: order._id.toString(),
            date: order.createdAt,
            customerName: order.fullName || order.userEmail, 
            email: order.userEmail, 
            product: order.productType,
            details: `${order.nodeName} - ${order.planName}`,
            amount: order.amount,
            currency: order.currency
        }));

        res.json({ 
            success: true, 
            transactions: formattedTransactions 
        });
    } catch (err) {
        console.error("Error fetching transactions:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
}

async function getEsimRefills(req, res) {
    try {
        const refills = await Order.find({ productType: 'eSIM_Refill' })
            .sort({ createdAt: -1 })
            .limit(100);

        const formattedRefills = refills.map(refill => ({
            paymentReference: refill.paymentReference,
            createdAt: refill.createdAt,
            userEmail: refill.userEmail,
            fullName: refill.fullName || "Customer",
            amountNGN: `₦${Number(refill.amount).toLocaleString()}`, 
            status: refill.status || '',   
            receiptUrl: refill.receiptUrl || null,         
            targetNumber: refill.targetNumber || (refill.target?.number) || 'N/A',
            country: refill.country || (refill.target?.country) || 'N/A',
            carrier: refill.nodeName || (refill.carrier?.name) || 'Global eSIM',
            confirmationNumber: refill.confirmationNumber || 'PENDING'
        }));

        return res.json({ 
            success: true, 
            refills: formattedRefills 
        });

    } catch (error) {
        console.error("Admin Fetch Error:", error);
        return res.status(500).json({ 
            success: false, 
            message: "Failed to fetch eSIM refill records" 
        });
    }
}

async function handleAdminEsimUpdate(req, res) {
    // 1. Double-check body exists (Vercel/Express parses JSON automatically)
    if (!req.body || Object.keys(req.body).length === 0) {
        console.error("Empty request body - expected JSON");
        return res.status(400).json({ 
            success: false, 
            message: "Data parsing failed. Ensure Content-Type is application/json." 
        });
    }

    // 2. Consistent variable extraction from req.body
    // Note: receiptUrl comes from the signed upload-receipt endpoint, not req.file
    const tid = req.body.tid || req.body.paymentReference;
    const confirmationNumber = cleanText(req.body.confirmationNumber, 100);
    const adminNote = cleanText(req.body.adminNote, 500) || '';
    const receiptUrl = /^https:\/\//.test(String(req.body.receiptUrl || '')) ? req.body.receiptUrl : null;

    if (!tid || typeof tid !== 'string') {
        return res.status(400).json({ success: false, message: "Transaction ID (tid) is required." });
    }

    try {
        // Failed refills go back to the customer's wallet
        if (req.body.status === 'failed') {
            const target = await Order.findOne({ paymentReference: tid, productType: 'eSIM_Refill' }).select('_id').lean();
            if (!target) return res.status(404).json({ success: false, message: "Order not found in Database." });

            const refund = await refundOrderToWallet(
                target._id,
                adminNote || `Refill failed (admin ${req.admin.email})`,
                'failed',
                { productType: 'eSIM_Refill', status: { $nin: ['failed', 'cancelled'] } }
            );
            if (!refund.success) return res.status(400).json({ success: false, message: "Order not found or already refunded." });
            return res.json({ success: true, message: `Order marked failed and ₦${refund.refundAmount.toLocaleString()} refunded.`, data: refund.order });
        }

        const updateData = {
            status: 'completed',
            confirmationNumber: confirmationNumber,
            adminNote: adminNote,
            updatedAt: new Date()
        };

        // If the frontend successfully uploaded to Cloudinary, we save the link
        if (receiptUrl) {
            updateData.receiptUrl = receiptUrl; 
        }

        // Search by paymentReference (a refunded order can't be completed)
        const updatedOrder = await Order.findOneAndUpdate(
            { paymentReference: tid, productType: 'eSIM_Refill', refundedAt: { $exists: false } },
            { $set: updateData },
            { returnDocument: 'after' }
        );

        if (!updatedOrder) {
            return res.status(404).json({ success: false, message: "Order not found in Database." });
        }

        // 3. Decoupled Email Block
        try {
            if (typeof sendDeliveryEmail === 'function') {
                await sendDeliveryEmail(updatedOrder.userEmail, {
                    productType: updatedOrder.productType,
                    nodeName: updatedOrder.nodeName || updatedOrder.carrier?.name || "eSIM Carrier",
                    targetNumber: updatedOrder.targetNumber || 'N/A',
                    country: updatedOrder.country || 'N/A',
                    amount: updatedOrder.amount, 
                    confirmationNumber: confirmationNumber,
                    receiptUrl: receiptUrl,
                    instructions: "Your eSIM refill is now active."
                });
            }
        } catch (emailErr) {
            console.error("Email notification failed:", emailErr.message);
            // Non-blocking: order is already saved
        }

        return res.json({ 
            success: true, 
            message: "Order marked as completed.",
            data: updatedOrder 
        });

    } catch (error) {
        console.error("CRITICAL ADMIN ERROR:", error.message);
        return res.status(500).json({ 
            success: false, 
            message: "Database update failed", 
        });
    }
}

async function handleAdminEsimActivationUpdate(req, res) {
    // 1. Added receiptUrl to the request body
    const { tid, status, confirmationNumber, receiptUrl } = req.body;
    const ACTIVATION_STATUSES = ['pending', 'processing', 'completed', 'successful', 'failed'];

    if (!tid || typeof tid !== 'string' || !ACTIVATION_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: "Missing Transaction ID or Status" });
    }

    try {
        // Failed activations go back to the customer's wallet
        if (status === 'failed') {
            const target = await Order.findOne({ paymentReference: tid, productType: 'eSIM_Activation' }).select('_id').lean();
            if (!target) return res.status(404).json({ success: false, message: "Activation record not found in Orders" });

            const refund = await refundOrderToWallet(
                target._id,
                `Activation failed (admin ${req.admin.email})`,
                'failed',
                { productType: 'eSIM_Activation', status: { $nin: ['failed', 'cancelled'] } }
            );
            if (!refund.success) return res.status(400).json({ success: false, message: "Order already failed or refunded." });

            await EsimActivation.findOneAndUpdate({ paymentReference: tid }, { $set: { status: 'failed' } });
            return res.json({ success: true, message: `Activation marked failed and ₦${refund.refundAmount.toLocaleString()} refunded.`, data: refund.order });
        }

        const updatedOrder = await Order.findOneAndUpdate(
            { paymentReference: tid, productType: 'eSIM_Activation', refundedAt: { $exists: false } },
            { 
                $set: { 
                    status: status, 
                    confirmationNumber: cleanText(confirmationNumber, 100),
                    // 2. Save receipt URL to Order metadata or top level
                    "metadata.receiptUrl": /^https:\/\//.test(String(receiptUrl || '')) ? receiptUrl : null,
                    updatedAt: new Date() 
                } 
            },
           { returnDocument: 'after' }
        );

        if (!updatedOrder) {
            return res.status(404).json({ success: false, message: "Activation record not found in Orders" });
        }

        await EsimActivation.findOneAndUpdate(
            { paymentReference: tid },
            { 
                $set: { 
                    status: status, 
                    esimProfileId: confirmationNumber || null,
                    receiptUrl: receiptUrl || null, // 3. Sync to specialized activation record
                    updatedAt: new Date() 
                } 
            }
        );

        const isFinished = status.toLowerCase() === 'completed' || status.toLowerCase() === 'successful';        
        
        if (isFinished) {
            try {
                await sendDeliveryEmail(updatedOrder.userEmail, {
                    productType: "eSIM_Activation", 
                    nodeName: updatedOrder.nodeName || "Global eSIM",
                    planName: updatedOrder.planName || "Standard Plan",
                    amount: updatedOrder.amount,        
                    targetNumber: updatedOrder.targetNumber || "eSIM Device",
                    confirmationNumber: confirmationNumber || updatedOrder.confirmationNumber,
                    receiptUrl: receiptUrl || null, // 4. Pass receipt to email template
                    metadata: {
                        ...updatedOrder.metadata,
                        activationEmail: updatedOrder.metadata?.activationEmail || updatedOrder.userEmail 
                    },
                    firstName: updatedOrder.metadata?.firstName,
                    lastName: updatedOrder.metadata?.lastName,
                    instructions: "Your eSIM activation is complete. You can download your receipt from your dashboard."
                });
            } catch (emailError) {
                console.error("📧 Email Delivery Failed:", emailError);
            }
        }

        return res.json({ 
            success: true, 
            message: `Activation order updated to ${status}`,
            data: updatedOrder 
        });

    } catch (error) {
        console.error("❌ Admin Activation Update Error:", error);
        return res.status(500).json({ success: false, message: "Internal Server error" });
    }
}

async function handleGetEsimActivations(req, res) { 
    try {
        const activations = await Order.find({ productType: 'eSIM_Activation' })
            .sort({ createdAt: -1 })
            .limit(100);

        const formattedActivations = activations.map(order => {
            const details = order.metadata || {};

            return {
                paymentReference: order.paymentReference,
                productType: 'eSIM_Activation', 
                createdAt: order.createdAt,
                userEmail: order.userEmail, 
                email: details.email || order.userEmail,
                fullName: `${details.firstName || ''} ${details.lastName || ''}`.trim() || 'N/A',
                amount: order.amount,
                status: order.status,
                carrierName: order.nodeName || "Global eSIM", // Map nodeName to carrier
                deviceName: order.targetNumber || "eSIM Device", // Map targetNumber to device
                activationType: details.activationType || 'Standard', // Pull from metadata
                planName: order.planName,
                confirmationNumber: order.confirmationNumber || 'PENDING',
                address: details.address || 'N/A',
                zipCode: details.zip || 'N/A'
            };
        });

        return res.json({ success: true, orders: formattedActivations });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to fetch records" });
    }
}
// GET: Fetch all RDP plans (for Admin list or User selection)
async function handleGetRDPs(req, res) {
    try {
        const rdps = await RDP.find({}).sort({ createdAt: -1 });
        res.json({ success: true, rdps });
    } catch (error) {
        console.error("Fetch RDP Error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch RDP plans" });
    }
}

// POST: Add a new RDP plan
async function handleAddRDP(req, res) {
    const { name, category, ram, cpu, storage, network, os, price, isInstant, instructions } = req.body;
    
    if (!name || !ram || !cpu || !storage || !price) {
        return res.status(400).json({ success: false, message: "Missing required RDP fields" });
    }

    try {
        const newRDP = new RDP({
            name, category, ram, cpu, storage, network, os, 
            price, isInstant, instructions,
            adminUpdatedBy: req.admin?.email
        });
        await newRDP.save();
        res.json({ success: true, message: "RDP Plan added successfully", rdp: newRDP });
    } catch (error) {
        console.error("Add RDP Error:", error);
        res.status(500).json({ success: false, message: "Server error while adding RDP" });
    }
}

// --- SIGNED RECEIPT UPLOAD (admin only) ---
// Replaces the browser's unsigned Cloudinary preset: the file comes here first and is
// uploaded with the server's API secret, so only signed-in admins can store files.
async function handleUploadReceipt(req, res) {
    if (!process.env.CLOUDINARY_NAME || !process.env.CLOUDINARY_KEY || !process.env.CLOUDINARY_SECRET) {
        return res.status(503).json({ success: false, message: "Receipt uploads are not configured on the server." });
    }

    // 1. Parse The Multipart Body (single field named "file")
    try {
        await new Promise((resolve, reject) => upload.single('file')(req, res, err => err ? reject(err) : resolve()));
    } catch (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? "Receipt must be smaller than 4 MB." : "Could not read the uploaded file.";
        return res.status(400).json({ success: false, message });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, message: "Attach a JPG, PNG or PDF receipt." });
    }

    // 2. Stream It To Cloudinary With The Signed API
    try {
        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'smsglobe_receipts', resource_type: 'auto' },
                (err, uploaded) => err ? reject(err) : resolve(uploaded)
            );
            stream.end(req.file.buffer);
        });

        return res.json({ success: true, message: "Receipt uploaded", secure_url: result.secure_url, url: result.secure_url });
    } catch (err) {
        console.error("Receipt Upload Error:", err.message);
        return res.status(502).json({ success: false, message: "Receipt upload failed. Please try again." });
    }
}

// Updated: Complete RDP Order (Aligned with eSIM Refill Pattern)
async function handleCompleteRDPOrder(req, res) {
    // 1. Extract data from req.body (receiptUrl now comes as a string from frontend)
    const { 
        tid, 
        status, 
        confirmationNumber, 
        ipAddress, 
        port, 
        rdpUsername, 
        rdpPassword,
        receiptUrl 
    } = req.body;

    // Basic validation
    if (!tid || typeof tid !== 'string') {
        return res.status(400).json({ success: false, message: "Transaction ID (tid) is required." });
    }

    try {
        // Failed RDP orders go back to the customer's wallet
        if (status === 'failed') {
            const target = await Order.findOne({ paymentReference: tid, productType: 'RDP' }).select('_id').lean();
            if (!target) return res.status(404).json({ success: false, message: "Order not found" });

            const refund = await refundOrderToWallet(
                target._id,
                `RDP provisioning failed (admin ${req.admin.email})`,
                'failed',
                { productType: 'RDP', status: { $nin: ['failed', 'cancelled'] } }
            );
            if (!refund.success) return res.status(400).json({ success: false, message: "Order already failed or refunded." });
            return res.json({ success: true, message: `Order marked failed and ₦${refund.refundAmount.toLocaleString()} refunded.`, order: refund.order });
        }

        // 2. Update the order in MongoDB (a refunded order can't be provisioned)
        const order = await Order.findOneAndUpdate(
            { paymentReference: tid, productType: 'RDP', refundedAt: { $exists: false } },
            { 
                $set: {
                    status: ['pending', 'processing', 'completed', 'successful'].includes(status) ? status : 'completed',
                    confirmationNumber: cleanText(confirmationNumber, 100),
                    ipAddress: cleanText(ipAddress, 100),
                    port: cleanText(port, 10) || '3389',
                    rdpUsername: cleanText(rdpUsername, 100),
                    rdpPassword: cleanText(rdpPassword, 200),
                    receiptUrl: /^https:\/\//.test(String(receiptUrl || '')) ? receiptUrl : '', // From upload-receipt
                    deliveredAt: new Date(),
                    updatedAt: new Date()
                }
            },
            { returnDocument: 'after' }
        );

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // 3. Trigger Delivery Email (Non-blocking)
        try {
            if (typeof sendDeliveryEmail === 'function') {
                await sendDeliveryEmail(order.userEmail, { 
                    productType: 'RDP', 
                    fullName: order.fullName || 'Customer',
                    confirmationNumber: confirmationNumber,         
                    os: order.os || 'Windows Server',
                    ram: order.ram || 'N/A',
                    cpu: order.cpu || 'N/A',
                    storage: order.storage || 'N/A',        
                    net: order.net || '1Gbps',
                    ipAddress: ipAddress || order.ipAddress,
                    port: port || order.port || '3389',
                    rdpUsername: rdpUsername || order.rdpUsername,
                    rdpPassword: rdpPassword || order.rdpPassword,
                    receiptUrl: receiptUrl || order.receiptUrl, 
                    planName: order.planName || "RDP Service",
                    amount: order.amount
                });
            }
        } catch (mailError) {
            console.error("Email failed but database updated:", mailError.message);
        }

        return res.status(200).json({ 
            success: true, 
            message: "RDP Provisioned successfully", 
            order 
        });

    } catch (error) {
        console.error("RDP Fulfillment Error:", error.message);
        return res.status(500).json({ 
            success: false, 
            message: "Internal Server Error",
        });
    }
}

// DELETE: Remove an RDP plan
async function handleDeleteRDP(req, res) {
    const { id } = req.body;
    try {
        await RDP.findByIdAndDelete(id);
        res.json({ success: true, message: "RDP Plan deleted" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Delete failed" });
    }
}

async function handleGetRdpRequests(req, res) {
    try {
        const requests = await Order.find({ productType: 'RDP' })
            .sort({ createdAt: -1 })
            .limit(100);

        const formattedRequests = requests.map(order => {
            const meta = order.metadata || {};
            
            return {
                paymentReference: order.paymentReference,
                productType: 'RDP',
                createdAt: order.createdAt,
                userEmail: order.userEmail,
                fullName: order.fullName || meta.fullName || 'User',
                nodeName: order.nodeName || 'USA Tier 1',
                planName: order.planName || 'RDP Server',
                
                // Hardware Specs - Pulling from root or metadata
                cpu: order.cpu || meta.cpu || 'N/A', 
                ram: order.ram || meta.ram || 'N/A',
                storage: order.storage || meta.storage || 'N/A',
                net: order.net || meta.net || 'N/A',
                os: order.os || meta.osChoice || 'Windows',

                receiptUrl: order.receiptUrl || '',
                ipAddress: order.ipAddress || '',
                port: order.port || '',
                rdpUsername: order.rdpUsername || '',
                rdpPassword: order.rdpPassword || '',
                
                metadata: {
                    extraCPU: meta.extraCPU || order.extraCPU || 0,
                    extraStorage: meta.extraStorage || order.extraStorage || 0
                },
                amount: order.amount, 
                status: order.status || 'pending',
                confirmationNumber: order.confirmationNumber || ''
            };
        });

        return res.json({ success: true, orders: formattedRequests });
    } catch (error) {
        console.error("❌ RDP Fetch Error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch" });
    }
}

async function handleGetServicesAndPrices(req, res) {
    try {
        // 0. Demo Mode: Fake Catalog So The Page Works With No SMSBower Key
        if (isSmsDemoMode()) {
            return res.json({
                success: true,
                services: SMS_DEMO_SERVICES.map(s => ({ code: s.code, name: s.name, image: null, countries: {} }))
            });
        }

        if (!process.env.SMSBOWER_API_KEY) {
            console.error("SMSBOWER_API_KEY is missing in your environment configuration.");
            return res.status(500).json({ success: false, message: "Vendor configuration error." });
        }

        const response = await smsBowerClient.get('', {
            params: { 
                action: 'getServicesList', 
                api_key: process.env.SMSBOWER_API_KEY 
            }
        });

        const rawData = response.data;

        if (typeof rawData === 'string') {
            console.error("SMS returned string error:", rawData);
            return res.status(400).json({ success: false, message: `Vendor error: ${rawData}` });
        }

        const serviceItems = rawData.services || rawData.data || (Array.isArray(rawData) ? rawData : []);

        let servicesList = serviceItems.map(item => {
            // Ensure we use the exact service identifier key ('code' or 'id') required by SMSBower
            const serviceId = (item.code || item.id || item.short || '').toLowerCase();
            const name = item.name || serviceId.toUpperCase();
            
            return {
                code: serviceId,
                name: name,
                image: null, 
                countries: {} 
            };
        });

        return res.json({ 
            success: true, 
            services: servicesList 
        });

    } catch (err) {
        console.error("Failed to fetch SMS services:", err.response?.data || err.message);
        return res.status(500).json({ 
            success: false, 
            message: "Failed to fetch services catalog from vendor.",
        });
    }
}

async function handleProxyServiceImage(req, res) {
    try {
        const serviceId = req.query.id;
        const cleanId = serviceId ? String(serviceId).trim().toLowerCase() : '';
        
        // Generate a clean short label from the service ID
        const rawLabel = cleanId ? cleanId.replace(/[^a-z0-9]/gi, '').toUpperCase() : 'APP';
        const displayLabel = rawLabel.length > 4 ? rawLabel.substring(0, 4) : rawLabel;
        const fontSize = displayLabel.length > 3 ? '7' : '9';

        if (cleanId) {
            const targetUrls = [
                `https://smsbower.app/img/services/${cleanId}.svg`,
                `https://smsbower.app/img/services/${cleanId}.png`
            ];

            for (const targetUrl of targetUrls) {
                try {
                    const imageResponse = await axios.get(targetUrl, {
                        responseType: 'arraybuffer',
                        headers: {
                            'Referer': 'https://smsbower.app/',
                            'User-Agent': 'Mozilla/5.0'
                        },
                        timeout: 2000
                    });

                    if (imageResponse && imageResponse.status === 200) {
                        const contentType = imageResponse.headers['content-type'] || 'image/svg+xml';
                        res.setHeader('Content-Type', contentType);
                        res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800');
                        return res.status(200).send(Buffer.from(imageResponse.data));
                    }
                } catch (e) {
                    // Try next URL option
                }
            }
        }

        // Fallback SVG showing the service's short name inside the badge
        const defaultSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#0284c7"/><text x="12" y="14.5" font-size="${fontSize}" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">${displayLabel}</text></svg>`;
        
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800');
        return res.status(200).send(defaultSvg);

    } catch (err) {
        // Return clean fallback SVG on error to guarantee 200 OK
        const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#0284c7"/><text x="12" y="14.5" font-size="7" fill="#fff" text-anchor="middle" font-family="sans-serif">APP</text></svg>`;
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.status(200).send(fallbackSvg);
    }
}

// --- SMS PRICING RULES ---
// Most specific first: service + country, whole service, whole country, then the general
// smsMarkupPercentage. A fixed price below an operator's cost is skipped for that operator,
// so the next rule down prices it and a number is never sold at a loss.
function getSmsPriceRules(overrides, serviceCode, countryId) {
    const find = (s, c) => overrides.find(o => o.serviceCode === s && o.countryId === c);
    return [
        ['service_country', find(serviceCode, countryId)],
        ['service', find(serviceCode, SMS_ANY)],
        ['country', find(SMS_ANY, countryId)]
    ].filter(([, rule]) => rule).map(([level, rule]) => ({ level, rule }));
}

// Marked-up prices never go under smsFloorPriceNGN; an admin's fixed price is used as set
function resolveSmsTierPrice(baseCostNGN, rules, generalMarkup, floorPriceNGN = 0) {
    const withMarkup = (level, markup) => {
        const marked = Number((baseCostNGN * (1 + markup / 100)).toFixed(2));
        const floored = marked < floorPriceNGN;
        return { amount: floored ? floorPriceNGN : marked, pricing: { level, type: 'markup', value: markup, ...(floored ? { floor: floorPriceNGN } : {}) } };
    };

    for (const { level, rule } of rules) {
        if (rule.pricingType === 'fixed') {
            if (Number(rule.fixedPriceNGN) >= baseCostNGN) {
                return { amount: Number(rule.fixedPriceNGN), pricing: { level, type: 'fixed', value: Number(rule.fixedPriceNGN) } };
            }
            continue; // Below cost: fall through to the next rule
        }
        return withMarkup(level, Number(rule.markupPercentage) || 0);
    }
    return withMarkup('general', generalMarkup);
}

// Turns SMSBower's getCountries reply into [{ countryId, countryName, code }]
function parseSmsCountriesMeta(rawCountriesMeta) {
    const metaSource = rawCountriesMeta?.countries || rawCountriesMeta?.data || rawCountriesMeta;
    if (!metaSource || typeof metaSource !== 'object') return [];

    const entries = Array.isArray(metaSource) ? metaSource.map((c, idx) => [c.id || idx, c]) : Object.entries(metaSource);
    return entries.filter(([, cInfo]) => cInfo && typeof cInfo === 'object').map(([id, cInfo]) => ({
        countryId: String(id),
        countryName: cInfo.name || cInfo.countryName || cInfo.til || cInfo.eng || cInfo.rus || `Country ${id}`,
        code: (cInfo.iso || cInfo.code || cInfo.eng || cInfo.short || id).toString().toLowerCase()
    }));
}

/**
 * Prices every SMSBower operator for one service, per country, from the live catalog.
 * Each country's `tiers` list is sorted cheapest first. Shared by getSmsCountryPrices
 * (what users pay) and the admin operator picker (sms-operators).
 */
async function getSmsPriceCatalog(cleanServiceCode) {
    // 1. Instant lookup from Node memory (0ms DB delay), plus the admin's price overrides
    const [systemSettings, exchangeRateToNgn, priceOverrides] = await Promise.all([
        getSystemSettingsCached(),
        getUsdToNgnRate(),
        SmsPriceOverride.find({ serviceCode: { $in: [cleanServiceCode, SMS_ANY] } }).lean()
    ]);
    const smsMarkup = systemSettings?.smsMarkupPercentage || 0;
    const smsFloor = Math.max(Number(systemSettings?.smsFloorPriceNGN) || 0, 0);

    // 1b. Demo Mode: Same Shape, Fake Operators, No Vendor Call
    const formattedCountries = isSmsDemoMode()
        ? buildSmsDemoCatalog(exchangeRateToNgn)
        : await fetchSmsCostCatalog(cleanServiceCode, exchangeRateToNgn);

    // 2. Price Every Operator With The Rule That Applies To Its Country
    formattedCountries.forEach(country => {
        const rules = getSmsPriceRules(priceOverrides, cleanServiceCode, country.countryId);
        country.tiers.forEach(tier => Object.assign(tier, resolveSmsTierPrice(tier.baseCostNGN, rules, smsMarkup, smsFloor)));

        country.tiers.sort((a, b) => {
            if (a.amount !== b.amount) {
                return a.amount - b.amount;
            }
            // Same selling price (e.g. a fixed price): the cheaper operator for us goes first
            if (a.costUsd !== b.costUsd) {
                return a.costUsd - b.costUsd;
            }
            return String(b.providerId).localeCompare(String(a.providerId), undefined, { numeric: true });
        });
    });

    return formattedCountries;
}

// SMSBower operators for one service, per country, with their cost (no selling price yet)
async function fetchSmsCostCatalog(cleanServiceCode, exchangeRateToNgn) {
    // 1. Fetch upstream vendor endpoints concurrently
    const [rawCountriesMeta, pricesResponse] = await Promise.all([
        getCountriesMeta(),
        smsBowerClient.get('', {
            params: {
                action: 'getPricesV3',
                service: cleanServiceCode
            }
        })
    ]);

    const rawTopCountries = pricesResponse?.data;

    if (!rawTopCountries || typeof rawTopCountries === 'string' || rawTopCountries.success === false) {
        return [];
    }

    let countryMetaMap = {};
    parseSmsCountriesMeta(rawCountriesMeta).forEach(c => {
        countryMetaMap[c.countryId] = { name: c.countryName, code: c.code };
        if (c.code) countryMetaMap[c.code] = countryMetaMap[c.countryId];
    });

    let formattedCountries = [];
    const countryData = rawTopCountries.country || rawTopCountries.countries || rawTopCountries.data || rawTopCountries;

    if (countryData && typeof countryData === 'object') {
        Object.keys(countryData).forEach(countryKey => {
            const countryVal = countryData[countryKey];
            if (!countryVal || typeof countryVal !== 'object') return;

            const vendorMeta = countryMetaMap[String(countryKey).toLowerCase()] || {};
            const resolvedName = vendorMeta.name || countryKey.toUpperCase();
            const resolvedCode = (vendorMeta.code || countryKey).toLowerCase();

            // Skip US Virtual for WhatsApp / wa
            if (cleanServiceCode === 'whatsapp' || cleanServiceCode === 'wa') {
                const keyString = String(countryKey).trim().toLowerCase();
                const nameLower = resolvedName.toLowerCase();
                const codeLower = resolvedCode.toLowerCase();

                const isUsVirtual =
                    keyString === '12' ||
                    keyString.includes('virtual') ||
                    codeLower.includes('virtual') ||
                    (nameLower.includes('virtual') && (nameLower.includes('usa') || nameLower.includes('united states') || keyString === 'usa' || keyString === 'us'));

                if (isUsVirtual) {
                    return; // Skips United States (virtual) for WhatsApp completely
                }
            }

            let allAvailablePrices = [];
            Object.keys(countryVal).forEach(innerKey => {
                const innerVal = countryVal[innerKey];
                if (!innerVal || typeof innerVal !== 'object') return;

                const isProviderNode = 'price' in innerVal || 'cost' in innerVal || 'count' in innerVal;
                const providersObject = isProviderNode ? { [innerKey]: innerVal } : innerVal;

                if (!providersObject || typeof providersObject !== 'object') return;

                Object.keys(providersObject).forEach(providerKey => {
                    const tierItem = providersObject[providerKey];
                    const variants = Array.isArray(tierItem) ? tierItem : [tierItem];

                    variants.forEach(v => {
                        let rawCostUsd = 0;
                        if (v && typeof v === 'object') {
                            rawCostUsd = Number(v.price || v.cost || v.value || 0);
                        } else if (typeof v === 'number') {
                            rawCostUsd = v;
                        }

                        if (rawCostUsd <= 0 || rawCostUsd > 10000) return;

                        const rawPriceInNgn = rawCostUsd * exchangeRateToNgn;

                        const rawRank = (v && typeof v === 'object' && (v.rank || v.tier)) || providerKey || 'Standard';
                        const formattedRank = String(rawRank).charAt(0).toUpperCase() + String(rawRank).slice(1).toLowerCase();

                        const rawCount = Number((v && typeof v === 'object' && (v.count ?? v.stock ?? v.qty ?? v.amountAvailable)) || 0);
                        const currentProviderId = String((v && typeof v === 'object' && (v.partner_id || v.provider_id || v.id)) || providerKey);

                        allAvailablePrices.push({
                            providerId: currentProviderId,
                            count: rawCount,
                            rank: formattedRank,
                            costUsd: rawCostUsd, // Vendor cost in USD (server use only)
                            baseCostNGN: rawPriceInNgn // Vendor cost before markup (server use only)
                        });
                    });
                });
            });

            if (allAvailablePrices.length > 0) {
                formattedCountries.push({
                    countryId: String(countryKey),
                    countryName: resolvedName,
                    code: resolvedCode,
                    flagUrl: resolvedCode && resolvedCode.length === 2
                        ? `https://flagcdn.com/w40/${resolvedCode.toLowerCase()}.png`
                        : `https://flagcdn.com/w40/un.png`,
                    tiers: allAvailablePrices
                });
            }
        });
    }

    return formattedCountries;
}

/**
 * Builds the priced country list for one SMS service: ONE price per country.
 * Used by the countries page AND by the purchase handler, so the price a user is
 * charged is always the price this function computes, never a number from the browser.
 */
async function getSmsCountryPrices(cleanServiceCode) {
    // 1. Live Catalog And The Admin's Pool Overrides Together
    const [catalog, overrides] = await Promise.all([
        getSmsPriceCatalog(cleanServiceCode),
        SmsPoolOverride.find({ serviceCode: cleanServiceCode }).select('countryId operatorId').lean()
    ]);
    const fixedOperatorByCountry = new Map(overrides.map(o => [String(o.countryId), String(o.operatorId)]));

    const formattedCountries = catalog.map(country => {
        // 2. Fixed Operator: Its Price, While It Still Has Numbers
        const fixedOperatorId = fixedOperatorByCountry.get(country.countryId);
        const fixedTier = fixedOperatorId
            ? country.tiers.find(t => t.providerId === fixedOperatorId && t.count > 0)
            : null;

        // 3. Automatic Pool: The Cheapest Operator That Has Numbers
        const tier = fixedTier || country.tiers.find(t => t.count > 0) || country.tiers[0];

        return {
            countryId: country.countryId,
            countryName: country.countryName,
            code: country.code,
            flagUrl: country.flagUrl,
            stock: tier.count,
            price: { amount: tier.amount, currency: 'NGN', symbol: '₦' },
            poolMode: fixedTier ? 'fixed' : 'auto', // Server use only
            tier // Server use only (operator and vendor cost)
        };
    });

    formattedCountries.sort((a, b) => a.price.amount - b.price.amount);
    return formattedCountries;
}

// Strips the supplier details (operator, vendor cost, pool mode, pricing) from an order before a user sees it
const SMS_SUPPLIER_FIELDS = ['operator', 'operatorUsed', 'poolMode', 'vendorCostUsd', 'vendorCostNGN', 'markupApplied', 'pricing', 'vendorCancelPending', 'vendorCancelResult'];

function toUserOrder(order) {
    const plain = typeof order?.toObject === 'function' ? order.toObject() : { ...order };
    if (plain.metadata && typeof plain.metadata === 'object') {
        plain.metadata = { ...plain.metadata };
        SMS_SUPPLIER_FIELDS.forEach(field => delete plain.metadata[field]);
    }
    return plain;
}

async function handleGetCountries(req, res) {
    res.setHeader('Content-Type', 'application/json');

    try {
        const serviceCode = req.query.service || req.params?.service || req.body?.service;

        if (!serviceCode || typeof serviceCode !== 'string') {
            return res.status(400).json({ success: false, message: "Service code is required." });
        }

        const countries = await getSmsCountryPrices(serviceCode.trim().toLowerCase());

        // Operator, vendor cost and pool mode stay on the server
        const publicCountries = countries.map(({ tier, poolMode, ...country }) => country);

        return res.status(200).json({ success: true, countries: publicCountries });
    } catch (err) {
        console.error("Failed to fetch SMS countries from vendor:", err.response?.data || err.message);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch country catalog from vendor."
        });
    }
}

// --- SMS POOL OVERRIDES (ADMIN) ---
// Accepts SMSBower service codes ('wa', 'tg') and IDs (country '16', operator '2295')
const SMS_CODE_PATTERN = /^[a-z0-9_-]{1,20}$/i;

// Shapes one operator tier for the admin picker (costs and prices in whole NGN)
function toAdminOperator(tier) {
    return {
        operatorId: tier.providerId,
        count: tier.count,
        costUsd: tier.costUsd,
        costNGN: Math.round(tier.baseCostNGN),
        baseCostNGN: tier.baseCostNGN, // Unrounded, so the page's price preview matches the server
        sellNGN: Math.round(tier.amount),
        pricing: tier.pricing
    };
}

/**
 * Live SMSBower operators for one service + country, with what users would pay for each.
 * Drives the admin pool picker.
 */
async function handleGetSmsOperators(req, res) {
    const serviceCode = typeof req.query.service === 'string' ? req.query.service.trim().toLowerCase() : '';
    const countryId = typeof req.query.country === 'string' ? req.query.country.trim() : '';
    if (!SMS_CODE_PATTERN.test(serviceCode) || !SMS_CODE_PATTERN.test(countryId)) {
        return res.status(400).json({ success: false, message: "Choose a service and a country." });
    }

    try {
        // 1. Every Operator SMSBower Lists Right Now, Plus Any Saved Override And Price Rules
        const [catalog, override, priceOverrides, systemSettings] = await Promise.all([
            getSmsPriceCatalog(serviceCode),
            SmsPoolOverride.findOne({ serviceCode, countryId }).lean(),
            SmsPriceOverride.find({ serviceCode: { $in: [serviceCode, SMS_ANY] }, countryId: { $in: [countryId, SMS_ANY] } }).lean(),
            getSystemSettingsCached()
        ]);
        // The page previews a new price with the same fallback chain as resolveSmsTierPrice
        const priceRules = {
            serviceCountry: priceOverrides.find(o => o.serviceCode === serviceCode && o.countryId === countryId) || null,
            service: priceOverrides.find(o => o.serviceCode === serviceCode && o.countryId === SMS_ANY) || null,
            country: priceOverrides.find(o => o.serviceCode === SMS_ANY && o.countryId === countryId) || null,
            generalMarkup: systemSettings?.smsMarkupPercentage || 0,
            floorPriceNGN: Math.max(Number(systemSettings?.smsFloorPriceNGN) || 0, 0)
        };
        const country = catalog.find(c => c.countryId === countryId);
        if (!country) {
            return res.json({ success: true, countryId, operators: [], automatic: null, override, overrideAvailable: false, priceRules });
        }

        // 2. Whether The Saved Operator Can Still Sell (otherwise users get the automatic pool)
        const overrideTier = override ? country.tiers.find(t => t.providerId === override.operatorId) : null;

        return res.json({
            success: true,
            countryId,
            countryName: country.countryName,
            operators: country.tiers.map(toAdminOperator),
            automatic: toAdminOperator(country.tiers.find(t => t.count > 0) || country.tiers[0]), // Same pick as getSmsCountryPrices
            override,
            overrideAvailable: Boolean(overrideTier && overrideTier.count > 0),
            priceRules
        });
    } catch (err) {
        console.error("SMS Operators Error:", err.response?.data || err.message);
        return res.status(502).json({ success: false, message: "Could not load operators from SMSBower." });
    }
}

async function handleGetSmsPoolOverrides(req, res) {
    try {
        const overrides = await SmsPoolOverride.find().sort({ updatedAt: -1 }).lean();
        return res.json({ success: true, overrides });
    } catch (err) {
        console.error("SMS Pool Overrides Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleSaveSmsPoolOverride(req, res) {
    const { serviceCode, countryId, operatorId, serviceName } = req.body;
    if (typeof serviceCode !== 'string' || typeof countryId !== 'string' || typeof operatorId !== 'string' ||
        !SMS_CODE_PATTERN.test(serviceCode.trim()) || !SMS_CODE_PATTERN.test(countryId.trim()) || !SMS_CODE_PATTERN.test(operatorId.trim())) {
        return res.status(400).json({ success: false, message: "Choose a service, a country and an operator." });
    }
    const cleanService = serviceCode.trim().toLowerCase();
    const cleanCountry = countryId.trim();
    const cleanOperator = operatorId.trim();

    try {
        // 1. The Operator Must Be One SMSBower Lists For This Service And Country
        const catalog = await getSmsPriceCatalog(cleanService);
        const country = catalog.find(c => c.countryId === cleanCountry);
        const tier = country?.tiers.find(t => t.providerId === cleanOperator);
        if (!tier) {
            return res.status(400).json({ success: false, message: "SMSBower doesn't list that operator for this service and country right now." });
        }

        // 2. One Override Per Service + Country (saving again replaces it)
        const override = await SmsPoolOverride.findOneAndUpdate(
            { serviceCode: cleanService, countryId: cleanCountry },
            {
                $set: {
                    operatorId: cleanOperator,
                    serviceName: cleanText(serviceName, 80) || cleanService.toUpperCase(),
                    countryName: country.countryName,
                    updatedBy: req.admin?.email || null
                }
            },
            { upsert: true, returnDocument: 'after' }
        );

        console.log(`✅ SMS pool override: ${cleanService}/${cleanCountry} → operator ${cleanOperator} by ${req.admin?.email}`);
        return res.json({
            success: true,
            message: tier.count > 0
                ? "Fixed operator saved. Users now pay its price."
                : "Fixed operator saved, but it has no numbers right now. Users get the automatic pool until it restocks.",
            override
        });
    } catch (err) {
        console.error("Save SMS Pool Override Error:", err.response?.data || err.message);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleDeleteSmsPoolOverride(req, res) {
    const id = req.query.id || req.body?.id;
    if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: "Invalid override ID." });
    }

    try {
        const removed = await SmsPoolOverride.findByIdAndDelete(id);
        if (!removed) return res.status(404).json({ success: false, message: "Override not found." });

        return res.json({ success: true, message: "Back to the automatic pool." });
    } catch (err) {
        console.error("Delete SMS Pool Override Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- SMS PRICE OVERRIDES (ADMIN) ---
const SMS_MAX_MARKUP_PERCENT = 1000;
const SMS_MAX_FIXED_PRICE_NGN = 10000000;

// Every country SMSBower sells in, for "All services" price rules
async function handleGetSmsCountryList(req, res) {
    try {
        const countries = isSmsDemoMode()
            ? SMS_DEMO_COUNTRIES.map(({ countryId, countryName, code }) => ({ countryId, countryName, code }))
            : parseSmsCountriesMeta(await getCountriesMeta());

        countries.sort((a, b) => a.countryName.localeCompare(b.countryName));
        return res.json({ success: true, countries });
    } catch (err) {
        console.error("SMS Country List Error:", err.response?.data || err.message);
        return res.status(502).json({ success: false, message: "Could not load countries from SMSBower." });
    }
}

async function handleGetSmsPriceOverrides(req, res) {
    try {
        const overrides = await SmsPriceOverride.find().sort({ updatedAt: -1 }).lean();
        return res.json({ success: true, overrides });
    } catch (err) {
        console.error("SMS Price Overrides Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleSaveSmsPriceOverride(req, res) {
    const { serviceCode, countryId, pricingType, value, serviceName, countryName } = req.body;
    const isCode = (code) => typeof code === 'string' && (code.trim() === SMS_ANY || SMS_CODE_PATTERN.test(code.trim()));
    if (!isCode(serviceCode) || !isCode(countryId)) {
        return res.status(400).json({ success: false, message: "Choose a service and a country." });
    }
    const cleanService = serviceCode.trim().toLowerCase();
    const cleanCountry = countryId.trim();
    if (cleanService === SMS_ANY && cleanCountry === SMS_ANY) {
        return res.status(400).json({ success: false, message: "For every service in every country, change the general SMS markup instead." });
    }

    // 1. Markup % Or A Fixed NGN Price
    const amount = Number(value);
    if (pricingType === 'markup' && !(Number.isFinite(amount) && amount >= 0 && amount <= SMS_MAX_MARKUP_PERCENT)) {
        return res.status(400).json({ success: false, message: `Markup must be between 0% and ${SMS_MAX_MARKUP_PERCENT}%.` });
    }
    if (pricingType === 'fixed' && !(Number.isFinite(amount) && amount >= 1 && amount <= SMS_MAX_FIXED_PRICE_NGN)) {
        return res.status(400).json({ success: false, message: "Enter a fixed price in Naira." });
    }
    if (!['markup', 'fixed'].includes(pricingType)) {
        return res.status(400).json({ success: false, message: "Choose markup or fixed price." });
    }

    try {
        // 2. One Row Per Service + Country Pair (saving again replaces it)
        const override = await SmsPriceOverride.findOneAndUpdate(
            { serviceCode: cleanService, countryId: cleanCountry },
            {
                $set: {
                    pricingType,
                    markupPercentage: pricingType === 'markup' ? Number(amount.toFixed(2)) : null,
                    fixedPriceNGN: pricingType === 'fixed' ? Math.round(amount) : null,
                    serviceName: cleanService === SMS_ANY ? 'All services' : (cleanText(serviceName, 80) || cleanService.toUpperCase()),
                    countryName: cleanCountry === SMS_ANY ? 'All countries' : (cleanText(countryName, 80) || `Country ${cleanCountry}`),
                    updatedBy: req.admin?.email || null
                }
            },
            { upsert: true, returnDocument: 'after' }
        );

        // 3. Warn When A Fixed Price Is Under What SMSBower Charges (it is skipped for those operators)
        let message = "Price saved.";
        if (pricingType === 'fixed' && cleanService !== SMS_ANY && cleanCountry !== SMS_ANY) {
            const catalog = await getSmsPriceCatalog(cleanService).catch(() => []);
            const tiers = catalog.find(c => c.countryId === cleanCountry)?.tiers || [];
            const cheapestCost = Math.min(...tiers.filter(t => t.count > 0).map(t => t.baseCostNGN));
            if (Number.isFinite(cheapestCost) && override.fixedPriceNGN < cheapestCost) {
                message = `Price saved, but ₦${override.fixedPriceNGN.toLocaleString()} is below SMSBower's cost (₦${Math.ceil(cheapestCost).toLocaleString()}), so the next rule down prices this number.`;
            }
        } else if (pricingType === 'fixed') {
            message = "Price saved. Wherever SMSBower's cost is above it, the next rule down prices the number.";
        }

        console.log(`✅ SMS price override: ${cleanService}/${cleanCountry} → ${pricingType} ${amount} by ${req.admin?.email}`);
        return res.json({ success: true, message, override });
    } catch (err) {
        console.error("Save SMS Price Override Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleDeleteSmsPriceOverride(req, res) {
    const id = req.query.id || req.body?.id;
    if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: "Invalid override ID." });
    }

    try {
        const removed = await SmsPriceOverride.findByIdAndDelete(id);
        if (!removed) return res.status(404).json({ success: false, message: "Price override not found." });

        return res.json({ success: true, message: "Price override removed." });
    } catch (err) {
        console.error("Delete SMS Price Override Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

/**
 * Admin list of SMS number orders with the operator used and the SMSBower cost.
 * Orders placed before operator/cost tracking show null for those fields.
 */
async function handleGetAdminSmsOrders(req, res) {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    try {
        // 1. Filters
        const filter = { productType: 'SmsNumber' };
        if (['pending', 'completed', 'cancelled', 'failed'].includes(status)) filter.status = status;
        if (search) {
            const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ userEmail: pattern }, { targetNumber: pattern }, { vendorOrderId: pattern }, { 'metadata.serviceName': pattern }];
        }

        const [orders, total] = await Promise.all([
            Order.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .select('userEmail fullName status amount targetNumber country vendorOrderId smsCode planName refundedAt createdAt metadata')
                .lean(),
            Order.countDocuments(filter)
        ]);

        // 2. Flatten For The Table
        const rows = orders.map(o => ({
            _id: o._id,
            createdAt: o.createdAt,
            userEmail: o.userEmail,
            fullName: o.fullName,
            serviceName: o.metadata?.serviceName || o.planName || o.metadata?.serviceCode || 'SMS',
            serviceCode: o.metadata?.serviceCode || null,
            countryId: o.metadata?.countryCode || o.country || null,
            countryName: o.metadata?.countryName || null,
            number: o.targetNumber || null,
            smsCode: o.smsCode || null,
            status: o.status,
            refunded: Boolean(o.refundedAt),
            sellNGN: o.amount,
            costNGN: o.metadata?.vendorCostNGN ?? null,
            costUsd: o.metadata?.vendorCostUsd ?? null,
            operator: o.metadata?.operatorUsed ?? o.metadata?.operator ?? null,
            poolMode: o.metadata?.poolMode || null
        }));

        return res.json({ success: true, orders: rows, total, page, pages: Math.max(Math.ceil(total / limit), 1) });
    } catch (err) {
        console.error("Admin SMS Orders Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- ACCOUNTS & VPN ORDERS (ADMIN TRANSACTION HISTORY) ---
async function handleGetAdminAccountOrders(req, res) {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    try {
        // 1. Filters ('refunded' is a claimed refund, not an order status)
        const filter = { productType: 'Account' };
        if (status === 'refunded') filter.refundedAt = { $ne: null };
        else if (status === 'delivered') filter.refundedAt = null;
        if (search) {
            const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ userEmail: pattern }, { fullName: pattern }, { nodeName: pattern }, { planName: pattern }, { paymentReference: pattern }, { vendorOrderId: pattern }];
        }

        const [orders, total] = await Promise.all([
            Order.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .select('userEmail fullName status amount nodeName planName paymentReference vendorOrderId refundedAt createdAt metadata.quantity metadata.categoryName metadata.vendorCostNGN')
                .lean(),
            Order.countDocuments(filter)
        ]);

        // 2. Flatten For The Table (account keys stay out of the list)
        const rows = orders.map(o => ({
            _id: o._id,
            createdAt: o.createdAt,
            userEmail: o.userEmail,
            fullName: o.fullName,
            productName: o.nodeName || 'Account',
            categoryName: o.metadata?.categoryName || o.planName || null,
            quantity: o.metadata?.quantity || 1,
            reference: o.paymentReference || null,
            vendorOrderId: o.vendorOrderId || null,
            refunded: Boolean(o.refundedAt),
            sellNGN: o.amount,
            costNGN: o.metadata?.vendorCostNGN ?? null
        }));

        return res.json({ success: true, orders: rows, total, page, pages: Math.max(Math.ceil(total / limit), 1) });
    } catch (err) {
        console.error("Admin Account Orders Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- WALLET DEPOSITS (ADMIN TRANSACTION HISTORY) ---
// Flutterwave top-ups (card, bank transfer, USSD...) and manual admin credits
async function handleGetAdminDeposits(req, res) {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    try {
        // 1. Filters (transactions only hold the userId, so a name/email search looks up users first)
        const filter = { purpose: 'deposit' };
        if (['successful', 'pending', 'failed'].includes(status)) filter.status = status;
        if (search) {
            const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const matchedUsers = await User.find({ $or: [{ email: pattern }, { fullName: pattern }] }).select('_id').limit(500).lean();
            filter.$or = [{ reference: pattern }, { userId: { $in: matchedUsers.map(u => u._id) } }];
        }

        const [deposits, total, totals] = await Promise.all([
            Transaction.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .select('userId amountNGN status reference paymentMethod balanceBefore balanceAfter createdAt metadata.chargedNGN metadata.feeNGN metadata.adminEmail metadata.note')
                .populate('userId', 'email fullName')
                .lean(),
            Transaction.countDocuments(filter),
            Transaction.aggregate([
                { $match: { ...filter, status: 'successful' } },
                { $group: { _id: null, creditedNGN: { $sum: '$amountNGN' }, count: { $sum: 1 } } }
            ])
        ]);

        // 2. Flatten For The Table (the raw Flutterwave payload stays on the server)
        const rows = deposits.map(t => ({
            _id: t._id,
            createdAt: t.createdAt,
            userEmail: t.userId?.email || 'Deleted user',
            fullName: t.userId?.fullName || '',
            amountNGN: t.amountNGN,
            chargedNGN: t.metadata?.chargedNGN ?? null, // What the customer paid Flutterwave (credit + top-up fee)
            feeNGN: t.metadata?.feeNGN ?? null,
            method: t.paymentMethod || 'card',
            adminEmail: t.metadata?.adminEmail || null,
            note: t.metadata?.note || null,
            reference: t.reference,
            status: t.status,
            balanceAfter: t.status === 'successful' ? t.balanceAfter : null
        }));

        return res.json({
            success: true,
            deposits: rows,
            total,
            page,
            pages: Math.max(Math.ceil(total / limit), 1),
            successfulCount: totals[0]?.count || 0,
            successfulNGN: totals[0]?.creditedNGN || 0
        });
    } catch (err) {
        console.error("Admin Deposits Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- SMS OVERVIEW METRICS (ADMIN) ---
// "Today" and months follow the Lagos clock (UTC+1, no daylight saving)
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function startOfLagosDay(now = new Date()) {
    const dayMs = 24 * 60 * 60 * 1000;
    return new Date(Math.floor((now.getTime() + LAGOS_OFFSET_MS) / dayMs) * dayMs - LAGOS_OFFSET_MS);
}

// Overview building blocks, shared by sms-stats and daily-stats so a day on the Daily Changes
// page always matches what the overview's "today" pills showed on that day.
// 1. Both Product Lines: SMSBower numbers and Sameeha accounts & VPN
const STATS_PRODUCT_MATCH = {
    $match: { $or: [{ productType: 'SmsNumber' }, { productType: 'Account', 'metadata.vendor': 'sameeha' }] }
};

// 2. Per-Order Flags (a number is delivered once its code arrives, a Sameeha order unless refunded)
const STATS_ORDER_FLAGS = {
    kind: { $cond: [{ $eq: ['$productType', 'SmsNumber'] }, 'numbers', 'accounts'] },
    isReceived: {
        $cond: [
            { $eq: ['$productType', 'SmsNumber'] },
            { $eq: ['$status', 'completed'] },
            { $and: [{ $in: ['$status', ['successful', 'completed']] }, { $not: [{ $ifNull: ['$refundedAt', false] }] }] }
        ]
    },
    hasCost: { $isNumber: '$metadata.vendorCostNGN' }
};

const statsSumIf = (condition, value = 1) => ({ $sum: { $cond: [condition, value, 0] } });

// 3. Money Fields For A $group (extra = conditions every field must also meet, e.g. '$isToday')
function statsMoneyFields(extra = []) {
    const receivedWithCost = { $and: ['$isReceived', '$hasCost'] };
    return {
        orders: statsSumIf({ $and: [true, ...extra] }),
        received: statsSumIf({ $and: ['$isReceived', ...extra] }),
        revenue: statsSumIf({ $and: ['$isReceived', ...extra] }, '$amount'),
        trackedReceived: statsSumIf({ $and: [receivedWithCost, ...extra] }),
        trackedRevenue: statsSumIf({ $and: [receivedWithCost, ...extra] }, '$amount'),
        cost: statsSumIf({ $and: [receivedWithCost, ...extra] }, '$metadata.vendorCostNGN')
    };
}

// 4. Rounded Totals (profit = revenue of cost-tracked orders minus their cost)
function shapeStats(src = {}, prefix = '') {
    const pick = key => Math.round(Number(src[`${prefix}${key}`]) || 0);
    return {
        orders: pick('orders'),
        received: pick('received'),
        revenue: pick('revenue'),
        cost: pick('cost'),
        profit: pick('trackedRevenue') - pick('cost'),
        trackedReceived: pick('trackedReceived')
    };
}

/**
 * Admin overview, modelled on the DanSMS overview: Total, Numbers (SMSBower), Social & VPN
 * (Sameeha 'Account' orders), Platform, and a combined monthly history.
 * Revenue counts delivered orders only: received numbers ('completed') and Sameeha orders
 * that weren't refunded. Cost and profit only cover orders that recorded the vendor's cost
 * (SMS numbers from 2026-10-13; Sameeha orders always record it).
 */
async function handleGetSmsStats(req, res) {
    try {
        const todayStart = startOfLagosDay();

        // 1. Shared Per-Order Flags For Both Product Lines (see STATS_ORDER_FLAGS)
        const productMatch = STATS_PRODUCT_MATCH;
        const flagStage = { $addFields: { ...STATS_ORDER_FLAGS, isToday: { $gte: ['$createdAt', todayStart] } } };
        const sumIf = statsSumIf;
        const moneyFields = statsMoneyFields;
        const prefixKeys = (fields, prefix) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${prefix}${k}`, v]));

        // 2. Product Lines, Users And Wallet Movements In Parallel
        const [byKind, monthly, depositMonths, userCount, newUsersToday, [wallets], [money]] = await Promise.all([
            Order.aggregate([
                productMatch,
                flagStage,
                { $group: { _id: '$kind', ...moneyFields(), ...prefixKeys(moneyFields(['$isToday']), 'today_') } }
            ]),
            Order.aggregate([
                productMatch,
                flagStage,
                { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Africa/Lagos' } }, ...moneyFields() } },
                { $sort: { _id: -1 } }
            ]),
            Transaction.aggregate([
                { $match: { status: 'successful', purpose: 'deposit' } },
                { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Africa/Lagos' } }, deposits: { $sum: '$amountNGN' } } }
            ]),
            User.countDocuments(),
            User.countDocuments({ createdAt: { $gte: todayStart } }),
            User.aggregate([{ $group: { _id: null, balance: { $sum: '$balance' }, bonus: { $sum: '$bonusBalance' } } }]),
            Transaction.aggregate([
                { $match: { status: 'successful' } },
                { $addFields: { isToday: { $gte: ['$createdAt', todayStart] } } },
                { $group: {
                    _id: null,
                    totalDeposits: sumIf({ $eq: ['$purpose', 'deposit'] }, '$amountNGN'),
                    depositsToday: sumIf({ $and: [{ $eq: ['$purpose', 'deposit'] }, '$isToday'] }, '$amountNGN'),
                    purchasesToday: sumIf({ $and: [{ $eq: ['$purpose', 'purchase'] }, '$isToday'] }, '$amountNGN'),
                    refundsToday: sumIf({ $and: [{ $eq: ['$purpose', 'refund'] }, '$isToday'] }, '$amountNGN'),
                    bonusesToday: sumIf({ $and: [{ $eq: ['$purpose', 'referral_bonus'] }, '$isToday'] }, '$amountNGN')
                } }
            ])
        ]);

        // 3. Shape The Totals
        const shape = shapeStats;
        const addUp = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] + b[key]]));
        const numbers = byKind.find(k => k._id === 'numbers');
        const accounts = byKind.find(k => k._id === 'accounts');
        const spentToday = Math.round((money?.purchasesToday || 0) - (money?.refundsToday || 0));
        const depositsToday = Math.round(money?.depositsToday || 0);

        return res.json({
            success: true,
            total: addUp(shape(numbers), shape(accounts)),
            numbers: shape(numbers),
            accounts: shape(accounts),
            today: {
                total: addUp(shape(numbers, 'today_'), shape(accounts, 'today_')),
                numbers: shape(numbers, 'today_'),
                accounts: shape(accounts, 'today_')
            },
            platform: {
                userCount,
                newUsersToday,
                userBalance: Math.round((wallets?.balance || 0) + (wallets?.bonus || 0)),
                totalDeposits: Math.round(money?.totalDeposits || 0),
                depositsToday,
                spentToday,
                // Wallets grow with deposits and referral bonuses, shrink with spending
                netToday: depositsToday + Math.round(money?.bonusesToday || 0) - spentToday
            },
            months: [...new Set([...monthly.map(m => m._id), ...depositMonths.map(d => d._id)])].sort().reverse().map(month => ({
                month,
                ...shape(monthly.find(m => m._id === month)),
                deposits: Math.round(depositMonths.find(d => d._id === month)?.deposits || 0) // Wallet top-ups credited that month
            })),
            costTrackingSince: '2026-10-13'
        });
    } catch (err) {
        console.error("SMS Stats Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- DAILY CHANGES (ADMIN) ---
/**
 * The overview's metrics for one Lagos day plus the `days` before it, ported from DanSMS's
 * "Daily changes" tab. GET ?date=YYYY-MM-DD&days=14 returns days + 1 rows, oldest first, the
 * last row being `date` (the extra leading row gives the oldest visible day a comparison).
 * Every day is present (zeros on a quiet day) and uses sms-stats' exact rules:
 *   numbers / accounts - orders created that day; received, revenue, cost, profit from delivered ones
 *   newUsers           - accounts created that day
 *   balance            - deposits, spent (purchases minus refunds), referral bonuses,
 *                        net = deposits + bonuses - spent (the "Users' balance" pill)
 * Plus end-of-day running totals: usersTotal and balance.totalDeposits.
 */
async function handleGetDailyStats(req, res) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const today = new Date(Date.now() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
    let date = typeof req.query.date === 'string' && req.query.date ? req.query.date : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        return res.status(400).json({ success: false, message: "Date must be YYYY-MM-DD." });
    }
    if (date > today) date = today;
    const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90);

    try {
        // 1. Range Bounds (Lagos midnights, as UTC instants)
        const from = new Date(Date.parse(`${date}T12:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
        const rangeStart = new Date(Date.parse(`${from}T00:00:00Z`) - LAGOS_OFFSET_MS);
        const rangeEnd = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS - LAGOS_OFFSET_MS);
        const inRange = { createdAt: { $gte: rangeStart, $lt: rangeEnd } };
        const lagosDay = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Africa/Lagos' } };
        const purposeIs = purpose => ({ $eq: ['$purpose', purpose] });

        // 2. Orders, Signups And Wallet Movements Per Day, Plus Totals Before The Range
        const [orderDays, userDays, moneyDays, usersBefore, [depositsBefore]] = await Promise.all([
            Order.aggregate([
                { $match: inRange },
                STATS_PRODUCT_MATCH,
                { $addFields: STATS_ORDER_FLAGS },
                { $group: { _id: { day: lagosDay, kind: '$kind' }, ...statsMoneyFields() } }
            ]),
            User.aggregate([
                { $match: inRange },
                { $group: { _id: lagosDay, count: { $sum: 1 } } }
            ]),
            Transaction.aggregate([
                { $match: { status: 'successful', ...inRange } },
                { $group: {
                    _id: lagosDay,
                    deposits: statsSumIf(purposeIs('deposit'), '$amountNGN'),
                    purchases: statsSumIf(purposeIs('purchase'), '$amountNGN'),
                    refunds: statsSumIf(purposeIs('refund'), '$amountNGN'),
                    bonuses: statsSumIf(purposeIs('referral_bonus'), '$amountNGN')
                } }
            ]),
            User.countDocuments({ createdAt: { $lt: rangeStart } }),
            Transaction.aggregate([
                { $match: { status: 'successful', purpose: 'deposit', createdAt: { $lt: rangeStart } } },
                { $group: { _id: null, total: { $sum: '$amountNGN' } } }
            ])
        ]);

        // 3. One Row Per Day, Oldest First, With Running Totals
        let usersTotal = usersBefore;
        let totalDeposits = Math.round(depositsBefore?.total || 0);
        const rows = [];
        for (let day = from; day <= date; day = new Date(Date.parse(`${day}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) {
            const money = moneyDays.find(m => m._id === day) || {};
            const deposits = Math.round(money.deposits || 0);
            const bonuses = Math.round(money.bonuses || 0);
            const spent = Math.round((money.purchases || 0) - (money.refunds || 0));
            const newUsers = userDays.find(u => u._id === day)?.count || 0;
            usersTotal += newUsers;
            totalDeposits += deposits;

            rows.push({
                date: day,
                numbers: shapeStats(orderDays.find(o => o._id.day === day && o._id.kind === 'numbers')),
                accounts: shapeStats(orderDays.find(o => o._id.day === day && o._id.kind === 'accounts')),
                newUsers,
                usersTotal,
                balance: { deposits, totalDeposits, spent, bonuses, net: deposits + bonuses - spent }
            });
        }

        return res.json({ success: true, date, today, rows });
    } catch (err) {
        console.error("Daily Stats Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// --- USER ACTIVITY (ADMIN) ---
const ACTIVITY_CATEGORIES = ['deposit', 'purchase', 'refund', 'failed'];

/**
 * One newest-first timeline of everything users do, ported from DanSMS's "User activity" hub.
 * GET ?page=1&limit=50&category=all|deposit|purchase|refund|failed&search=&userId=
 *   deposit  - wallet deposits, any status (Flutterwave top-ups and admin credits)
 *   purchase - orders of any product that weren't refunded
 *   refund   - orders that were refunded, cancelled or failed
 *   failed   - purchase attempts that never became an order (PurchaseAttempt)
 * Successful deposits also carry `firstPurchase`: the first order placed after that deposit and
 * before the user's next one, i.e. what they spent this money on.
 */
async function handleGetUserActivity(req, res) {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const category = ACTIVITY_CATEGORIES.includes(req.query.category) ? req.query.category : 'all';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
    const userId = typeof req.query.userId === 'string' && mongoose.isValidObjectId(req.query.userId) ? req.query.userId : null;

    try {
        // 1. Narrow To One User, Or To The Users Matching A Name/Email Search
        let userIds = null;
        if (userId) {
            userIds = [new mongoose.Types.ObjectId(userId)];
        } else if (search) {
            const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const matchedUsers = await User.find({ $or: [{ email: pattern }, { fullName: pattern }] }).select('_id').limit(200).lean();
            if (!matchedUsers.length) return res.json({ success: true, rows: [], total: 0, page, pages: 1 });
            userIds = matchedUsers.map(u => u._id);
        }
        const byUser = userIds ? { userId: { $in: userIds } } : {};
        const wants = name => category === 'all' || category === name;

        // 2. One Branch Per Source, Each Projected To The Same Row Shape
        const isRefunded = { $or: [{ $ne: [{ $ifNull: ['$refundedAt', null] }, null] }, { $in: ['$status', ['cancelled', 'failed']] }] };
        const orderFilter = category === 'refund'
            ? { $or: [{ refundedAt: { $ne: null } }, { status: { $in: ['cancelled', 'failed'] } }] }
            : category === 'purchase' ? { refundedAt: null, status: { $nin: ['cancelled', 'failed'] } } : {};

        const branches = [];
        if (wants('deposit')) {
            branches.push({ coll: Transaction.collection.name, pipeline: [
                { $match: { purpose: 'deposit', ...byUser } },
                { $project: {
                    category: { $literal: 'deposit' }, kind: { $literal: 'deposit' }, userId: 1, at: '$createdAt',
                    status: 1, amount: '$amountNGN', ref: '$reference', method: '$paymentMethod', adminEmail: '$metadata.adminEmail'
                } }
            ] });
        }
        if (wants('purchase') || wants('refund')) {
            branches.push({ coll: Order.collection.name, pipeline: [
                { $match: { ...orderFilter, ...byUser } },
                { $project: {
                    category: { $cond: [isRefunded, 'refund', 'purchase'] }, kind: '$productType', userId: 1, userEmail: 1,
                    at: '$createdAt', status: 1, amount: 1, ref: '$paymentReference',
                    label: { $ifNull: ['$metadata.serviceName', '$nodeName', '$planName'] },
                    country: '$metadata.countryName', number: '$targetNumber'
                } }
            ] });
        }
        if (wants('failed')) {
            branches.push({ coll: PurchaseAttempt.collection.name, pipeline: [
                { $match: byUser },
                { $project: {
                    category: { $literal: 'failed' }, kind: '$productType', userId: 1, userEmail: 1, at: '$createdAt',
                    status: { $literal: 'failed' }, amount: 1, label: 1, country: 1, reason: 1, message: 1
                } }
            ] });
        }

        // 3. Merge, Sort Newest First And Cut One Page (with the total for the pager)
        const [first, ...rest] = branches;
        const [result] = await mongoose.connection.collection(first.coll).aggregate([
            ...first.pipeline,
            ...rest.map(b => ({ $unionWith: { coll: b.coll, pipeline: b.pipeline } })),
            { $sort: { at: -1, _id: 1 } },
            { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } }
        ]).toArray();
        const pageRows = result?.rows || [];
        const total = result?.total?.[0]?.n || 0;

        // 4. Who Each Row Belongs To
        const ownerIds = [...new Set(pageRows.map(r => r.userId && String(r.userId)).filter(Boolean))];
        const owners = await User.find({ _id: { $in: ownerIds } }).select('email fullName').lean();
        const ownerMap = Object.fromEntries(owners.map(u => [String(u._id), u]));

        // 5. First Purchase Made With Each Successful Deposit (before the user's next deposit)
        const firstPurchases = await Promise.all(pageRows.map(async r => {
            if (r.category !== 'deposit' || r.status !== 'successful' || !r.userId) return undefined;
            const nextDeposit = await Transaction.findOne({
                userId: r.userId, purpose: 'deposit', status: 'successful', createdAt: { $gt: r.at }
            }).sort({ createdAt: 1 }).select('createdAt').lean();
            const order = await Order.findOne({
                userId: r.userId,
                createdAt: nextDeposit ? { $gte: r.at, $lt: nextDeposit.createdAt } : { $gte: r.at }
            }).sort({ createdAt: 1 }).select('productType nodeName planName metadata.serviceName amount status createdAt').lean();
            return order ? {
                kind: order.productType,
                label: order.metadata?.serviceName || order.nodeName || order.planName || null,
                amount: order.amount,
                status: order.status,
                boughtAt: order.createdAt
            } : null;
        }));

        const rows = pageRows.map((r, i) => {
            const owner = ownerMap[String(r.userId)];
            return {
                id: String(r._id),
                category: r.category,
                kind: r.kind || null,
                userId: r.userId ? String(r.userId) : null,
                user: { email: owner?.email || r.userEmail || null, name: owner?.fullName || null },
                at: r.at,
                status: r.status || null,
                amount: r.amount != null ? Math.round(Number(r.amount)) : null,
                label: r.label || null,
                ref: r.ref || null,
                method: r.method || null,
                adminEmail: r.adminEmail || null,
                country: r.country || null,
                number: r.number || null,
                reason: r.reason || null,
                message: r.message || null,
                ...(firstPurchases[i] !== undefined ? { firstPurchase: firstPurchases[i] } : {})
            };
        });

        return res.json({ success: true, rows, total, page, pages: Math.max(Math.ceil(total / limit), 1) });
    } catch (err) {
        console.error("User Activity Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// SMSBower wallet, loaded apart from sms-stats so a slow vendor never holds up the overview
async function handleGetSmsBowerBalance(req, res) {
    try {
        const vendorRes = await smsBowerClient.get('', { params: { action: 'getBalance' }, timeout: 8000 });
        const text = typeof vendorRes.data === 'string' ? vendorRes.data.trim() : '';
        const balanceUsd = text.startsWith('ACCESS_BALANCE:')
            ? parseFloat(text.split(':')[1]) || 0
            : (typeof vendorRes.data?.balance === 'number' ? vendorRes.data.balance : null);

        if (balanceUsd == null) {
            console.warn("SMSBower balance unreadable:", vendorRes.data);
            return res.status(502).json({ success: false, message: "SMSBower didn't return a balance." });
        }
        return res.json({ success: true, balanceUsd, balanceNGN: Math.round(balanceUsd * (await getUsdToNgnRate())) });
    } catch (err) {
        console.error("SMSBower Balance Error:", err.message);
        return res.status(502).json({ success: false, message: "Could not reach SMSBower." });
    }
}

// Sameeha (Accounts & VPN) wallet, already in NGN, loaded apart from sms-stats like SMSBower's
async function handleGetSameehaBalance(req, res) {
    if (!process.env.SAMEEHA_API_KEY && !isAccountsDemoMode()) {
        return res.status(502).json({ success: false, message: "SAMEEHA_API_KEY is not set on the server." });
    }
    try {
        const vendorRes = await sameehaRequest('get', '/balance', { timeout: 8000 });
        const balanceNGN = Number(vendorRes.data?.balance);
        if (vendorRes.status !== 200 || !Number.isFinite(balanceNGN)) {
            console.warn("Sameeha balance unreadable:", vendorRes.status, vendorRes.data);
            return res.status(502).json({ success: false, message: "Sameeha didn't return a balance." });
        }
        return res.json({ success: true, balanceNGN, currency: vendorRes.data.currency || 'NGN' });
    } catch (err) {
        console.error("Sameeha Balance Error:", err.message);
        return res.status(502).json({ success: false, message: "Could not reach Sameeha." });
    }
}

/**
 * 3. SMS ORDER STATUS SYNC
 * Asks SMSBower for the activation status and saves a code if one arrived.
 * Returns the raw vendor status text (e.g. "STATUS_OK:1234", "STATUS_WAIT_CODE", "STATUS_CANCEL").
 */
// --- ACCOUNTS & VPN (SAMEEHA) ---
// Vendor catalog cached per instance for 60 s. Prices are applied on every read,
// so an admin price change shows at once on the instance that saved it.
async function getAccountCatalog(forceFresh = false) {
    const now = Date.now();
    if (!forceFresh && cachedAccountCatalog && (now - lastAccountCatalogFetch < ACCOUNT_CATALOG_TTL)) {
        return cachedAccountCatalog;
    }

    const [categoriesRes, vendorProducts] = await Promise.all([
        sameehaRequest('get', '/categories'),
        fetchSameehaProducts()
    ]);
    if (categoriesRes.status !== 200) {
        throw new Error(`Sameeha /categories replied ${categoriesRes.status}: ${categoriesRes.data?.detail || categoriesRes.data?.message || ''}`);
    }

    cachedAccountCatalog = {
        categories: (categoriesRes.data.results || []).map(c => ({ id: Number(c.id), name: String(c.name || ''), slug: String(c.slug || '') })),
        vendorProducts
    };
    lastAccountCatalogFetch = now;
    return cachedAccountCatalog;
}

// Joins vendor products with the admin's prices and the global markup
async function priceAccountCatalog(vendorProducts, categories) {
    const [overrides, settings] = await Promise.all([
        AccountPrice.find().lean(),
        getSystemSettingsCached()
    ]);
    const overrideMap = new Map(overrides.map(o => [o.vendorProductId, o]));
    const categoryNames = new Map(categories.map(c => [c.id, c.name]));

    return vendorProducts
        .map(p => {
            const vendorPriceNGN = Number(p.price);
            const override = overrideMap.get(Number(p.id));
            const stock = Math.max(0, parseInt(p.stock, 10) || 0);
            return {
                id: Number(p.id),
                name: String(p.name || 'Account'),
                categoryId: Number(p.category_id),
                categoryName: categoryNames.get(Number(p.category_id)) || 'Other',
                description: String(p.description || '').trim().slice(0, 3000), // Login rules and replacement policy, shown on the card
                image: /^https:\/\//i.test(String(p.image || '')) ? String(p.image) : null,
                vendorPriceNGN,
                stock,
                inStock: p.in_stock !== false && stock > 0,
                hidden: Boolean(override?.hidden),
                fixedPriceNGN: override?.fixedPriceNGN ?? null, // The product's own price, if any
                ...priceAccountProduct(vendorPriceNGN, override, settings)
            };
        })
        .filter(p => Number.isInteger(p.id) && Number.isFinite(p.vendorPriceNGN) && p.vendorPriceNGN > 0);
}

// Public catalog for the user page (no vendor prices)
async function handleGetAccountProducts(req, res) {
    try {
        const catalog = await getAccountCatalog();
        const products = (await priceAccountCatalog(catalog.vendorProducts, catalog.categories))
            .filter(p => !p.hidden)
            .map(p => ({
                id: p.id,
                name: p.name,
                categoryId: p.categoryId,
                categoryName: p.categoryName,
                description: p.description,
                image: p.image,
                price: p.priceNGN,
                stock: p.stock,
                inStock: p.inStock
            }));

        // Only categories that still have something listed
        const categories = catalog.categories
            .map(c => ({ ...c, productCount: products.filter(p => p.categoryId === c.id).length }))
            .filter(c => c.productCount > 0);

        return res.json({ success: true, categories, products });
    } catch (err) {
        console.error("Account Products Error:", err.message);
        return res.status(502).json({ success: false, message: "Could not load products right now. Please try again shortly." });
    }
}

// Admin pricing view: vendor price, selling price and the supplier wallet balance
async function handleGetAdminAccountProducts(req, res) {
    try {
        const forceFresh = req.query.refresh === '1';
        const [catalog, balanceRes, settings] = await Promise.all([
            getAccountCatalog(forceFresh),
            sameehaRequest('get', '/balance').catch(err => ({ status: 0, data: { detail: err.message } })),
            getSystemSettingsCached()
        ]);
        const products = await priceAccountCatalog(catalog.vendorProducts, catalog.categories);

        return res.json({
            success: true,
            markupPercentage: settings.accountMarkupPercentage || 0,
            vendorBalanceNGN: balanceRes.status === 200 ? Number(balanceRes.data.balance) : null,
            demoMode: isAccountsDemoMode(),
            categories: catalog.categories,
            products
        });
    } catch (err) {
        console.error("Admin Account Products Error:", err.message);
        const noKey = !process.env.SAMEEHA_API_KEY && !isAccountsDemoMode();
        return res.status(502).json({
            success: false,
            message: noKey ? "SAMEEHA_API_KEY is not set on the server." : "Could not reach Sameeha. Try again shortly."
        });
    }
}

// Saves one product's fixed amount and/or hides it. An empty amount returns it to the global markup.
async function handleSaveAccountPrice(req, res) {
    const { productId, productName, fixedPriceNGN, hidden } = req.body;
    const vendorProductId = Number(productId);
    if (!Number.isInteger(vendorProductId) || vendorProductId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid product." });
    }

    const clearPrice = fixedPriceNGN === null || fixedPriceNGN === undefined || fixedPriceNGN === '';
    const fixedPrice = clearPrice ? null : Math.round(Number(fixedPriceNGN));
    if (!clearPrice && (!Number.isFinite(fixedPrice) || fixedPrice < 1 || fixedPrice > 10000000)) {
        return res.status(400).json({ success: false, message: "Enter an amount between ₦1 and ₦10,000,000, or leave it empty." });
    }
    if (hidden !== undefined && typeof hidden !== 'boolean') {
        return res.status(400).json({ success: false, message: "Invalid visibility value." });
    }

    try {
        const current = await AccountPrice.findOne({ vendorProductId }).lean();
        const isHidden = hidden ?? Boolean(current?.hidden);

        // Nothing custom left: drop the row so the product follows the global markup
        if (clearPrice && !isHidden) {
            await AccountPrice.deleteOne({ vendorProductId });
            return res.json({ success: true, message: "Product now uses the global markup." });
        }

        await AccountPrice.findOneAndUpdate(
            { vendorProductId },
            {
                $set: {
                    productName: cleanText(productName, 120) || current?.productName,
                    hidden: isHidden,
                    updatedBy: req.admin?.email,
                    ...(fixedPrice !== null ? { fixedPriceNGN: fixedPrice } : {})
                },
                ...(fixedPrice === null ? { $unset: { fixedPriceNGN: 1 } } : {})
            },
            { upsert: true, returnDocument: 'after', runValidators: true }
        );

        // Warn when the fixed price sits under the supplier's price (it is ignored at sale time)
        const vendorProduct = cachedAccountCatalog?.vendorProducts.find(p => Number(p.id) === vendorProductId);
        const belowCost = fixedPrice !== null && vendorProduct && fixedPrice < Number(vendorProduct.price);

        return res.json({
            success: true,
            message: belowCost
                ? `Saved, but ₦${fixedPrice.toLocaleString()} is below the supplier price of ₦${Number(vendorProduct.price).toLocaleString()}. The global markup is used until you raise it.`
                : "Price saved."
        });
    } catch (err) {
        console.error("Save Account Price Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function handleDeleteAccountPrice(req, res) {
    const vendorProductId = Number(req.body?.productId ?? req.query.productId);
    if (!Number.isInteger(vendorProductId) || vendorProductId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid product." });
    }

    try {
        await AccountPrice.deleteOne({ vendorProductId });
        return res.json({ success: true, message: "Product reset to the global markup." });
    } catch (err) {
        console.error("Delete Account Price Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

async function syncSmsOrderFromVendor(order) {
    const activeVendorId = order.vendorOrderId || order.metadata?.tzid;
    if (!activeVendorId) return null;

    // DEMO NUMBER: fake the vendor. The first code lands after SMS_DEMO_CODE_DELAY_MS
    // (so cancel can be tested first); "request another code" waits the same delay again.
    if (isSmsDemoVendorId(activeVendorId)) {
        const isNextCode = order.status === 'completed' && order.metadata?.awaitingNextCode === true;
        const waitingSince = isNextCode
            ? new Date(order.metadata?.nextCodeRequestedAt || order.createdAt).getTime()
            : new Date(order.createdAt).getTime();
        if (Date.now() - waitingSince < SMS_DEMO_CODE_DELAY_MS) return 'STATUS_WAIT_CODE';

        const code = makeSmsDemoCode();
        const fullMessage = `Verification Code: ${code}`;
        const updated = isNextCode
            ? await Order.findOneAndUpdate(
                { _id: order._id, status: 'completed', 'metadata.awaitingNextCode': true },
                {
                    $set: { smsCode: code, fullMessage, 'metadata.awaitingNextCode': false },
                    $push: { 'metadata.previousCodes': order.smsCode }
                },
                { returnDocument: 'after' }
            )
            : await Order.findOneAndUpdate(
                { _id: order._id, status: 'pending' },
                { $set: { smsCode: code, fullMessage, status: 'completed' } },
                { returnDocument: 'after' }
            );
        if (updated) {
            order.smsCode = updated.smsCode;
            order.fullMessage = updated.fullMessage;
            order.status = updated.status;
            order.metadata = updated.metadata;
        }
        await SmsNumber.findOneAndUpdate(
            { vendorOrderId: String(activeVendorId) },
            { smsCode: code, fullMessage, status: 'completed' }
        );
        return `STATUS_OK:${code}`;
    }

    const response = await smsBowerClient.get('', {
        params: { action: 'getStatus', id: activeVendorId }
    });
    const respText = typeof response.data === 'string' ? response.data.trim() : '';

    if (respText.startsWith('STATUS_OK')) {
        const code = respText.split(':')[1];
        const fullMessage = `Verification Code: ${code}`;

        // After "Request another code" the order is already completed: a new code replaces the old one
        const isNextCode = order.status === 'completed' && order.metadata?.awaitingNextCode === true && code !== order.smsCode;

        // Otherwise only a still-pending order can complete (never one that was cancelled and refunded)
        const updated = isNextCode
            ? await Order.findOneAndUpdate(
                { _id: order._id, status: 'completed', 'metadata.awaitingNextCode': true },
                {
                    $set: { smsCode: code, fullMessage, 'metadata.awaitingNextCode': false },
                    $push: { 'metadata.previousCodes': order.smsCode }
                },
                { returnDocument: 'after' }
            )
            : await Order.findOneAndUpdate(
                { _id: order._id, status: 'pending' },
                { $set: { smsCode: code, fullMessage, status: 'completed' } },
                { returnDocument: 'after' }
            );
        if (updated) {
            order.smsCode = updated.smsCode;
            order.fullMessage = updated.fullMessage;
            order.status = updated.status;
            order.metadata = updated.metadata;
        }

        await SmsNumber.findOneAndUpdate(
            { vendorOrderId: String(activeVendorId) },
            { smsCode: code, fullMessage, status: 'completed' }
        );
    }

    return respText;
}

// Builds the { _id | vendorOrderId | tzid } AND { owner } filter used by user-facing lookups
function buildOwnedOrderFilter(id, user) {
    const idText = String(id);
    const idMatches = [{ vendorOrderId: idText }, { 'metadata.tzid': idText }];
    if (mongoose.isValidObjectId(idText)) idMatches.unshift({ _id: idText });

    return {
        $and: [
            { $or: idMatches },
            { $or: [{ userId: user._id }, { userEmail: user.email }] }
        ]
    };
}

/**
 * 4. MANUAL RE-REQUEST / RE-POLL SMS STATUS
 */
async function handleRecheckSms(req, res) {
    const { id } = req.body; // Order ID or Vendor Order ID (tzid)

    if (!id || (typeof id !== 'string' && typeof id !== 'number')) {
        return res.status(400).json({ success: false, message: "Missing order identifier." });
    }

    try {
        const user = await requireUser(req, res);
        if (!user) return;

        const order = await Order.findOne(buildOwnedOrderFilter(id, user));
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found." });
        }

        if (!(order.vendorOrderId || order.metadata?.tzid)) {
            return res.status(400).json({ success: false, message: "No active vendor activation ID found for this order." });
        }

        const hasFinalCode = () => order.smsCode && order.metadata?.awaitingNextCode !== true;

        if (hasFinalCode()) {
            return res.json({ success: true, message: "OTP Code retrieved successfully!", code: order.smsCode, order: toUserOrder(order) });
        }

        const respText = await syncSmsOrderFromVendor(order);

        if (hasFinalCode()) {
            return res.json({
                success: true,
                message: "OTP Code retrieved successfully!",
                code: order.smsCode,
                order: toUserOrder(order)
            });
        }

        return res.json({
            success: true,
            message: "Status checked. Still waiting for SMS code from provider.",
            statusResponse: respText,
            order: toUserOrder(order)
        });

    } catch (err) {
        console.error("Manual Recheck SMS Error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to recheck SMS status from provider." });
    }
}

async function handleCancelOrder(req, res) {
    try {
        const user = await requireUser(req, res);
        if (!user) return;

        const { id } = req.body;
        if (!id || (typeof id !== 'string' && typeof id !== 'number')) {
            return res.status(400).json({ success: false, message: "Missing order identifier." });
        }

        // Find the matching order (owned by this user only)
        const order = await Order.findOne(buildOwnedOrderFilter(id, user));
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found or unauthorized." });
        }

        // Delegate to the atomic cancellation helper
        const result = await autoCancelAndRefundOrder(order._id, 'User cancelled number activation');

        if (!result.success) {
            return res.status(400).json({ success: false, message: result.reason });
        }

        return res.json({
            success: true,
            message: `Number cancelled successfully. ₦${result.refundAmount.toLocaleString()} has been refunded to your wallet.`
        });

    } catch (err) {
        console.error("Cancel Order Error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to process cancellation and refund." });
    }
}

/**
 * 5. REQUEST ANOTHER CODE ON THE SAME NUMBER
 * Free at SMSBower (setStatus 3). The order stays completed (no refund once a code has
 * arrived); `metadata.awaitingNextCode` tells polling and the webhook to accept a new code.
 */
async function handleRequestAnotherCode(req, res) {
    const { id } = req.body;
    if (!id || (typeof id !== 'string' && typeof id !== 'number')) {
        return res.status(400).json({ success: false, message: "Missing order identifier." });
    }

    try {
        const user = await requireUser(req, res);
        if (!user) return;

        const order = await Order.findOne(buildOwnedOrderFilter(id, user));
        if (!order || order.productType !== 'SmsNumber') {
            return res.status(404).json({ success: false, message: "Order not found." });
        }

        // 1. Only A Number That Already Received A Code, Still Inside SMSBower's Window
        const activeVendorId = order.vendorOrderId || order.metadata?.tzid;
        if (order.status !== 'completed' || !order.smsCode || !activeVendorId) {
            return res.status(400).json({ success: false, message: "You can request another code once the first one arrives." });
        }
        if (order.metadata?.awaitingNextCode === true) {
            return res.json({ success: true, message: "Already waiting for another code.", order: toUserOrder(order) });
        }
        if (order.metadata?.canGetAnotherSms === false) {
            return res.status(400).json({ success: false, message: "This number can't receive another code. Please buy a new number." });
        }
        if (Date.now() - new Date(order.createdAt).getTime() > SMS_ACTIVATION_WINDOW_MS) {
            return res.status(400).json({ success: false, message: "This number has expired. Please buy a new number." });
        }

        // 2. Ask SMSBower To Keep The Number Open For Another SMS (demo numbers skip the vendor)
        if (isSmsDemoVendorId(activeVendorId)) {
            const updated = await Order.findOneAndUpdate(
                { _id: order._id, status: 'completed' },
                { $set: { 'metadata.awaitingNextCode': true, 'metadata.nextCodeRequestedAt': new Date() } },
                { returnDocument: 'after' }
            );
            return res.json({
                success: true,
                message: "Ready for another code. A new demo code will arrive in about 25 seconds.",
                order: toUserOrder(updated || order)
            });
        }
        let vendorText = '';
        try {
            const vendorRes = await smsBowerClient.get('', { params: { action: 'setStatus', status: 3, id: activeVendorId } });
            vendorText = typeof vendorRes.data === 'string' ? vendorRes.data.trim() : JSON.stringify(vendorRes.data);
        } catch (apiErr) {
            console.warn(`SMS request-another failed for ${activeVendorId}:`, apiErr.message);
            return res.status(502).json({ success: false, message: "Could not reach the SMS provider. Please try again shortly." });
        }

        if (vendorText !== 'ACCESS_RETRY_GET') {
            console.warn(`SMS Provider refused another code for ${activeVendorId}: ${vendorText}`);
            return res.status(502).json({ success: false, message: "The provider couldn't open this number for another code. Please buy a new number." });
        }

        // 3. Mark The Order As Waiting So Polling Picks Up The New Code
        const updated = await Order.findOneAndUpdate(
            { _id: order._id, status: 'completed' },
            { $set: { 'metadata.awaitingNextCode': true, 'metadata.nextCodeRequestedAt': new Date() } },
            { returnDocument: 'after' }
        );

        return res.json({
            success: true,
            message: "Ready for another code. Tap 'Resend code' in the app; the new code will show here.",
            order: toUserOrder(updated || order)
        });
    } catch (err) {
        console.error("Request Another Code Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

// Splits a refund back across the wallets the order was paid from.
// Orders saved before the split was recorded have both fields at 0, so they refund to main.
function computeRefundSplit(order) {
    const amount = Math.max(Number(order.amount) || 0, 0);
    let mainRefund = Math.max(Number(order.mainBalanceUsed) || 0, 0);
    let bonusRefund = Math.max(Number(order.bonusBalanceUsed) || 0, 0);

    if (mainRefund + bonusRefund <= 0) mainRefund = amount;
    return { mainRefund, bonusRefund };
}

/**
 * Refunds an order to the wallet exactly once.
 * Claims the order (sets refundedAt) in the same transaction as the credit and the log,
 * so a double click, the cron and a user cancel can never all pay out.
 */
async function refundOrderToWallet(orderId, reason, newStatus = 'failed', extraFilter = {}, extraSet = {}) {
    // ⚠️ CRITICAL: an undefined _id is dropped from the filter and would match any order
    if (!orderId || !mongoose.isValidObjectId(orderId)) {
        return { success: false, reason: 'Order not eligible for refund' };
    }

    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        // 1. Claim The Order
        const order = await Order.findOneAndUpdate(
            { _id: orderId, refundedAt: { $exists: false }, ...extraFilter },
            { $set: { status: newStatus, refundedAt: new Date(), adminNote: `Refunded: ${reason}`, ...extraSet } },
            { returnDocument: 'after', session }
        );
        if (!order) {
            await session.abortTransaction();
            return { success: false, reason: 'Order not eligible for refund' };
        }

        // 2. Credit The Same Wallets The Order Was Paid From
        const { mainRefund, bonusRefund } = computeRefundSplit(order);
        const user = await User.findOneAndUpdate(
            order.userId ? { _id: order.userId } : { email: order.userEmail },
            { $inc: { balance: mainRefund, bonusBalance: bonusRefund } },
            { returnDocument: 'after', session }
        );
        if (!user) throw new Error('User account not found');

        const activeVendorId = order.vendorOrderId || order.metadata?.tzid;
        if (activeVendorId) {
            await SmsNumber.findOneAndUpdate(
                { vendorOrderId: String(activeVendorId) },
                { status: 'expired' },
                { session }
            );
        }

        // 3. Audit Transaction Record (reference is unique per order)
        await new Transaction({
            userId: user._id,
            type: 'credit',
            purpose: 'refund',
            amountNGN: mainRefund + bonusRefund,
            status: 'successful',
            reference: `REFUND-${order._id}`,
            paymentMethod: 'wallet_refund',
            balanceBefore: user.balance - mainRefund,
            balanceAfter: user.balance,
            bonusBefore: user.bonusBalance - bonusRefund,
            bonusAfter: user.bonusBalance,
            metadata: { orderId: order._id, vendorOrderId: activeVendorId || null, reason }
        }).save({ session });

        await session.commitTransaction();
        console.log(`✅ Refunded ₦${mainRefund + bonusRefund} (main ₦${mainRefund}, bonus ₦${bonusRefund}) to ${user.email} for order ${order._id}`);
        return { success: true, refundAmount: mainRefund + bonusRefund, order };
    } catch (error) {
        await session.abortTransaction().catch(() => {});
        console.error(`Failed refund for order ${orderId}:`, error.message);
        throw error;
    } finally {
        session.endSession();
    }
}

// Vendor replies that mean the activation is closed and SMSBower won't charge us for it
const SMS_CANCEL_CONFIRMED = ['ACCESS_CANCEL', 'ACCESS_CANCEL_ALREADY', 'NO_ACTIVATION', 'STATUS_CANCEL'];

async function autoCancelAndRefundOrder(orderId, reason = 'auto_expired_no_sms') {
    const order = await Order.findById(orderId);
    if (!order || order.status !== 'pending' || order.smsCode || order.refundedAt) {
        return { success: false, reason: 'Order not eligible for refund' };
    }

    const activeVendorId = order.vendorOrderId || order.metadata?.tzid;

    // DEMO NUMBER: no vendor to ask, and no 2-minute cancel wait, so refund straight away
    if (isSmsDemoVendorId(activeVendorId)) {
        const orderAgeMs = order.createdAt ? Date.now() - new Date(order.createdAt).getTime() : 0;
        if (orderAgeMs < SMS_ORDER_TTL_MS) {
            try {
                await syncSmsOrderFromVendor(order);
            } catch (demoErr) {
                console.warn(`SMS demo status check failed for ${activeVendorId}:`, demoErr.message);
            }
        }
        if (order.smsCode) {
            return { success: false, reason: 'An SMS code has already arrived for this number, so it can no longer be cancelled.' };
        }
        return refundOrderToWallet(order._id, reason, 'cancelled', { status: 'pending', smsCode: { $in: [null, ''] } });
    }

    if (activeVendorId) {
        // 1. Last Check: A Code May Have Arrived Since The Page Last Polled
        let statusText;
        try {
            statusText = await syncSmsOrderFromVendor(order);
        } catch (apiErr) {
            console.warn(`SMS status check failed for ${activeVendorId}:`, apiErr.message);
            return { success: false, reason: 'Could not reach the SMS provider. Please try again shortly.' };
        }

        if (order.smsCode) {
            return { success: false, reason: 'An SMS code has already arrived for this number, so it can no longer be cancelled.' };
        }

        // 2. Ask The Provider To Cancel (Status 8) And Only Refund Once It Confirms
        if (!SMS_CANCEL_CONFIRMED.includes(statusText)) {
            let cancelText = '';
            try {
                const cancelRes = await smsBowerClient.get('', {
                    params: { action: 'setStatus', status: 8, id: activeVendorId }
                });
                cancelText = typeof cancelRes.data === 'string' ? cancelRes.data.trim() : JSON.stringify(cancelRes.data);
            } catch (apiErr) {
                console.warn(`SMS Provider cancellation failed for ${activeVendorId}:`, apiErr.message);
                return { success: false, reason: 'Could not reach the SMS provider. Please try again shortly.' };
            }

            // EARLY CANCEL: SMSBower refuses cancels in the first 2 minutes. No code has arrived and a
            // cancelled order never shows one, so refund now and cancel at SMSBower later (retryVendorCancels)
            if (cancelText === 'EARLY_CANCEL_DENIED') {
                return refundOrderToWallet(order._id, reason, 'cancelled',
                    { status: 'pending', smsCode: { $in: [null, ''] } },
                    { 'metadata.vendorCancelPending': true });
            }

            if (!SMS_CANCEL_CONFIRMED.includes(cancelText)) {
                console.warn(`SMS Provider refused cancellation for ${activeVendorId}: ${cancelText}`);
                return { success: false, reason: 'The SMS provider has not released this number yet. Please try again in a minute.' };
            }
        }
    }

    // 3. Refund Exactly Once (only while the order is still pending)
    return refundOrderToWallet(order._id, reason, 'cancelled', { status: 'pending', smsCode: { $in: [null, ''] } });
}

// --- SCHEDULED EXPIRY ENDPOINT ---
// Called daily by Vercel Cron (vercel.json), which sends "Authorization: Bearer <CRON_SECRET>".
// Lazy expiry in user-profile / user-orders covers the time between runs.
async function handleExpireSmsOrders(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    const token = getBearerToken(req) || '';
    const isCron = Boolean(cronSecret) && token.length === cronSecret.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret));

    if (!isCron && !(await getOptionalAdmin(req))) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    try {
        const result = await expireStaleSmsOrders({}, 100);
        return res.json({ success: true, message: `Checked ${result.checked}, refunded ${result.refunded}.`, ...result });
    } catch (err) {
        console.error("Expire SMS Orders Error:", err);
        return res.status(500).json({ success: false, message: "Expiry run failed." });
    }
}

async function handleGetUserOrders(req, res) {
    try {
        const user = await requireUser(req, res);
        if (!user) return;

        // Refund this user's expired SMS numbers before listing them
        await expireStaleSmsOrders({ userId: user._id }, 5).catch(err => console.error("Lazy SMS Expiry Error:", err.message));

        const limit = Math.min(parseInt(req.query.limit) || 200, 500);

        // Older orders were linked by email only, so match either
        const orders = await Order.find({ $or: [{ userId: user._id }, { userEmail: user.email }] })
            .sort({ createdAt: -1 }) // Newest first
            .limit(limit)
            .lean(); // Faster performance for read-only

        return res.json(orders.map(toUserOrder));

    } catch (err) {
        console.error("Error fetching user orders:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve order history"
        });
    }
}

async function handleGetOrderDetails(req, res) {
    try {
        const user = await requireUser(req, res);
        if (!user) return;

        const orderId = req.query.id;
        if (!orderId || typeof orderId !== 'string') {
            return res.status(400).json({ success: false, message: "Order ID required" });
        }

        // 1. Find the order by _id, vendorOrderId or tzid, owned by this user only
        const order = await Order.findOne(buildOwnedOrderFilter(orderId, user));
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // 2. If still pending, query SMSBower live, and refund if the number has expired
        const activeVendorId = order.vendorOrderId || order.metadata?.tzid;
        const isWaitingForFirstCode = order.status === 'pending' && !order.smsCode;
        const isWaitingForNextCode = order.status === 'completed' && order.metadata?.awaitingNextCode === true;

        if (activeVendorId && (isWaitingForFirstCode || isWaitingForNextCode)) {
            try {
                const statusText = await syncSmsOrderFromVendor(order);
                const orderAgeMs = order.createdAt ? Date.now() - new Date(order.createdAt).getTime() : 0;

                if (isWaitingForFirstCode && !order.smsCode && (statusText === 'STATUS_CANCEL' || orderAgeMs > SMS_ORDER_TTL_MS)) {
                    const refund = await autoCancelAndRefundOrder(order._id, statusText === 'STATUS_CANCEL'
                        ? 'Cancelled by provider without SMS'
                        : 'Time limit exceeded (20 min) without SMS');
                    if (refund.success) order.status = 'cancelled';
                }

                // 3. Stop Waiting For Another Code Once SMSBower Has Closed The Number
                if (order.metadata?.awaitingNextCode === true && (statusText === 'STATUS_CANCEL' || orderAgeMs > SMS_ACTIVATION_WINDOW_MS)) {
                    const closed = await Order.findOneAndUpdate(
                        { _id: order._id, 'metadata.awaitingNextCode': true },
                        { $set: { 'metadata.awaitingNextCode': false } },
                        { returnDocument: 'after' }
                    );
                    if (closed) order.metadata = closed.metadata;
                }
            } catch (providerErr) {
                console.error("SMSBower live polling error:", providerErr.message);
            }
        }

        return res.status(200).json({ success: true, order: toUserOrder(order) });
    } catch (err) {
        console.error("Order Details Error:", err);
        return res.status(500).json({ success: false, message: "Failed to read order update." });
    }
}

/**
 * 6. SMSBOWER WEBHOOK HANDLER
 * The webhook body is never trusted on its own: the code is re-read from SMSBower's API
 * before it's saved. SMSBOWER_WEBHOOK_SECRET is required: without it the webhook is off and
 * codes still arrive through polling. The caller sends it as an x-webhook-secret header, or as
 * ?secret=<value> on the callback URL when the provider can only be given a URL.
 */
async function handleSmsBowerWebhook(req, res) {
    try {
        const webhookSecret = process.env.SMSBOWER_WEBHOOK_SECRET || '';
        const received = Buffer.from(String(req.headers['x-webhook-secret'] || req.query.secret || ''));
        const expected = Buffer.from(webhookSecret);
        const isAuthorized = webhookSecret.length >= 16 && received.length === expected.length &&
            crypto.timingSafeEqual(received, expected);
        if (!isAuthorized) {
            if (!webhookSecret) console.warn("⚠️ SMS webhook called but SMSBOWER_WEBHOOK_SECRET is not set (at least 16 characters), so it was refused.");
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { activationId } = req.body || {};
        if (!activationId || (typeof activationId !== 'string' && typeof activationId !== 'number')) {
            return res.status(200).json({ success: false, message: 'Missing activationId' });
        }

        // 1. Find the order still waiting for a code (first code, or another one the user asked for)
        const order = await Order.findOne({
            vendorOrderId: String(activationId),
            $or: [{ status: 'pending' }, { status: 'completed', 'metadata.awaitingNextCode': true }]
        });

        if (!order) {
            return res.status(200).json({ success: true, message: 'Order not found or already processed' });
        }

        // 2. Confirm With SMSBower Before Saving Anything
        const statusText = await syncSmsOrderFromVendor(order);
        if (!order.smsCode || order.metadata?.awaitingNextCode === true) {
            console.warn(`⚠️ Webhook for ${activationId} not confirmed by SMSBower (${statusText})`);
            return res.status(200).json({ success: false, message: 'Code not confirmed by provider' });
        }

        console.log(`✅ Code confirmed with SMSBower and saved to Order ${order._id}`);
        return res.status(200).json({ success: true });

    } catch (err) {
        console.error("SMS Webhook Error:", err.message);
        return res.status(200).json({ success: false, message: 'Webhook processing failed' });
    }
}

async function handleChangePassword(req, res) {
    try {
        const { oldPass, newPass } = req.body;

        if (typeof oldPass !== 'string' || typeof newPass !== 'string' || newPass.length < 6) {
            return res.status(400).json({ success: false, message: "Enter your current password and a new password of at least 6 characters." });
        }

        // 1. Find User in DB (password is select: false, so ask for it explicitly)
        const user = await requireUser(req, res, '+password');
        if (!user) return;

        // 2. Google Signups Have No Password They Know Yet
        if (user.hasPassword === false) {
            return res.status(400).json({
                success: false,
                noPassword: true,
                message: "You signed up with Google, so your account has no password yet. Use Forgot Password on the login page to set one."
            });
        }

        // 3. Verify Old Password
        const isMatch = await bcrypt.compare(oldPass, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Current password is incorrect" });
        }

        // 4. Hash New Password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPass, salt);

        // 5. Update Database
        user.password = hashedPassword;
        await user.save();

        return res.json({ 
            success: true, 
            message: "Password updated successfully!" 
        });

    } catch (err) {
        console.error("Password Update Error:", err);
        return res.status(500).json({ 
            success: false, 
            message: "Internal server error" 
        });
    }
}

async function handleResetPassword(req, res) {
    try {
        const { token, newPass } = req.body;

        // Strings only: an object here would become a query operator
        if (typeof token !== 'string' || typeof newPass !== 'string' || !token || !newPass) {
            return res.status(400).json({
                success: false,
                message: "Missing token or password"
            });
        }
        if (newPass.length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
        }

        // 1. Find user by reset token and ensure it hasn't expired
        const user = await User.findOne({
            resetPasswordToken: hashResetToken(token),
            resetPasswordExpires: { $gt: Date.now() } // Check if token is still valid
        });

        if (!user) {
            return res.status(400).json({ 
                success: false, 
                message: "Invalid or expired reset token" 
            });
        }

        // 2. Hash the New Password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPass, salt);

        // 3. Update User and Clear the Reset Token fields
        user.password = hashedPassword;
        user.hasPassword = true; // A Google signup now has a password it can change
        user.resetPasswordToken = undefined; // Clear token after use
        user.resetPasswordExpires = undefined; // Clear expiry after use

        // The link only reaches the inbox owner, so a reset also verifies a pending signup
        // (same result as verify-otp; otherwise the dashboard sends them back to /register)
        if (user.isVerified !== true) {
            user.isVerified = true;
            user.otpAttempts = 0;
            user.otpCode = undefined;
            user.otpExpires = undefined;
            if (user.referredBy && !user.referralStatus) user.referralStatus = 'pending';
        }
        await user.save();

        // 4. Generate a fresh Session Token (JWT)
        // This ensures the user is logged in immediately after the reset
        return res.json({
            success: true,
            message: "Password reset successful!",
            ...buildUserSession(user) // Frontend will save the token to localStorage
        });

    } catch (err) {
        console.error("Reset Password Error:", err);
        return res.status(500).json({ 
            success: false, 
            message: "Internal server error" 
        });
    }
}

async function handleForgotPasswordRequest(req, res) {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string') return res.status(400).json({ success: false, message: "Email required" });

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            return res.json({ success: true, message: "If an account exists, a reset link has been sent." });
        }
        const token = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = hashResetToken(token); // The raw token only goes in the email
        user.resetPasswordExpires = Date.now() + 3600000;
        await user.save();
        const resetLink = `${APP_BASE_URL}/reset-password?token=${token}`;
        await sendResetPasswordEmail(user.email, resetLink);
        console.log(`📧 Password reset email sent to ${user.email}`); // Never log the link itself
        return res.json({
            success: true,
            message: "If an account exists, a reset link has been sent."
        });

    } catch (err) {
        console.error("Forgot Password Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
}

async function handleAdminChangePassword(req, res) {
    try {
        const { oldPassword, newPassword } = req.body;

        if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ success: false, message: "Enter your current password and a new password of at least 8 characters." });
        }

        const admin = await requireAdmin(req, res);
        if (!admin) return;

        const isMatch = await bcrypt.compare(oldPassword, admin.password);
        if (!isMatch) {
            // 400, not 401: the settings page logs out on 401
            return res.status(400).json({ success: false, message: "Current password is incorrect" });
        }

        const salt = await bcrypt.genSalt(10);
        admin.password = await bcrypt.hash(newPassword, salt);
        await admin.save();

        return res.json({ success: true, message: "Admin password updated successfully!" });

    } catch (error) {
        console.error("Admin Password Error:", error);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
}

async function handleAdminForgotPasswordRequest(req, res) {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string') return res.status(400).json({ success: false, message: "Email required" });

        // Search the Admin collection specifically
        const admin = await Admin.findOne({ email: { $in: [email.trim(), email.toLowerCase().trim()] } });

        // Security: Same response whether admin exists or not
        if (!admin) {
            return res.json({ 
                success: true, 
                message: "If an account exists, a reset link has been sent." 
            });
        }

        // 1. Generate a secure token
        const token = crypto.randomBytes(32).toString('hex');

        // 2. Set token and expiry on the ADMIN record (1 hour)
        admin.resetPasswordToken = hashResetToken(token); // The raw token only goes in the email
        admin.resetPasswordExpires = Date.now() + 3600000; 
        await admin.save();

        // 3. Admin-specific reset link
        const resetLink = `${APP_BASE_URL}/admin/reset-password?token=${token}`;

        await sendResetPasswordEmail(admin.email, resetLink, true);
        console.log(`📧 Admin password reset email sent to ${admin.email}`); // Never log the link itself

        return res.json({
            success: true,
            message: "If an account exists, a reset link has been sent."
        });

    } catch (err) {
        console.error("Admin Forgot Password Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
}

async function handleAdminResetPassword(req, res) {
    try {
        const { token, newPassword } = req.body;

        // Strings only: an object here would become a query operator
        if (typeof token !== 'string' || typeof newPassword !== 'string' || !token || !newPassword) {
            return res.status(400).json({ success: false, message: "Invalid request" });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
        }

        // Find admin with valid token AND ensure it hasn't expired
        const admin = await Admin.findOne({
            resetPasswordToken: hashResetToken(token),
            resetPasswordExpires: { $gt: Date.now() } // $gt means "greater than"
        });

        if (!admin) {
            return res.status(400).json({ 
                success: false, 
                message: "Password reset link is invalid or has expired." 
            });
        }

        // Hash the new password
        const salt = await bcrypt.genSalt(10);
        admin.password = await bcrypt.hash(newPassword, salt);

        // Clear the reset fields so the token can't be used again
        admin.resetPasswordToken = undefined;
        admin.resetPasswordExpires = undefined;
        
        await admin.save();

        return res.json({ success: true, message: "Admin password reset successfully!" });

    } catch (error) {
        console.error("Admin Reset Final Error:", error);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
}

// Shared Helper Function for Backend Routes (e.g., handleGetCountries)
async function getSystemSettingsCached() {
    const now = Date.now();
    if (cachedSettings && (now - lastFetchTime < CACHE_TTL)) {
        return cachedSettings;
    }

    try {
        await connectDB();
        const settings = await SystemSettings.findOne().maxTimeMS(2000).lean().exec();
        
        if (settings) {
            cachedSettings = settings;
            lastFetchTime = now;
        }
    } catch (err) {
        console.warn("SystemSettings cache lookup failed, falling back to existing cache or defaults:", err.message);
    }

    return cachedSettings || {};
}


// 1. GET settings (For Admin Page)
async function handleGetSystemSettings(req, res) {
    res.setHeader('Content-Type', 'application/json');

    try {
        await connectDB();

        let settings = await SystemSettings.findOne().maxTimeMS(3000).lean().exec();

        if (!settings) {
            // Create default document if the collection is empty
            const created = await SystemSettings.create({});
            settings = created.toObject();
        }

        // Update in-memory cache
        cachedSettings = settings;
        lastFetchTime = Date.now();

        return res.status(200).json({ success: true, settings });
    } catch (err) {
        console.error("Get System Settings Error:", err);
        return res.status(500).json({ success: false, message: "Could not load settings." });
    }
}


// 2. UPDATE settings (From Admin Page)
async function handleUpdateSystemSettings(req, res) {
    res.setHeader('Content-Type', 'application/json');

    try {
        // Only known settings fields can be written
        const SETTINGS_FIELDS = ['maintenanceMode', 'allowSignups', 'globalMarkup', 'smsMarkupPercentage', 'smsFloorPriceNGN', 'accountMarkupPercentage', 'usdToNgnRate', 'noticeBarText', 'supportWhatsapp',
            'referralBonusNGN', 'referralMilestone', 'referralMinDepositNGN'];
        const updateData = {};
        SETTINGS_FIELDS.forEach(field => {
            if (req.body[field] !== undefined) updateData[field] = req.body[field];
        });

        const updated = await SystemSettings.findOneAndUpdate(
            {},
            { $set: updateData },
            { upsert: true, returnDocument: 'after', runValidators: true }
        ).lean().exec();

        // ⚠️ CRITICAL: Immediately invalidate/update in-memory cache
        cachedSettings = updated;
        lastFetchTime = Date.now();

        return res.status(200).json({ 
            success: true, 
            message: "System configuration updated.", 
            settings: updated 
        });
    } catch (err) {
        console.error("Settings Update Error:", err);
        return res.status(500).json({ success: false, message: "Server error updating settings." });
    }
}


// 3. PUBLIC status check (For User Frontend / Login Page)
async function handleGetSystemStatus(req, res) {
    res.setHeader('Content-Type', 'application/json');

    try {
        // Fast path: pull from memory cache first if fresh
        const settings = await getSystemSettingsCached();

        return res.status(200).json({ 
            success: true, 
            maintenanceMode: Boolean(settings?.maintenanceMode),
            noticeBar: settings?.noticeBarText || "",
            topupFeeNGN: Math.max(Number(settings?.globalMarkup || 0), 0) // Flat fee added on top of every wallet top-up
        });
    } catch (err) {
        console.error("System Status Error:", err.message);
        // Responds safely so client logic never crashes
        return res.status(200).json({ 
            success: true, 
            maintenanceMode: false, 
            noticeBar: "" 
        }); 
    }
}

async function handleGetUserTransactions(req, res) {
    try {
        const user = await requireUser(req, res);
        if (!user) return;

        const { type } = req.query;
        let query = { userId: user._id };

        if (type === 'topup') {
            query.purpose = 'deposit';
        } else if (type === 'activity') {
            // Dashboard Activity: money in (top-ups) and money out (purchases) only
            query.purpose = { $in: ['deposit', 'purchase'] };
            query.status = 'successful';
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 50);

        const transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        // Look Up The Orders Behind Purchases (for a readable title and the product icon)
        const orderIds = transactions.map(tx => tx.metadata?.orderId).filter(id => mongoose.isValidObjectId(id));
        const orders = orderIds.length
            ? await Order.find({ _id: { $in: orderIds }, userId: user._id }).select('productType serviceName planName nodeName metadata.serviceName metadata.countryName metadata.categoryName').lean()
            : [];
        const ordersById = new Map(orders.map(o => [String(o._id), o]));

        return res.json({
            success: true,
            transactions: transactions.map(tx => {
                // Determine the source label
                let sourceLabel = 'Main Wallet';
                
                // If it's a purchase and usedBonus is true in metadata
                if (tx.purpose !== 'deposit' && tx.metadata?.usedBonus === true) {
                    sourceLabel = 'Referral Bonus';
                } else if (tx.purpose === 'deposit') {
                    sourceLabel = tx.metadata?.payment_type || 'External Topup';
                }

                const order = ordersById.get(String(tx.metadata?.orderId));

                // Product Label: "USA WhatsApp" for numbers, the product name for everything else
                const productTitle = order?.productType === 'SmsNumber'
                    ? [order.metadata?.countryName, order.metadata?.serviceName || order.serviceName].filter(Boolean).join(' ') || order.planName
                    : tx.metadata?.product || order?.nodeName || order?.serviceName || order?.planName;

                return {
                    id: tx._id,
                    amountNGN: tx.amountNGN,
                    status: tx.status,
                    reference: tx.reference,
                    purpose: tx.purpose,
                    type: tx.type, // 'credit' or 'debit'
                    productType: order?.productType || null,
                    title: productTitle || null,
                    category: order?.metadata?.categoryName || null, // Sameeha category, e.g. 'Facebook' or 'VPN'
                    createdAt: tx.createdAt,
                    // Use the new sourceLabel here
                    paymentMethod: sourceLabel 
                };
            })
        });
    } catch (error) {
        console.error("CRITICAL_TRANSACTION_ERROR:", error.message);
        return res.status(500).json({ 
            success: false, 
            message: "Internal Server Error",
        });
    }
}

// --- 8. STARTUP ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Dev Server: http://localhost:${PORT}`));
}

module.exports = app;


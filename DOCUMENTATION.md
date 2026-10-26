Technical Documentation: Deemax Platform
1. Project Overview
System Name: Deemax Administrative & User Dashboard

Lead Developer: Arogundade Oladipupo

Core Stack: HTML5, Tailwind CSS, JavaScript (Node.js)

Hosting Provider: Vercel (Production Environment)

2. Directory Architecture
The project is structured to separate administrative logic from the client-side experience while maintaining a unified API layer.

Core Files (Root)
index.html: The main landing page and entry point for deemaxhub.com.

style.css: Global stylesheet containing custom Tailwind utilities and UI branding.

api.js: Centralized backend logic handling database interactions, payment verification, and server provisioning.

vercel.json: Routing configuration for clean URLs and serverless function mapping.

Subdirectories
/smsadmin: Contains the administrative suite, including dashboard.html, esim-activations.html, and transactions.html.

/smsuser: Contains the client dashboard, including dashboard.html, fund-wallet.html, and profile.html.

/assets: Storage for images, icons, and branding materials used across the platform.

3. Implementation Details
Routing & Clean URLs
The platform utilizes Vercel's rewrite engine to provide a professional user experience.

Requests to /smsuser/dashboard are internally mapped to /smsuser/dashboard.html.

Requests to /api/* are directed to the api.js serverless function.

Security & Compliance
Access Control: Administrative access is restricted via the smsglobe_admin_token logic within the api.js handler.

SEO Management: Search engine visibility is managed through robots.txt and sitemap.xml located in the root directory.

FDIC Disclosure: Financial-related interfaces include standard FDIC-insured backing notices for user trust.

4. Maintenance Logs
Last Update: April 16, 2026

Key Update: Implementation of 4-digit PIN verification for enhanced account security.

Deployment Check: Ensure node_modules and .exe files (like tailwind.exe) are excluded from production builds.

Prepared by: Arogundade Oladipupo Web Application Developer & Online Claiming Agent
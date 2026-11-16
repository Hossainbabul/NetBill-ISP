# NetBill ISP – Internet & Cable TV Billing Management System

A full-stack, mobile-responsive Bengali ISP & Cable TV Billing Management System built with **React + Vite + Tailwind CSS** and an **Express** backend with atomic JSON persistence, role-based access control (RBAC), E-Billing (bKash, Nagad, Rocket, Bank), POS/A4 printing, and automatic Bengali SMS confirmation.

---

## Run Locally

**Prerequisites:** Node.js 18+ (or 20+ recommended)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables:
   - Copy `.env.example` to `.env` and customize optional settings (`ADMIN_PASSWORD`, `SMS_PROVIDER`, Twilio or Local BD SMS API keys, etc.).
   - If `ADMIN_PASSWORD` is left unset on first boot, a strong random admin password (and collector passwords / webhook secret) is generated automatically and printed **once** to the server console.
3. Run in development mode (Express + Vite middleware on port `3000`):
   ```bash
   npm run dev
   ```
4. Build and run in production mode:
   ```bash
   npm run build
   npm run serve
   ```
   (`NODE_ENV=production npm start` also runs the production server serving `dist/`.)

---

## Environment Variables

See `.env.example` for all supported variables:
- `ADMIN_PASSWORD` / `RESET_ADMIN_PASSWORD`: Set `"1"` with a strong `ADMIN_PASSWORD` (8+ characters) to initialize or reset the admin password at startup.
- `SESSION_IDLE_HOURS`: Idle session timeout in hours (default `12`; absolute session limit is 7 days).
- `TRUST_PROXY`: Set to `"1"` when behind a reverse proxy (Cloud Run, Nginx, etc.).
- `FORCE_HTTPS`: Set to `"1"` to redirect plain HTTP requests to HTTPS in production.
- `BLOCK_FRAMING`: Set to `"1"` to send `X-Frame-Options: DENY` and `frame-ancestors 'none'` outside embedded previews.
- `SMS_PROVIDER`, `TWILIO_*`, `LOCAL_SMS_*`: Server-side SMS gateway configuration.

---

## Security Notes

See `SECURITY-CHANGES.md` for details on password hashing (`scrypt`), startup credential hardening, rate limiting, RBAC enforcement, public lookup data masking, and webhook protections.

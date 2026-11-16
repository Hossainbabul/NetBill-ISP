# Security Changes

This document summarizes the security hardening applied to **NetBill ISP** across the backend (`server.ts`), configuration (`.env.example`, `.gitignore`), and frontend UI.

## 1. Password Hashing & Strong Password Enforcement
- **Cryptographic `scrypt` Hashing:** Admin and collector passwords are hashed with per-user random salts (`crypto.scryptSync`) and verified with `crypto.timingSafeEqual`. Legacy plaintext passwords are automatically upgraded on startup or login.
- **Strong Password Policy:** New and updated admin/collector passwords must be at least 8 characters long and are checked against common/weak passwords (`admin123`, `12345678`, `password`, etc.).
- **Current Password Check on Admin Update:** Updating `AdminPassword` via `PUT /api/settings` requires verifying `CurrentAdminPassword`.

## 2. Removal of Hardcoded Demo Credentials
- **Login Page Cleanup:** The quick demo credential buttons (`admin/admin123`, `rafiq/1234`) have been removed from `LoginView.tsx`.
- **Startup Credential Hardening (`hardenCredentials()`):** Default/weak passwords and the demo webhook secret (`nb_whsec_demo_2026`) in `data/netbill-db.json` are automatically replaced on startup with strong random values (printed once to the server console) or with `ADMIN_PASSWORD` from the environment.

## 3. Session Expiry, Revocation & Per-Request Authorization
- **Idle & Absolute Timeouts:** Sessions expire after `SESSION_IDLE_HOURS` (default 12 hours) of inactivity or 7 days maximum lifetime.
- **Live Status & Scope Enforcement:** Every authenticated request re-verifies collector `Status === 'এক্টিভ'` and refreshes `assignedAreas` from the database.
- **Session Revocation:** Changing a password, deactivating, or deleting a collector immediately revokes their active sessions; changing the admin password revokes other admin sessions.

## 4. Rate Limiting & Brute-Force Protection
- **Login Rate Limiting:** Locks repeated failed attempts per `username+IP` (5 failures / 15 min) and caps total IP login requests (20 / 15 min).
- **Public Portal Throttling:** Rate-limits `/api/public/lookup` (40/min + 10 miss / 10 min lockout) and `/api/public/epayment` (8 / 10 min, max 5 pending requests per customer).
- **Webhook & SMS Throttling:** Rate-limits failed webhook secret attempts (`webhook-fail`) and `/api/sms/send`.

## 5. Public E-Billing Data Minimization & Masking
- **Exact Lookup Required:** `/api/public/lookup` requires an exact full `CustomerID` or exact full normalized mobile number (partial suffix matching removed).
- **Masked Sensitive Output:** Public responses mask customer mobile numbers (`maskMobile`), transaction IDs (`maskTrx`), and omit private fields such as street addresses and internal notes.

## 6. Role-Based Access Control (RBAC) Hardening
- **Bootstrap Scoping:** Collectors (`User`) no longer receive `AdminUsername` or `PaymentGatewayWebhookSecret` in `/api/bootstrap`.
- **Customer Field Restrictions:** Collectors cannot set `OpeningBalance` on creation, cannot move customers outside their assigned areas, and cannot modify `MonthlyBill`, `Package`, or `ServiceType` on edit.
- **Collection Date Bounds:** Collectors cannot back-date or future-date collections beyond ±1 day from today.

## 7. Webhook & HTTP Hardening
- **Timing-Safe Webhook Verification:** `/api/webhook/epayment` validates secrets with `safeEqual`, enforces a minimum 16-character non-demo secret, and handles `DuplicateTrxError` idempotently (`{ ok: true, duplicate: true }`).
- **Blocked Internal Paths & Security Headers:** Blocks direct HTTP access to `/data`, `/server`, `/@fs/`, `.env*`, `server.ts`, `package.json`, and lockfiles (`404`). Sets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store` on `/api/*`, optional HTTPS redirect (`FORCE_HTTPS`), and optional framing block (`BLOCK_FRAMING`).
- **Git Hygiene:** `data/` and `*.tmp.*` are excluded in `.gitignore`.

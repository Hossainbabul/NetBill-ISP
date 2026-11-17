# Security changes

| # | Problem found | Fix |
|---|---|---|
| 1 | **`/data/netbill-db.json` and `server.ts` could be downloaded by anyone** (Vite dev server served the whole project folder) | Sensitive paths blocked before Vite/static (incl. encoded, `..`, `//`, `/@fs/`, upper-case variants) |
| 2 | Demo logins (`admin/admin123`, `rafiq/1234`) shown on the login page and stored in the database | Demo box removed; defaults are replaced at startup with random passwords (printed once) |
| 3 | Webhook secret sent to every logged-in collector; demo secret in the repo | Secret only sent to admin; demo/short secret auto-replaced; timing-safe compare; 16+ chars enforced; failure lockout |
| 4 | Same TrxID could be recorded many times (manual entry + webhook replay) | Case-insensitive duplicate TrxID check for every digital payment; webhook retries are acknowledged, not re-credited |
| 5 | Passwords stored in plain text | scrypt hashing (built-in Node, no new dependency); old plain-text passwords auto-migrated |
| 6 | No brute-force protection | Login lockout (5 failures / 15 min per user+IP, 20 per IP); rate limits on public portal, e-payment, webhook, SMS |
| 7 | Public lookup matched on last digits and returned the full customer record | Exact ID or full mobile only; minimal fields; mobile and TrxID masked; strict limit on failed lookups |
| 8 | Public e-payment form unlimited / unvalidated | Rate limit, TrxID/amount/method validation, max 5 pending per customer |
| 9 | Sessions never expired and ignored later account changes | 12 h idle / 7 day absolute expiry; account re-checked every request (deactivate = instant logout) |
| 10 | Collectors could change bill/package/area, invent opening balances, back-date collections | Restricted to admin (back-dating limited to ±1 day) |
| 11 | Settings accepted any fields; admin password change needed no password | Whitelisted fields, validation, current password required to change it |
| 12 | `data/` not in `.gitignore`; no security headers; stack traces possible | Added; headers (nosniff, no-store on API, HSTS in HTTPS), JSON error handler |
| 13 | `npm install` failed (esbuild peer conflict) | `esbuild` set to `^0.27.0` |

## Still your responsibility
* Digital payments **recorded by collectors** cannot be verified automatically — check them against your merchant account.
* The session token is kept in browser storage (no XSS sinks were found). Moving to HttpOnly cookies is a bigger change.
* Use HTTPS in production, back up `data/netbill-db.json`, keep the repository private.
* The JSON file database suits a small ISP; use a real database if you grow.

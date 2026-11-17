<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/a9afd08f-ce98-4267-b67e-d42201242c65

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`


## Security & first start

1. `npm install`, then `npm run dev` (or, for real use: `npm run build` then `npm run serve`).
2. On the **first start** the server prints a box in the console with a **random admin password**
   (and random collector passwords for the demo collectors). They are shown **once only** — log in and
   change them. To choose your own admin password instead, set `ADMIN_PASSWORD` in `.env` before the first start.
   Forgot it later? Set `ADMIN_PASSWORD` + `RESET_ADMIN_PASSWORD=1`, restart once, then remove both.
3. Open **Settings** and enter your real bKash / Nagad / Rocket / bank details. Replace the demo company info.
4. Payments: customers pay to your number and submit the TrxID in the pay portal → you approve it in the
   e-payment screen *after checking the TrxID in your merchant app / SMS*. Automatic approval is possible via
   `POST /api/webhook/epayment` with the header `x-webhook-secret` (the secret is shown to the admin in Settings).
5. **Never commit `data/`** (customers, hashed passwords). It is in `.gitignore`. If it was committed before, run
   `git rm -r --cached data` and make the repository **private**.
6. Live use: serve over **HTTPS** (Nginx/Caddy), set `TRUST_PROXY=1`, and run `npm run build && npm run serve`
   (production mode). Back up `data/netbill-db.json` regularly. On Cloud Run the disk is temporary — use a VPS
   or a persistent volume.

See [SECURITY-CHANGES.md](SECURITY-CHANGES.md) for the full list of fixes.


## বকেয়া বিলের SMS + পেমেন্ট লিংক

1. `.env`-এ `APP_URL="https://আপনার-ওয়েবসাইট"` দিন এবং SMS gateway চালু করুন (`SMS_PROVIDER="local_bd"` + API key)।
2. **ম্যানেজার → ব্রডকাস্ট** ট্যাবে "শুধু বকেয়া" ফিল্টার রেখে এরিয়া বেছে নিন।
3. বার্তায় `{Name} {ID} {Due} {PayLink} {Company}` ব্যবহার করুন। `{PayLink}` সার্ভার নিজে `APP_URL` দিয়ে লিংক বানায়।
4. "SMS পাঠান" চাপুন — গ্রাহক লিংকে ক্লিক করলে পেমেন্ট পোর্টালে নিজের তথ্য ভরা অবস্থায় পাবে।

বাংলা SMS-এ প্রতি ৭০ অক্ষরে ১টি SMS-এর খরচ কাটে, তাই বার্তা ছোট রাখুন। `localhost` থেকে পাঠালে এবং `APP_URL` না থাকলে সিস্টেম পাঠাতে অস্বীকার করবে।

## পেমেন্ট লিংক SMS (প্রত্যেককে একবারই) + প্রতি মাসের স্বয়ংক্রিয় বিল

**সেটিংস → পেমেন্ট লিংক SMS ও মাসিক বিল** থেকে চালু করুন (গোড়াতেই বন্ধ, কারণ প্রতিটি SMS-এ টাকা কাটে)।

* প্রত্যেক সক্রিয় গ্রাহকের মোবাইলে **একবারই** একটি SMS যায়, তার নিজের **স্থায়ী লিংকসহ**। পরে যোগ হওয়া নতুন গ্রাহকও একবার পায়। আর কখনো আলাদা SMS যায় না।
* গ্রাহক লিংক খুললেই **তখনকার বকেয়া** দেখে: অক্টোবরের বকেয়া থাকলে অক্টোবর; পরিশোধ হলে "আপনার কোনো বকেয়া নেই ✅"; পরের মাসে নভেম্বরের বকেয়া।
* "প্রতি মাসের নতুন বিল নিজে তৈরি করুন" চালু থাকলে মাস শুরু হলে সবার নতুন মাসের বিল তৈরি হয় (সার্ভার বন্ধ থাকলে চালু হওয়ার পর, বা গ্রাহক লিংক খুললেই)।
* বার্তায় `{Name} {ID} {DeadlineDay} {PayLink} {Company}` ব্যবহার করা যায়।
* "কারা পাবেন দেখুন" = কারা পাবেন ও নমুনা বার্তা (কিছু পাঠায় না); "এখনই পাঠান" = এখনই পাঠায়।
* গ্রাহক TrxID জমা দিলে অ্যাডমিন **Approve** করার পরই বকেয়া কমে "কোনো বকেয়া নেই" দেখায়।
* দরকার: `.env`-এ `APP_URL`, আসল SMS gateway (`SMS_PROVIDER="local_bd"` + API key), এবং সার্ভার চালু থাকা।

# Deployment Roadmap: Vercel (frontend) + Render (backend)

## Phase 1 — Backend (Render)

### Step 1: Deploy to Render
1. Go to https://dashboard.render.com
2. Click **New +** → **Web Service**
3. Connect your GitHub repo (`Email-Web-Scraper`)
4. Configure:
   - **Name:** `lead-scraper-api`
   - **Environment:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python app.py`
   - **Plan:** Free
5. Click **Create Web Service**
6. Wait for build to finish, then copy the URL:
   ```
   https://lead-scraper-api.onrender.com
   ```

---

## Phase 2 — Frontend (Vercel)

### Step 2: Set API URL
Open `index.html` and change line 553:
```js
// before (local dev)
const API = '';

// after (production)
const API = 'https://lead-scraper-api.onrender.com';
```

### Step 3: Deploy to Vercel
1. Go to https://vercel.com
2. Click **Add New** → **Project**
3. Import your GitHub repo (`Email-Web-Scraper`)
4. Vercel auto-detects static files from `vercel.json`
5. Click **Deploy**
6. Wait for build, then open the URL

---

## Phase 3 — Verify

### Step 4: Test the full flow
1. Open your Vercel URL
2. Paste URLs in the textarea → click **INITIALIZE_SCRAPE**
3. Check browser DevTools → Network tab:
   - Requests should go to `https://lead-scraper-api.onrender.com/...`
   - Scraping should run and stream progress back
4. Try CSV upload too

---

## Local Development

When running locally, keep `API = ''` and just run:
```bash
python app.py
```
Open http://localhost:5000 — everything works without CORS.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| CORS error in console | Verify `flask-cors` is in `requirements.txt` and `CORS(app)` is in `app.py` |
| 404 on API calls | Check the `API` constant matches your Render URL exactly (no trailing slash) |
| SSE not connecting | Render free tier spins down after 15 min of inactivity — first request after idle takes ~30s to cold start |
| Download links broken | Same `API` prefix issue — verify all 4 download `onclick` handlers use `API + '/download/...'` |

# 🏥 CHIMEDIS — Tiếng Trung Y Khoa

**Chinese Medical Terminology Discovery** — A comprehensive PWA for Vietnamese learners of Traditional Chinese Medicine.

- 📱 **Progressive Web App** — Works offline, installable on iOS/Android
- 🎯 **Bilingual + Trilingual** — Vietnamese, Chinese, English  
- 📚 **Searchable Database** — 22+ respiratory system terms (expandable)
- 🎓 **Learning Tools** — Flashcards, quizzes, spaced repetition
- 🔄 **Auto-sync** — Data updates from Google Sheets hourly
- 🚀 **Production-ready** — Deployed on Cloudflare Pages + Hostinger

---

## 📋 Project Structure

```
chimedis-web/
├── frontend/
│   └── index.html              # PWA app (all-in-one HTML)
├── backend/
│   ├── server.js               # Express API server
│   ├── build-api.js            # Google Sheets → JSON builder
│   ├── package.json            # Node dependencies
│   ├── .env.example            # Config template
│   └── public/data/            # Generated JSON files (gitignored)
├── .github/workflows/
│   ├── deploy.yml              # Auto-deploy on push
│   └── sync-sheets.yml         # Auto-sync sheets hourly
├── setup.sh                    # One-click setup script
├── README.md                   # This file
└── .gitignore
```

---

## 🚀 Quick Start (Automated Setup)

### Prerequisites
- GitHub account + Personal Access Token
- Hostinger account (or ready to purchase)
- Google Cloud service account credentials
- Node.js 18+ (for local testing)

### 1. Setup GitHub Secrets

In your GitHub repo settings (`Settings > Secrets and variables > Actions`), add:

```
GOOGLE_SHEETS_ID          = 1wXldDsL7Zs3GYEXx7o1n3y7T1KHiWkasAgWNhBIUHaI
GOOGLE_CREDENTIALS_JSON   = [paste contents of credentials.json]
CLOUDFLARE_API_TOKEN      = [get from Cloudflare]
CLOUDFLARE_ACCOUNT_ID     = [get from Cloudflare]
HOSTINGER_HOST            = your-domain.com
HOSTINGER_USERNAME        = cPanel username
HOSTINGER_PASSWORD        = cPanel password
```

### 2. Run Setup Script

```bash
# Clone repo
git clone https://github.com/tmh2388/chimedis-web.git
cd chimedis-web

# Run setup
bash setup.sh

# Follow prompts:
#  → GitHub token?
#  → Hostinger info?
#  → Google Sheets ID?
#  → Google credentials JSON?
```

### 3. Deploy

```bash
# Push to GitHub (triggers auto-deploy)
git push origin main

# Check deployment status:
#  → GitHub Actions
#  → Cloudflare Pages
#  → Hostinger
```

---

## 📖 Manual Setup (If Not Using Script)

### Backend Setup

```bash
cd backend

# 1. Install dependencies
npm install

# 2. Create credentials.json
# Download from Google Cloud Console:
# https://console.cloud.google.com/
# → Service Accounts
# → Create Service Account
# → Create Key (JSON)
# → Download & place in backend/

# 3. Create .env
cp .env.example .env
# Edit .env with your values

# 4. Build API (local test)
npm run build

# 5. Start server
npm start
# API running on http://localhost:3000
```

### Frontend Setup

```bash
cd frontend

# No build step needed — it's a standalone PWA
# Deploy to Cloudflare Pages via GitHub or manual upload

# Or serve locally:
python -m http.server 8000
# Visit http://localhost:8000
```

---

## 🔄 Data Flow

```
Google Sheets (master data)
    ↓ (automatic, hourly)
GitHub Actions builds API
    ↓
Hostinger (API server)
    ↓
Frontend PWA fetches & caches
    ↓
User (offline or online)
```

### Adding New Terms

1. **Edit Google Sheet** (authorized users only)
2. **API auto-builds** (GitHub Actions every hour)
3. **PWA auto-updates** (next user refresh)

---

## 🎯 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/terms` | GET | Fetch all terms (filters: `group1`, `group2`, `verified`, `search`) |
| `/api/groups` | GET | List unique groups |
| `/api/metadata` | GET | Last build time + stats |
| `/api/build-now` | POST | Trigger build (requires `webhook_secret`) |
| `/health` | GET | Health check |

### Example Requests

```bash
# Get all terms
curl https://api.chimedis.vn/api/terms

# Filter by group
curl "https://api.chimedis.vn/api/terms?group1=Giải%20phẫu&group2=Hệ%20hô%20hấp"

# Search
curl "https://api.chimedis.vn/api/terms?search=phế"

# Trigger build (requires secret)
curl -X POST "https://api.chimedis.vn/api/build-now?secret=YOUR_SECRET"
```

---

## 🛠 Development

### Local Testing

```bash
# Terminal 1: Start backend
cd backend
npm install
npm run build
npm start

# Terminal 2: Open frontend
cd frontend
python -m http.server 8000
# Visit http://localhost:8000 in browser
```

### Debugging

- **API issues:** Check `backend/public/data/metadata.json`
- **Build errors:** Run `npm run build` manually, check output
- **Google Sheets:** Verify service account has read access
- **PWA offline:** Check DevTools > Application > Service Workers

---

## 📦 Deployment

### Cloudflare Pages (Frontend PWA)

1. Connect GitHub repo
2. Build command: `(empty)`
3. Build output: `frontend/`
4. Deploy

### Hostinger (Backend API)

1. Create Node.js app in cPanel
2. Git clone repo
3. `npm install && npm run build`
4. Start app
5. Point domain to Hostinger

### GitHub Actions (Auto-deploy)

Workflows run automatically:
- **On push:** `deploy.yml` → builds + deploys
- **Hourly:** `sync-sheets.yml` → syncs Google Sheets

---

## 🔐 Security Notes

⚠️ **Important:**
- Never commit `.env` or `credentials.json`
- Rotate GitHub token + Hostinger password regularly
- Google Sheets should only be accessible to authorized users
- `WEBHOOK_SECRET` protects `/api/build-now` endpoint

---

## 📊 Database Schema

### Google Sheets Columns

| Column | Content | Example |
|--------|---------|---------|
| A | ID | `hh001` |
| B | Chinese (汉字) | `肺` |
| C | Pinyin | `fèi` |
| D | Vietnamese | `Phổi` |
| E | English | `lung` |
| F | Group1 | `Giải phẫu` |
| G | Group2 | `Hệ hô hấp` |
| H | Position (VI) | `Phổi nằm trong lồng ngực...` |
| I | Position (ZH) | `肺位于胸腔内...` |
| ... | (more columns) | ... |

---

## 🎓 Learning Features

- **Vocabulary Tab:** Browse + search terms
- **Flashcard Tab:** Self-paced learning (flip to reveal)
- **Quiz Tab:** Multiple choice (4 options)
- **Done Tab:** Track progress (review / new / known)
- **Offline:** Works without internet
- **Spaced Repetition:** localStorage remembers status

---

## 🐛 Troubleshooting

### "API data not found"
- Run `npm run build` in `backend/`
- Check `backend/public/data/terms.json` exists
- Verify Google credentials are valid

### "Sheets API error: 403 Forbidden"
- Service account email not shared on Sheet
- Go to Google Sheet > Share > add service account email

### "PWA won't update"
- Clear browser cache / localStorage
- Uninstall app and reinstall
- Check Service Worker in DevTools

### "Hostinger deploy fails"
- Check SSH access working
- Verify `npm install` succeeds
- Check Node.js version (18+)

---

## 📚 Resources

- **Google Sheets API:** https://developers.google.com/sheets
- **Express.js:** https://expressjs.com
- **Cloudflare Pages:** https://pages.cloudflare.com
- **Progressive Web Apps:** https://web.dev/progressive-web-apps/

---

## 👤 Contributors

- **Hạ Vân Minh** — Project lead, TCM expertise
- **Chris (Claude)** — Architecture, automation

---

## 📄 License

MIT — See LICENSE file

---

## 🤝 Support

- Issues: GitHub Issues
- Email: tmh2388@gmail.com
- GitHub: @tmh2388

---

**Built with ❤️ for Vietnamese medical students and TCM practitioners.**

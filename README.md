# Resume Optimizer

AI-powered resume optimizer — rewrites bullets, fixes ATS issues, integrates keywords, and produces an optimized resume matched to any job description.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add your Anthropic API key
Open `.env` and replace the placeholder:
```
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
```
Get your key at: https://console.anthropic.com/

### 3. Run the server
```bash
node server.js
```

### 4. Open the app
Go to: http://localhost:3000

---

## How it works

1. Upload your resume (PDF, DOCX, or TXT) or paste the text
2. Paste the job description
3. Click **Analyze & Optimize Resume**
4. Get back:
   - Fit scores (Overall, ATS, Keywords, Achievements)
   - Rewritten bullet points (achievement-based, metrics-driven)
   - Top 15 keywords from the JD (present vs. missing)
   - ATS compatibility issues with fixes
   - Skill & experience gap analysis
   - Full optimized resume ready to copy or download

---

## Deploy to the web (optional)

### Railway (easiest)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add `ANTHROPIC_API_KEY` as an environment variable
4. Done — Railway auto-detects Node and runs `node server.js`

### Render
1. Push to GitHub
2. New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add `ANTHROPIC_API_KEY` environment variable

---

## Project structure

```
resume-optimizer/
├── server.js        ← Express proxy server (keeps API key secure)
├── .env             ← Your API key (never commit this)
├── .gitignore       ← Ignores node_modules and .env
├── package.json
└── public/
    └── index.html   ← Full app UI
```

---

## MongoDB Setup (Free — Vault storage)

The vault uses MongoDB Atlas so your saved resumes survive deployments and ZIP replacements.

### 1. Create a free Atlas cluster
1. Go to https://mongodb.com/atlas and sign up free
2. Create a free **M0** cluster (no credit card needed)
3. Create a database user: Security → Database Access → Add New User
   - Username + password of your choice
   - Role: **Read and Write to any database**
4. Allow network access: Security → Network Access → Add IP Address → **Allow Access from Anywhere** (`0.0.0.0/0`)
5. Get your connection string: Deployment → Database → Connect → Drivers → copy the URI

### 2. Add to your .env
```
MONGODB_URI=mongodb+srv://youruser:yourpassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

### 3. For Railway deployment
Add `MONGODB_URI` as an environment variable in your Railway dashboard alongside `ANTHROPIC_API_KEY`.

That's it — your vault data lives in the cloud and never gets wiped.

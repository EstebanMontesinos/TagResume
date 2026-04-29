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

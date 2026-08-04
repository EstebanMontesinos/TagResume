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
   - Full optimized resume ready to copy or download, automatically
     capped at 2 pages (see "Security" below)

---

## Security

This server proxies every `/analyze` call to the Anthropic API using **your**
API key, and previously had no access control at all — anyone who could
reach the URL could run arbitrary prompts on your bill. It now defaults to
**localhost-only**: requests from anywhere other than `127.0.0.1`/`::1` are
rejected unless you explicitly opt in.

- **Local use (default):** nothing to configure. Only your own machine can
  call this server.
- **Remote/deployed use (Railway, Render, etc.):** set `APP_SHARED_SECRET`
  in `.env` to any random string, and have your client send it as the
  `x-app-secret` request header. Requests without a matching header are
  rejected with `401`.
- **Cross-origin frontend:** if you ever host `public/` on a different
  origin than this server, set `ALLOWED_ORIGIN` in `.env` to that origin.
  Otherwise cross-origin requests are blocked by default (previously CORS
  was fully open to any origin).
- `/analyze` is also rate-limited (20 requests/minute per caller, in-memory,
  no extra dependency) since it's the route that spends your Anthropic
  token budget.

See `.env.example` for all supported variables.

---

## Deploy to the web (optional)

### Railway (easiest)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add `ANTHROPIC_API_KEY` as an environment variable
4. If you want the deployed instance reachable from outside your own
   machine, also set `APP_SHARED_SECRET` (see "Security" above) —
   otherwise the deployed server will reject every request as non-local.
5. Done — Railway auto-detects Node and runs `node server.js`

### Render
1. Push to GitHub
2. New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add `ANTHROPIC_API_KEY` environment variable (and `APP_SHARED_SECRET`
   if you need remote access — see "Security" above)

---

## Project structure

```
resume-optimizer/
├── server.js          ← Express proxy server (keeps API key secure)
├── lib/
│   └── resume-line-parser.js  ← shared resume line-classification + 2-page enforcer
├── test/
│   └── resume-line-parser.test.js
├── .env                ← Your API key (never commit this)
├── .env.example        ← Template of supported environment variables
├── .gitignore          ← Ignores node_modules and .env
├── package.json
└── public/
    ├── index.html      ← Full app UI (Optimizer)
    ├── vault.html      ← Saved-resume snapshots
    ├── tracker.html    ← Application tracker (status, notes, history)
    ├── profile.html    ← Candidate profile + base resume variants
    └── jobs.html       ← Job Inbox (intake + match scoring)
```

---

## Testing

```bash
npm test
```

Runs Node's built-in test runner (`node --test`, no extra dependency)
against `test/`, covering the resume line-classification and 2-page
enforcement logic in `lib/resume-line-parser.js`.

---

## Application Tracker

Beyond the Vault (which just stores a resume snapshot), the Tracker keeps a
real record of every application: company, role, job description, job URL,
source, resume/cover-letter text, match/ATS scores, status, status history,
notes, follow-up date, salary range, and rejection reason.

From the **Optimizer**, after tailoring a resume, click **"Save to
Tracker"** (next to "Save to Vault") to create an entry. Open **Tracker**
(top-right nav, or `/tracker.html`) to view applications grouped by status,
change status (Saved → Applied → Recruiter Screen → Interview → Offer /
Rejected / Withdrawn → Archived), and edit notes/follow-up date/salary/
rejection reason inline.

This reuses the same MongoDB connection as the Vault (a separate
`applications` collection in the same database) — no additional database
setup beyond what's already documented below for the Vault.

## Interview Prep

From an expanded Tracker entry, click **"Generate Interview Prep"** to get
a role summary, likely recruiter/behavioral/technical questions,
resume-grounded STAR stories, technical topics to review, weak areas you
may get challenged on, questions to ask, and compensation notes — all
generated server-side from that application's saved resume + job
description and stored on the tracker entry (regenerate anytime).

Content is visibly split into two kinds: anything tagged **"From your
resume"** is grounded in what you actually wrote (never invented), and
anything tagged **"AI-predicted"** is the model's speculation about what
you might be asked — treat it as practice material, not a guarantee.

## Candidate Profile

`/profile.html` stores contact info, freeform background summaries
(employment history, skills, certifications, education), and named base
resume variants (e.g. "Consultant", "PM", "SE") in a single MongoDB
document.

This is intentionally the lightweight version of a "candidate knowledge
base" — freeform text fields, not a fully structured nested editor with
separate repeatable rows per job/skill/cert. What it does solve directly:
save a resume variant once, then load it into the Optimizer from a
dropdown (appears automatically once you've saved at least one) instead of
re-pasting resume text every session.

## Job Inbox

`/jobs.html` is the entry point for a job *before* you've decided it's worth
tailoring for: capture company, title, description, URL, source, and
location, then click **"Score against Profile"** to get a match score
against your saved Profile data (contact/background summaries and base
resumes) — required-skills, preferred-skills, experience, and industry
sub-scores, plus an overall score and an apply/review/skip recommendation
with a plain-English explanation.

Scoring is honest by design: a mandatory requirement the model can't verify
from your Profile (e.g. a specific clearance, or years of experience it
can't confirm) is called out in the explanation rather than assumed to be
fine, and an unmet mandatory requirement can never produce an "apply"
recommendation regardless of how the other sub-scores look. If your
Profile has no background summary or base resume saved yet, scoring is
blocked with a message telling you to fill in `/profile.html` first, rather
than silently scoring against nothing.

Once you've decided a job is worth pursuing, **"Start Tailoring"** hands the
job description off to the Optimizer (pre-fills the job description field)
and marks the job **"Sent to Optimizer"** in the Job Inbox so you can see
at a glance which jobs you've already acted on.

This reuses the same MongoDB connection as the Vault/Tracker/Profile (a
separate `jobs` collection) — no additional database setup required.

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

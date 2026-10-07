const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, LevelFormat, BorderStyle, TabStopType
} = require('docx');
const PDFDocument = require('pdfkit');
const { parseResume } = require('./lib/resume-sections');
const { renderDesignedResume } = require('./lib/designed-resume-pdf');
const {
  isSectionHeader, isJobLine, isBullet, weighLines, enforeTwoPages,
  LINES_PER_PAGE, TWO_PAGE_BUDGET
} = require('./lib/resume-line-parser');
require('dotenv').config();

const app = express();

// ── Access control ────────────────────────────────────────────────────────
// This server proxies requests to the Anthropic API using a key paid for by
// the developer, and previously had no access control at all: any caller,
// from any origin, could hit /analyze with an arbitrary model/prompt/token
// count. By default this now only accepts requests from localhost. If you
// need remote access (e.g. a Railway/Render deployment), set
// APP_SHARED_SECRET in .env and send it as the `x-app-secret` header from
// your own client.
function isLocalRequest(req) {
  const ip = (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

app.use((req, res, next) => {
  const secret = process.env.APP_SHARED_SECRET;
  if (secret) {
    if (req.get('x-app-secret') === secret) return next();
    return res.status(401).json({ error: 'Unauthorized. Set the x-app-secret header to match APP_SHARED_SECRET.' });
  }
  if (isLocalRequest(req)) return next();
  return res.status(403).json({
    error: 'This server only accepts local requests by default. Set APP_SHARED_SECRET in .env to allow remote access.'
  });
});

// Restrict CORS: same-origin requests (the bundled public/ app) don't need
// CORS headers at all. Only enable cross-origin access if ALLOWED_ORIGIN is
// explicitly configured — previously this was a wide-open app.use(cors()),
// letting any website's JS call this server on a visitor's behalf.
const allowedOrigin = process.env.ALLOWED_ORIGIN || null;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : { origin: false }));

// Minimal in-memory rate limiter — no new dependency. Bounds how often any
// single caller can trigger the (paid, per-token) /analyze proxy.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  next();
}

app.use(express.json({ limit: '4mb' }));
app.use(express.static('public'));

// ── MongoDB connection ────────────────────────────────────────────────────────
let db = null;

async function getDB() {
  if (db) return db;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set in .env');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('resume_optimizer');
  console.log('Connected to MongoDB');
  return db;
}

// ── Resume Vault (MongoDB) ────────────────────────────────────────────────────

// Save entry
app.post('/vault/save', async (req, res) => {
  try {
    const { company, jobTitle, resumeText, analysisScores, keywords } = req.body;
    if (!company || !resumeText) return res.status(400).json({ error: 'company and resumeText required' });
    const db = await getDB();
    const entry = {
      savedAt:        new Date(),
      company:        company.trim(),
      jobTitle:       jobTitle || '',
      resumeText,
      analysisScores: analysisScores || null,
      keywords:       keywords || [],
    };
    const result = await db.collection('vault').insertOne(entry);
    res.json({ success: true, id: result.insertedId.toString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List entries (no resumeText for speed)
app.get('/vault/list', async (req, res) => {
  try {
    const db = await getDB();
    const list = await db.collection('vault')
      .find({}, { projection: { resumeText: 0 } })
      .sort({ savedAt: -1 })
      .toArray();
    res.json(list.map(e => ({ ...e, id: e._id.toString() })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single entry
app.get('/vault/:id', async (req, res) => {
  try {
    const db = await getDB();
    const entry = await db.collection('vault').findOne({ _id: new ObjectId(req.params.id) });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ ...entry, id: entry._id.toString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete entry
app.delete('/vault/:id', async (req, res) => {
  try {
    const db = await getDB();
    await db.collection('vault').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Application Tracker (MongoDB) ─────────────────────────────────────────────
// Reuses the same MongoDB connection/database as the vault above (per the
// original product brief: "you can use the database tied to the project
// already") rather than introducing a second datastore. This is a separate
// collection ("applications") from "vault" -- vault is just a saved-resume
// snapshot with no status or job details; this is a real tracker with a
// status lifecycle, job details, and an audit trail of status changes.

// Simplified subset of the full application-lifecycle status list (the PRD's
// full list includes stages like "Ready for approval"/"Approved" that only
// make sense once there's an actual approval-gated submission pipeline,
// which doesn't exist yet -- this subset matches how the tool is actually
// used today: tailor, save, then track what happens after you apply.
const APPLICATION_STATUSES = [
  'Saved', 'Applied', 'Recruiter Screen', 'Interview',
  'Offer', 'Rejected', 'Withdrawn', 'Archived'
];

// Create a tracker entry
app.post('/applications/save', async (req, res) => {
  try {
    const {
      company, jobTitle, jobDescription, jobUrl, source,
      resumeText, coverLetterText, matchScore, atsScore, status,
      sourceJobId, sourceMatchScore, resumeVariant
    } = req.body;

    if (!company || !resumeText) {
      return res.status(400).json({ error: 'company and resumeText required' });
    }
    const initialStatus = APPLICATION_STATUSES.includes(status) ? status : 'Saved';
    const now = new Date();

    const db = await getDB();
    const entry = {
      company:          company.trim(),
      jobTitle:         jobTitle || '',
      jobDescription:   jobDescription || '',
      jobUrl:           jobUrl || '',
      source:           source || '',
      resumeText,
      coverLetterText:  coverLetterText || '',
      // Free-text tag (e.g. "Consultant", "PM") so Analytics can break down
      // response rate by which resume version was actually sent -- optional,
      // prefilled from the Optimizer's "Load from Profile" selection when used.
      resumeVariant:    resumeVariant || '',
      matchScore:       matchScore != null ? matchScore : null,
      atsScore:         atsScore != null ? atsScore : null,
      // Lineage back to the Job Inbox entry this application originated from
      // (if any) -- sourceMatchScore is the *Job Inbox* fit-scoring object
      // (overall/required_skills_score/.../recommendation), a different
      // shape from the plain-number matchScore above (the Optimizer's own
      // ATS/match analysis) -- kept as separate fields deliberately so the
      // two scoring systems are never conflated in the UI.
      sourceJobId:      sourceJobId || null,
      sourceMatchScore: sourceMatchScore || null,
      status:           initialStatus,
      statusHistory:    [{ from: null, to: initialStatus, changedAt: now, note: 'Created' }],
      notes:            '',
      followUpDate:     null,
      salaryRange:      '',
      rejectionReason:  '',
      dateDiscovered:   now,
      dateTailored:     now,
      dateSubmitted:    initialStatus === 'Applied' ? now : null,
      createdAt:        now,
      updatedAt:        now
    };
    const result = await db.collection('applications').insertOne(entry);
    res.json({ success: true, id: result.insertedId.toString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List entries (no resume/cover-letter/JD text, for speed -- same pattern as /vault/list)
app.get('/applications/list', async (req, res) => {
  try {
    const db = await getDB();
    const list = await db.collection('applications')
      .find({}, { projection: { resumeText: 0, coverLetterText: 0, jobDescription: 0 } })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(list.map(e => ({ ...e, id: e._id.toString() })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single entry (full record, including resume/cover-letter/JD text)
app.get('/applications/:id', async (req, res) => {
  try {
    const db = await getDB();
    const entry = await db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ ...entry, id: entry._id.toString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update status (and append to the status-history audit trail)
app.patch('/applications/:id/status', async (req, res) => {
  try {
    const { status, note } = req.body;
    if (!APPLICATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be one of: ' + APPLICATION_STATUSES.join(', ') });
    }
    const db = await getDB();
    const _id = new ObjectId(req.params.id);
    const existing = await db.collection('applications').findOne({ _id });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const now = new Date();
    const historyEntry = { from: existing.status || null, to: status, changedAt: now, note: note || '' };
    const update = {
      $set: { status, updatedAt: now },
      $push: { statusHistory: historyEntry }
    };
    // First time an application moves to "Applied", stamp dateSubmitted --
    // but never overwrite it on later status changes (e.g. Applied -> Interview).
    if (status === 'Applied' && !existing.dateSubmitted) {
      update.$set.dateSubmitted = now;
    }
    await db.collection('applications').updateOne({ _id }, update);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Edit editable fields (notes, follow-up date, salary range, rejection reason,
// and basic job details) without touching status or status history.
app.patch('/applications/:id', async (req, res) => {
  try {
    const EDITABLE_FIELDS = ['notes', 'followUpDate', 'salaryRange', 'rejectionReason', 'jobTitle', 'jobUrl', 'source', 'resumeVariant'];
    const set = { updatedAt: new Date() };
    for (const field of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) set[field] = req.body[field];
    }
    const db = await getDB();
    const result = await db.collection('applications').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: set }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete entry
app.delete('/applications/:id', async (req, res) => {
  try {
    const db = await getDB();
    await db.collection('applications').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Interview Prep Report ─────────────────────────────────────────────────────
// Unlike /analyze (a thin proxy the browser builds prompts against directly),
// this route owns the prompt itself server-side, since the source data
// (resume + job description) already lives in the applications collection --
// no reason to round-trip it through the browser first.
//
// Grounding rule: role_summary/relevant_experience/star_stories must only
// restate facts already present in the stored resume/job description text.
// company_summary is explicitly allowed to be null -- the model has no live
// web access here, so a fabricated-sounding company summary is worse than
// no summary. Everything else (questions, weak areas, talking points) is
// inherently speculative and is labeled as AI-predicted in the UI, never
// presented as verified fact.
function buildInterviewPrepPrompt(resumeText, jobDescription, company, jobTitle) {
  return `You are helping a candidate prepare for an interview. Return ONLY valid JSON — no markdown fences, no extra text.

CANDIDATE RESUME:
${resumeText.slice(0, 6000)}

JOB DESCRIPTION (${jobTitle || 'role'} at ${company}):
${jobDescription.slice(0, 4000)}

Return this exact JSON:
{
  "role_summary": "2-3 sentence summary of what this role actually involves, based on the job description",
  "company_summary": "1-2 sentences about ${company} if you have reliable general knowledge of it, otherwise null -- never guess or invent company details",
  "relevant_experience": ["specific items from the CANDIDATE RESUME above that map directly to this role's requirements — quote or closely paraphrase the resume, never invent experience it doesn't contain"],
  "recruiter_questions": ["likely recruiter-screen question"],
  "behavioral_questions": ["likely behavioral interview question"],
  "technical_questions": ["likely technical interview question based on the JD's requirements"],
  "star_stories": [
    { "likely_question": "a behavioral question this story answers", "story": "a STAR-format (Situation/Task/Action/Result) story built ONLY from accomplishments already present in the candidate resume above — never invent a project, metric, or outcome not stated there" }
  ],
  "technical_topics": ["specific technical topic worth reviewing before this interview"],
  "weak_areas": ["a requirement from the JD the resume doesn't clearly cover — areas the candidate may get challenged on"],
  "questions_to_ask": ["a thoughtful question the candidate could ask the interviewer"],
  "compensation_notes": "1-2 sentences of general guidance on discussing compensation for this type of role — clearly speculative, not a quote or fact",
  "talking_points": ["a specific, application-relevant point connecting this candidate's real background to this specific role/company"]
}

Rules:
- 3-5 items per array unless noted otherwise
- relevant_experience and star_stories must be traceable to the resume text above — if the resume doesn't support it, leave it out rather than inventing it
- company_summary must be null rather than a guess if you're not confident
- Never state a number, metric, or outcome in relevant_experience or star_stories that isn't already in the resume text`;
}

app.post('/applications/:id/interview-prep', rateLimit, async (req, res) => {
  try {
    const db = await getDB();
    const _id = new ObjectId(req.params.id);
    const application = await db.collection('applications').findOne({ _id });
    if (!application) return res.status(404).json({ error: 'Not found' });
    if (!application.jobDescription) {
      return res.status(400).json({ error: 'This application has no job description saved, so an interview-prep report cannot be generated.' });
    }

    const prompt = buildInterviewPrepPrompt(
      application.resumeText, application.jobDescription, application.company, application.jobTitle
    );
    const report = await callAnthropicForJSON({ model: 'claude-opus-4-5', maxTokens: 3000, prompt });

    const now = new Date();
    const interviewPrep = { ...report, generatedAt: now };
    await db.collection('applications').updateOne({ _id }, { $set: { interviewPrep, updatedAt: now } });
    res.json({ success: true, interviewPrep });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Candidate Profile / Knowledge Base (MongoDB) ──────────────────────────────
// Single-document store (fixed _id 'main') for contact info, freeform
// employment/skills/certs/education summaries, and named "base resumes"
// (e.g. Consultant/PM/SE variants) so the Optimizer can load a starting
// resume instead of the user re-pasting the same text every session.
// Deliberately NOT a fully structured nested editor (separate rows per job/
// skill/cert) -- that's real future work, but freeform summary fields cover
// the actual pain point (re-pasting resume text) without a much bigger UI.
const PROFILE_ID = 'main';
const DEFAULT_PROFILE = {
  _id: PROFILE_ID,
  fullName: '', email: '', phone: '', linkedinUrl: '', portfolioUrl: '', workAuthorization: '', photoDataUrl: '',
  employmentHistorySummary: '', skillsSummary: '', certificationsSummary: '', educationSummary: '',
  baseResumes: [],
  updatedAt: null
};

async function getOrCreateProfile(db) {
  const existing = await db.collection('profile').findOne({ _id: PROFILE_ID });
  return existing || DEFAULT_PROFILE;
}

// Get the whole profile (contact info, summaries, base resumes)
app.get('/profile', async (req, res) => {
  try {
    const db = await getDB();
    const profile = await getOrCreateProfile(db);
    res.json(profile);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Update contact info + freeform summary fields (does not touch baseResumes)
app.put('/profile', async (req, res) => {
  try {
    const FIELDS = [
      'fullName', 'email', 'phone', 'linkedinUrl', 'portfolioUrl', 'workAuthorization',
      'employmentHistorySummary', 'skillsSummary', 'certificationsSummary', 'educationSummary',
      'photoDataUrl'
    ];
    // Optional headshot for the designed resume PDF. Stored as a small
    // data URL (the Profile page downsizes it before upload); anything else
    // is rejected so arbitrary data can't end up in this field.
    if (req.body && req.body.photoDataUrl) {
      const ph = String(req.body.photoDataUrl);
      if (!/^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/.test(ph) || ph.length > 600000) {
        return res.status(400).json({ error: 'photoDataUrl must be a JPEG/PNG data URL under ~450KB' });
      }
    }
    const set = { updatedAt: new Date() };
    for (const field of FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) set[field] = req.body[field];
    }
    const db = await getDB();
    await db.collection('profile').updateOne(
      { _id: PROFILE_ID },
      { $set: set, $setOnInsert: { baseResumes: [] } },
      { upsert: true }
    );
    const profile = await getOrCreateProfile(db);
    res.json(profile);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Add or replace a named base resume (e.g. "Consultant", "PM", "SE")
app.post('/profile/base-resumes', async (req, res) => {
  try {
    const { name, text } = req.body;
    if (!name || !text) return res.status(400).json({ error: 'name and text required' });

    const db = await getDB();
    const profile = await getOrCreateProfile(db);
    const baseResumes = (profile.baseResumes || []).filter(
      r => r.name.toLowerCase() !== name.trim().toLowerCase()
    );
    baseResumes.push({ name: name.trim(), text, updatedAt: new Date() });

    await db.collection('profile').updateOne(
      { _id: PROFILE_ID },
      { $set: { baseResumes, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, baseResumes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a named base resume
app.delete('/profile/base-resumes/:name', async (req, res) => {
  try {
    const targetName = decodeURIComponent(req.params.name).toLowerCase();
    const db = await getDB();
    const profile = await getOrCreateProfile(db);
    const baseResumes = (profile.baseResumes || []).filter(r => r.name.toLowerCase() !== targetName);

    await db.collection('profile').updateOne(
      { _id: PROFILE_ID },
      { $set: { baseResumes, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, baseResumes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Job Intake + Matching (MongoDB) ───────────────────────────────────────────
// Captures a job BEFORE any tailoring effort is spent on it, and produces a
// match/qualification score against the candidate Profile so low-fit jobs
// can be skipped early. This is deliberately separate from "applications"
// (Tracker): a job here may never become an application at all.
const JOB_STATUSES = ['New', 'Reviewed', 'Skipped', 'Sent to Optimizer'];

app.post('/jobs', async (req, res) => {
  try {
    const { company, title, description, url, source, location, workMode, employmentType } = req.body;
    if (!company || !title || !description) {
      return res.status(400).json({ error: 'company, title, and description are required' });
    }
    const now = new Date();
    const db = await getDB();
    const job = {
      company: company.trim(),
      title: title.trim(),
      description,
      url: url || '',
      source: source || '',
      location: location || '',
      workMode: workMode || '',
      employmentType: employmentType || '',
      status: 'New',
      matchScore: null,
      dateDiscovered: now,
      createdAt: now,
      updatedAt: now
    };
    const result = await db.collection('jobs').insertOne(job);
    res.json({ success: true, id: result.insertedId.toString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// List jobs (no description, for speed)
app.get('/jobs/list', async (req, res) => {
  try {
    const db = await getDB();
    const list = await db.collection('jobs')
      .find({}, { projection: { description: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(list.map(j => ({ ...j, id: j._id.toString() })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const db = await getDB();
    const job = await db.collection('jobs').findOne({ _id: new ObjectId(req.params.id) });
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json({ ...job, id: job._id.toString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/jobs/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!JOB_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be one of: ' + JOB_STATUSES.join(', ') });
    }
    const db = await getDB();
    const result = await db.collection('jobs').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/jobs/:id', async (req, res) => {
  try {
    const db = await getDB();
    await db.collection('jobs').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Builds the candidate-background block fed to the matching prompt, from
// whatever Profile data exists. Explicitly flags when the profile is sparse
// so the AI (and the user) knows the resulting score is low-confidence
// rather than silently guessing off almost nothing.
function buildCandidateBackgroundBlock(profile) {
  const parts = [];
  if (profile.workAuthorization) parts.push('Work authorization: ' + profile.workAuthorization);
  if (profile.employmentHistorySummary) parts.push('EMPLOYMENT HISTORY:\n' + profile.employmentHistorySummary);
  if (profile.skillsSummary) parts.push('SKILLS:\n' + profile.skillsSummary);
  if (profile.certificationsSummary) parts.push('CERTIFICATIONS:\n' + profile.certificationsSummary);
  if (profile.educationSummary) parts.push('EDUCATION:\n' + profile.educationSummary);
  if ((profile.baseResumes || []).length) {
    parts.push('BASE RESUME (' + profile.baseResumes[0].name + '):\n' + profile.baseResumes[0].text.slice(0, 3000));
  }
  if (!parts.length) return null; // caller decides how to handle an empty profile
  return parts.join('\n\n');
}

function buildMatchScorePrompt(candidateBackground, jobDescription, company, jobTitle) {
  return `You are qualifying a job opportunity against a candidate's real background. Return ONLY valid JSON — no markdown fences, no extra text.

CANDIDATE BACKGROUND:
${candidateBackground}

JOB (${jobTitle} at ${company}):
${jobDescription.slice(0, 4000)}

Return this exact JSON:
{
  "overall": 0,
  "required_skills_score": 0,
  "preferred_skills_score": 0,
  "experience_match": 0,
  "industry_match": 0,
  "work_authorization_compatible": true,
  "recommendation": "apply|review|skip",
  "explanation": "2-3 sentence honest explanation of the score and recommendation, calling out any mandatory requirement that is unmet or unverifiable from the candidate background"
}

Rules:
- Scores are 0-100
- A job with an unmet MANDATORY requirement (e.g. required clearance, required years of experience far exceeding the candidate's) must never get "recommendation": "apply", regardless of how high the other scores are
- If the candidate background doesn't contain enough information to judge a mandatory requirement, say so explicitly in explanation rather than assuming it's fine
- Be honest, not encouraging — this score exists to help the candidate skip bad-fit jobs before wasting time tailoring a resume for them`;
}

app.post('/jobs/:id/score', rateLimit, async (req, res) => {
  try {
    const db = await getDB();
    const _id = new ObjectId(req.params.id);
    const job = await db.collection('jobs').findOne({ _id });
    if (!job) return res.status(404).json({ error: 'Not found' });

    const profile = await getOrCreateProfile(db);
    const candidateBackground = buildCandidateBackgroundBlock(profile);
    if (!candidateBackground) {
      return res.status(400).json({
        error: 'No candidate background found. Fill in your Profile (background summary or at least one base resume) before scoring a job.'
      });
    }

    const prompt = buildMatchScorePrompt(candidateBackground, job.description, job.company, job.title);
    const matchScore = await callAnthropicForJSON({ model: 'claude-opus-4-5', maxTokens: 1200, prompt });

    const now = new Date();
    await db.collection('jobs').updateOne({ _id }, {
      $set: { matchScore: { ...matchScore, scoredAt: now }, status: job.status === 'New' ? 'Reviewed' : job.status, updatedAt: now }
    });
    res.json({ success: true, matchScore });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reverse lookup for the Job Inbox: does this job already have a Tracker
// application linked to it? Lets jobs.html show "View in Tracker" without
// denormalizing the applications list into every /jobs/list response.
app.get('/jobs/:id/application', async (req, res) => {
  try {
    const db = await getDB();
    const application = await db.collection('applications').findOne(
      { sourceJobId: req.params.id },
      { projection: { _id: 1, status: 1 } }
    );
    if (!application) return res.json({ found: false });
    res.json({ found: true, id: application._id.toString(), status: application.status });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cover Letter DOCX generator ──────────────────────────────────────────────
app.post('/generate-cover-letter-docx', async (req, res) => {
  try {
    const { text, company, name } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const FONT = 'Calibri';
    const lines = text.split('\n');
    const children = [];

    for (const raw of lines) {
      const line = raw.trim();
      children.push(new Paragraph({
        spacing: { after: line === '' ? 0 : 120 },
        children: [new TextRun({ text: line, font: FONT, size: 22 })]
      }));
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
          }
        },
        children
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = `cover_letter_${(company || 'application').replace(/\s+/g, '_')}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shared Anthropic helpers ──────────────────────────────────────────────────
// Extracted so both the raw client-facing /analyze proxy below AND the
// server-owned /applications/:id/interview-prep route (which calls
// Anthropic directly rather than round-tripping through the browser) share
// one sanitizer instead of duplicating it a second time.
function sanitizeModelJSONText(rawText) {
  let text = rawText.trim()
    .replace(/^```json\s*/,'').replace(/^```/,'').replace(/```$/,'').trim();
  // Escape literal control chars inside JSON string values so JSON.parse
  // doesn't choke on raw newlines the model sometimes emits inside strings.
  let result = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped)          { result += ch; escaped = false; continue; }
    if (ch === '\\')      { result += ch; escaped = true; continue; }
    if (ch === '"')       { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n')   { result += '\\n'; continue; }
      if (ch === '\r')   { result += '\\r'; continue; }
      if (ch === '\t')   { result += '\\t'; continue; }
      if (ch.charCodeAt(0) < 32) { result += ' '; continue; }
    }
    result += ch;
  }
  return result;
}

// Server-owned Anthropic call that expects a single JSON object back and
// parses it before returning. Used by routes that already have the source
// data (resume/JD) in the database and don't need the browser to see the
// raw prompt-building step, unlike /analyze which is a thin proxy the
// client builds prompts against directly.
async function callAnthropicForJSON({ model, maxTokens, prompt }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env file');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const rawText = (data.content || []).map(b => b.text || '').join('').trim();
  if (!rawText) throw new Error('Empty response from model');
  return JSON.parse(sanitizeModelJSONText(rawText));
}

// ── Anthropic proxy ──────────────────────────────────────────────────────────
app.post('/analyze', rateLimit, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env file' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();

    // Pre-sanitize the optimized_resume field so the browser never sees
    // a JSON parse error from raw newlines in string values.
    if (data.content && Array.isArray(data.content)) {
      data.content = data.content.map(block => {
        if (block.type !== 'text' || !block.text) return block;
        return { ...block, text: sanitizeModelJSONText(block.text) };
      });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Hard 2-page enforcer ─────────────────────────────────────────────────────
// weighLines/enforeTwoPages/isSectionHeader etc. now live in
// lib/resume-line-parser.js (imported above) — they used to be defined here
// AND duplicated again inside /generate-docx and /generate-pdf below.
// enforeTwoPages() previously existed but was never called by any route;
// it is now actually invoked in /generate-docx and /generate-pdf.

app.post('/trim-check', (req, res) => {
  const { text } = req.body;
  const w = weighLines(text.split('\n'));
  const pages = w / LINES_PER_PAGE;
  res.json({ weight: w, budget: TWO_PAGE_BUDGET, pages, fits: w <= TWO_PAGE_BUDGET });
});


// ── DOCX generator ───────────────────────────────────────────────────────────
app.post('/generate-docx', async (req, res) => {
  try {
    const { text: rawText } = req.body;
    // Hard 2-page enforcement (previously dead code — see lib/resume-line-parser.js).
    // No-op if the AI's output already fits the budget.
    const text = enforeTwoPages(rawText);
    const lines = text.split('\n');
    const FONT = 'Calibri';
    const COLOR_NAME = '1F3864';
    const COLOR_HEAD = '2E5496';

    const children = [];
    lines.forEach((raw, idx) => {
      // Strip markdown bold markers the AI sometimes includes
      const line = raw.trimEnd().replace(/\*\*/g, '');
      if (!line.trim()) {
        children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun('')], spacing: { after: 0 } }));
        return;
      }
      // Name — first non-empty line
      if (idx === 0) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { before: 0, after: 30 },
          children: [new TextRun({ text: line.trim(), font: FONT, size: 32, bold: true, color: COLOR_NAME })]
        })); return;
      }
      // Early header lines (title, contact)
      if (idx < 4 && !isSectionHeader(line) && !isJobLine(line)) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 20 },
          children: [new TextRun({ text: line.trim(), font: FONT, size: 20, color: '555555' })]
        })); return;
      }
      if (isSectionHeader(line)) {
        children.push(new Paragraph({
          spacing: { before: 80, after: 30 },
          keepNext: true, // never separate header from its first content line
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_HEAD, space: 1 } },
          children: [new TextRun({ text: line.trim(), font: FONT, size: 20, bold: true, color: COLOR_HEAD, allCaps: true })]
        })); return;
      }
      if (isJobLine(line)) {
        const dateRx = /(.*?)\s{2,}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{4}\s*[–\-]\s*(?:\d{4}|Present))$/i;
        const m = line.match(dateRx);
        if (m) {
          children.push(new Paragraph({
            spacing: { before: 60, after: 10 },
            keepNext: true, // never orphan job title from its bullets
            tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
            children: [
              new TextRun({ text: m[1].trim(), font: FONT, size: 22, bold: true }),
              new TextRun({ text: '\t' + m[2].trim(), font: FONT, size: 20, color: '666666' })
            ]
          }));
        } else {
          children.push(new Paragraph({
            spacing: { before: 60, after: 10 },
            children: [new TextRun({ text: line.trim(), font: FONT, size: 20, bold: true })]
          }));
        }
        return;
      }
      if (isBullet(line)) {
        const bulletText = line.replace(/^[\s]*[•\-\*]\s*/, '').trim();
        children.push(new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { after: 20 },
          children: [new TextRun({ text: bulletText, font: FONT, size: 20 })]
        })); return;
      }
      // Skill line: "Category: skill · skill · skill" — stack tight, no spacing
      // Strip any markdown bold markers the AI may have included
      const cleanLine = line.trim().replace(/\*\*/g, '');
      const isSkillLine = /^[A-Za-z ,&]+:\s/.test(cleanLine) && cleanLine.includes('·');
      if (isSkillLine) {
        const colonIdx = cleanLine.indexOf(':');
        const category = cleanLine.slice(0, colonIdx).trim();
        const skills   = cleanLine.slice(colonIdx + 1).trim();
        children.push(new Paragraph({
          spacing: { before: 0, after: 30 }, // tiny gap between skill rows — readable but compact
          children: [
            new TextRun({ text: category + ': ', font: FONT, size: 20, bold: true }),
            new TextRun({ text: skills, font: FONT, size: 20 })
          ]
        })); return;
      }
      // Normal body
      children.push(new Paragraph({
        spacing: { after: 30 },
        children: [new TextRun({ text: line.trim(), font: FONT, size: 20 })]
      }));
    });

    const doc = new Document({
      numbering: { config: [{ reference: 'bullets', levels: [{
        level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360, hanging: 200 }, spacing: { after: 20 } } }
      }]}]},
      sections: [{ properties: { page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1008, right: 1008, bottom: 1008, left: 1008 }
      }}, children }]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="resume_optimized.docx"');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Designed PDF generator ───────────────────────────────────────────────────
// Presentation-ready layout (sidebar, photo, accent colors) built from the
// same optimized resume text -- see lib/resume-sections.js (parsing) and
// lib/designed-resume-pdf.js (layout). Contact details and photo fall back to
// the Candidate Profile when the resume text/request doesn't carry them.
app.post('/generate-designed-pdf', async (req, res) => {
  try {
    const rawText = (req.body && req.body.text) || '';
    if (!rawText.trim()) return res.status(400).json({ error: 'text required' });

    let profile = null;
    try { profile = await getOrCreateProfile(await getDB()); } catch (e) { /* no DB: render without profile extras */ }

    const data = parseResume(enforeTwoPages(rawText));
    if (!data.name && profile && profile.fullName) data.name = profile.fullName;
    if (!data.contact.length && profile) {
      if (profile.phone) data.contact.push({ label: 'Phone', value: profile.phone });
      if (profile.email) data.contact.push({ label: 'Email', value: profile.email });
      if (profile.linkedinUrl) data.contact.push({ label: 'LinkedIn', value: profile.linkedinUrl.replace(/^https?:\/\/(www\.)?/i, '') });
      if (profile.portfolioUrl) data.contact.push({ label: 'Web', value: profile.portfolioUrl.replace(/^https?:\/\/(www\.)?/i, '') });
    }
    const photoDataUrl = (req.body && req.body.photoDataUrl) || (profile && profile.photoDataUrl) || null;

    const out = await renderDesignedResume(data, { photoDataUrl });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resume_designed.pdf"');
    res.send(out.buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── PDF generator ────────────────────────────────────────────────────────────
app.post('/generate-pdf', async (req, res) => {
  try {
    const { text: rawText } = req.body;
    // Hard 2-page enforcement (previously dead code — see lib/resume-line-parser.js).
    // No-op if the AI's output already fits the budget.
    const text = enforeTwoPages(rawText);
    const lines = text.split('\n');
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resume_optimized.pdf"');
    doc.pipe(res);

    const W = doc.page.width - 112;
    const C = { name: '#1F3864', head: '#2E5496', body: '#1a1a1a', muted: '#555555' };

    lines.forEach((raw, idx) => {
      // Strip markdown bold markers the AI sometimes includes
      const line = raw.trimEnd().replace(/\*\*/g, '');
      if (!line.trim()) { doc.moveDown(0.25); return; }

      if (idx === 0) {
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.name).text(line.trim(), { align: 'center' });
        doc.moveDown(0.2); return;
      }
      if (idx < 4 && !isSectionHeader(line) && !isJobLine(line)) {
        doc.font('Helvetica').fontSize(10).fillColor(C.muted).text(line.trim(), { align: 'center' });
        doc.moveDown(0.15); return;
      }
      if (isSectionHeader(line)) {
        doc.moveDown(0.4);
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.head).text(line.trim().toUpperCase());
        const y = doc.y + 1;
        doc.moveTo(56, y).lineTo(56 + W, y).strokeColor(C.head).lineWidth(0.75).stroke();
        doc.moveDown(0.3); return;
      }
      if (isJobLine(line)) {
        doc.moveDown(0.3);
        const dateRx = /(.*?)\s{2,}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{4}\s*[–\-]\s*(?:\d{4}|Present))$/i;
        const m = line.match(dateRx);
        const leftText  = m ? m[1].trim() : line.trim();
        const rightText = m ? m[2].trim() : '';
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.body).text(leftText);
        if (rightText) {
          doc.font('Helvetica').fontSize(10).fillColor(C.muted)
             .text(rightText, 56, doc.y - 13.5, { width: W, align: 'right' });
        }
        doc.moveDown(0.1); return;
      }
      if (isBullet(line)) {
        const bulletText = line.replace(/^[\s]*[•\-\*]\s*/, '').trim();
        doc.font('Helvetica').fontSize(10).fillColor(C.body)
           .text('•  ' + bulletText, { indent: 10, lineGap: 1.5 });
        doc.moveDown(0.15); return;
      }
      doc.font('Helvetica').fontSize(10).fillColor(C.body).text(line.trim(), { lineGap: 1.5 });
      doc.moveDown(0.15);
    });

    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Resume Optimizer running at http://localhost:${PORT}\n`));

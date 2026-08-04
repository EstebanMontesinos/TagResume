// Morning digest -- reads directly from MongoDB (does NOT require server.js
// to be running), so a scheduled run works even if you haven't started the
// app that day. Prints a plain-text summary to stdout: follow-ups due
// (overdue / today / next 7 days), a quick funnel snapshot, and any Job
// Inbox entries still sitting unscored. Run manually with:
//   node scripts/morning-digest.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

const STAGES = ['Applied', 'Recruiter Screen', 'Interview', 'Offer'];

function reachedStages(app) {
  return new Set((app.statusHistory || []).map(h => h.to));
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.log('MONGODB_URI not set in .env -- cannot generate digest.');
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('resume_optimizer');

  const apps = await db.collection('applications')
    .find({}, { projection: { resumeText: 0, coverLetterText: 0, jobDescription: 0 } })
    .toArray();
  const jobs = await db.collection('jobs')
    .find({}, { projection: { description: 0 } })
    .toArray();

  await client.close();

  const todayStr = new Date().toISOString().slice(0, 10);
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 7);
  const horizonStr = horizon.toISOString().slice(0, 10);

  // -- Follow-ups (overdue / today / next 7 days) -----------------------------
  const due = apps
    .filter(a => a.followUpDate && a.followUpDate.slice(0, 10) <= horizonStr)
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))
    .map(a => {
      const d = a.followUpDate.slice(0, 10);
      const tag = d < todayStr ? 'OVERDUE' : d === todayStr ? 'TODAY' : 'upcoming (' + d + ')';
      return `- [${tag}] ${a.company}${a.jobTitle ? ' — ' + a.jobTitle : ''}`;
    });

  // -- Funnel snapshot (statusHistory-based, not just current status) --------
  const everApplied = apps.filter(a => reachedStages(a).has('Applied'));
  const counts = {};
  STAGES.forEach(s => { counts[s] = 0; });
  everApplied.forEach(a => {
    const reached = reachedStages(a);
    STAGES.forEach(s => { if (reached.has(s)) counts[s]++; });
  });

  // -- Job Inbox items still sitting unscored ---------------------------------
  const newJobs = jobs.filter(j => j.status === 'New');

  // -- Compose plain-text digest ----------------------------------------------
  const lines = [];
  lines.push(`Morning Digest — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`);
  lines.push('');

  lines.push(due.length ? `FOLLOW-UPS (${due.length}):` : 'FOLLOW-UPS: none due in the next 7 days.');
  due.forEach(l => lines.push(l));
  lines.push('');

  lines.push('FUNNEL (all-time):');
  lines.push(`  Applied: ${counts['Applied']}  →  Screen: ${counts['Recruiter Screen']}  →  Interview: ${counts['Interview']}  →  Offer: ${counts['Offer']}`);
  lines.push('');

  lines.push(newJobs.length
    ? `JOB INBOX: ${newJobs.length} job(s) added but not yet scored against your Profile.`
    : 'JOB INBOX: nothing waiting to be scored.');

  console.log(lines.join('\n'));
}

main().catch(e => {
  console.error('Digest failed:', e.message);
  process.exit(1);
});

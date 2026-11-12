// One-off migration: replace an old email address with a new one everywhere it
// is stored (Profile email + base resumes, Vault resumes, Tracker resumes and
// cover letters). Dry run by default -- nothing is written unless you pass --apply.
//   node scripts/replace-email.js            (preview)
//   node scripts/replace-email.js --apply    (write changes)
require('dotenv').config();
const { MongoClient } = require('mongodb');

const OLD = 'esteban.montesinos.services@gmail.com';
const NEW = 'montesinosesteban9@gmail.com';
const APPLY = process.argv.includes('--apply');

const rx = new RegExp(OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
const swap = s => (typeof s === 'string' ? s.replace(rx, NEW) : s);
const has = s => typeof s === 'string' && s.search(rx) !== -1;

async function main() {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI not set in .env'); process.exit(1); }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('resume_optimizer');
  let total = 0;

  // Profile: email field + each base resume's text
  const profile = await db.collection('profile').findOne({ _id: 'main' });
  if (profile) {
    const set = {};
    if (has(profile.email)) set.email = swap(profile.email);
    const resumes = (profile.baseResumes || []).map(r => has(r.text) ? { ...r, text: swap(r.text) } : r);
    const changed = (profile.baseResumes || []).filter(r => has(r.text)).length;
    if (changed) set.baseResumes = resumes;
    const n = Object.keys(set).length ? (set.email ? 1 : 0) + changed : 0;
    if (n) { total += n; console.log(`profile: ${n} item(s)`); if (APPLY) await db.collection('profile').updateOne({ _id: 'main' }, { $set: set }); }
  }

  // Vault + Tracker text fields
  for (const [coll, fields] of [['vault', ['resumeText']], ['applications', ['resumeText', 'coverLetterText']]]) {
    let n = 0;
    for await (const doc of db.collection(coll).find({})) {
      const set = {};
      fields.forEach(f => { if (has(doc[f])) set[f] = swap(doc[f]); });
      if (Object.keys(set).length) { n++; if (APPLY) await db.collection(coll).updateOne({ _id: doc._id }, { $set: set }); }
    }
    if (n) { total += n; console.log(`${coll}: ${n} document(s)`); }
  }

  console.log(total ? `${APPLY ? 'Updated' : 'Would update'} ${total} item(s) ${OLD} -> ${NEW}` : 'No occurrences found.');
  if (!APPLY && total) console.log('Re-run with --apply to write the changes.');
  await client.close();
}
main().catch(e => { console.error('Failed:', e.message); process.exit(1); });

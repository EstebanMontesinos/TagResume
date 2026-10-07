// Parses the optimizer's plain-text resume into structured sections so the
// designed (sidebar) PDF template can place each piece in the right column.
// Pure functions, no I/O -- unit tested in test/designed-resume.test.js.
//
// Input shape is whatever the Optimizer produced (it preserves the user's own
// layout), so every rule here is deliberately forgiving: anything it cannot
// classify is kept (as plain lines) rather than dropped.

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_RANGE = new RegExp(
  '(?:' + MONTH + '\\s+)?\\d{4}\\s*[\\u2013\\u2014-]\\s*(?:(?:' + MONTH + '\\s+)?\\d{4}|Present|Current|Now)', 'i');

const SECTION_ALIASES = {
  'PROFESSIONAL SUMMARY': 'summary', 'SUMMARY': 'summary', 'PROFILE': 'summary', 'OBJECTIVE': 'summary', 'CAREER SUMMARY': 'summary',
  'EXPERIENCE': 'experience', 'WORK EXPERIENCE': 'experience', 'PROFESSIONAL EXPERIENCE': 'experience', 'EMPLOYMENT HISTORY': 'experience', 'WORK HISTORY': 'experience',
  'SKILLS': 'skills', 'TECHNICAL SKILLS': 'skills', 'CORE COMPETENCIES': 'skills', 'KEY SKILLS': 'skills', 'CORE SKILLS': 'skills',
  'EDUCATION': 'education', 'EDUCATION & TRAINING': 'education',
  'CERTIFICATIONS': 'certs', 'CERTIFICATES': 'certs', 'LICENSES & CERTIFICATIONS': 'certs', 'CERTIFICATIONS & LICENSES': 'certs',
  'LANGUAGES': 'languages',
  'AWARDS': 'awards', 'HONORS': 'awards', 'AWARDS & HONORS': 'awards', 'HONORS & AWARDS': 'awards', 'ACHIEVEMENTS': 'awards',
  'LANGUAGES & AWARDS': 'langawards', 'AWARDS & LANGUAGES': 'langawards',
  'PROJECTS': 'other', 'VOLUNTEER': 'other', 'VOLUNTEERING': 'other', 'PUBLICATIONS': 'other', 'ADDITIONAL INFORMATION': 'other'
};

function sectionKeyFor(line) {
  const t = line.trim().replace(/[:\s]+$/, '');
  if (!t || t.length > 40) return null;
  const upper = t.toUpperCase();
  if (SECTION_ALIASES[upper]) return { key: SECTION_ALIASES[upper], title: upper };
  // "EXPERIENCE (5+ years)" style: header followed by a parenthetical
  const m = upper.match(/^([A-Z &]+?)\s*\(.*\)$/);
  if (m && SECTION_ALIASES[m[1].trim()]) return { key: SECTION_ALIASES[m[1].trim()], title: m[1].trim() };
  return null;
}

const BULLET_RX = /^\s*[•▪▸◦●\-*‣⁃]\s+/;
const isBulletLine = l => BULLET_RX.test(l);
const stripBullet = l => l.replace(BULLET_RX, '').trim();
const clean = s => (s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

// ── Contact line(s) ─────────────────────────────────────────────────────────
function classifyContact(token) {
  const t = token.replace(/^(phone|tel|mobile|email|e-mail|web|website|portfolio|linkedin|github|location|address)\s*:\s*/i, '').trim();
  if (!t) return null;
  if (/@/.test(t)) return { label: 'Email', value: t };
  if (/linkedin\./i.test(t)) return { label: 'LinkedIn', value: t.replace(/^https?:\/\/(www\.)?/i, '') };
  if (/github\./i.test(t)) return { label: 'GitHub', value: t.replace(/^https?:\/\/(www\.)?/i, '') };
  if (/^\+?[\d\s().\-]{7,}$/.test(t) && /\d{3}/.test(t)) return { label: 'Phone', value: t };
  if (/^(https?:\/\/|www\.)|\.(com|org|io|net|dev|co|app|me)(\/|$)/i.test(t)) return { label: 'Web', value: t.replace(/^https?:\/\/(www\.)?/i, '') };
  return { label: 'Location', value: t };
}

function looksLikeContactLine(line) {
  return /@|https?:\/\/|www\.|linkedin\.|github\./i.test(line) || /\+?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/.test(line);
}

function parseContactLines(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    // Split on separators the AI/user commonly uses between contact items.
    const tokens = line.split(/\s*[|·•]\s*|\s{3,}|\s+[–—-]\s+/);
    for (const tok of tokens) {
      const c = classifyContact(clean(tok));
      if (c && !seen.has(c.value.toLowerCase())) { seen.add(c.value.toLowerCase()); out.push(c); }
    }
  }
  return out;
}

// ── Experience ──────────────────────────────────────────────────────────────
function parseJobHeader(rawLine) {
  let line = clean(rawLine);
  let dates = '';
  const m = line.match(DATE_RANGE);
  if (m) {
    dates = m[0].replace(/\s*[–—-]\s*/, ' – ');
    line = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).replace(/\s*\|\s*$/, '').replace(/^\s*\|\s*/, '');
    line = line.replace(/\s+\|\s+\|\s+/g, ' | ').replace(/[\s|,–—-]+$/, '').trim();
  }
  let title = '', company = '', extra = '';
  if (/\s\|\s/.test(line)) {
    // "Company | Title [| Location]" -- the Optimizer's own default layout.
    const p = line.split(/\s+\|\s+/).map(s => s.trim()).filter(Boolean);
    company = p[0] || ''; title = p[1] || ''; extra = p.slice(2).join(' | ');
    if (p.length === 1) { title = p[0]; company = ''; }
  } else if (/\s[–—]\s/.test(line)) {
    // "Title — Company"
    const p = line.split(/\s+[–—]\s+/).map(s => s.trim()).filter(Boolean);
    title = p[0] || ''; company = p.slice(1).join(' — ');
  } else if (/\s-\s/.test(line)) {
    const p = line.split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
    title = p[0] || ''; company = p.slice(1).join(' - ');
  } else {
    title = line;
  }
  return { title, company, extra, dates, bullets: [] };
}

function parseExperience(lines) {
  const jobs = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (isBulletLine(raw)) {
      if (!cur) { cur = { title: '', company: '', extra: '', dates: '', bullets: [] }; jobs.push(cur); }
      cur.bullets.push(clean(stripBullet(raw)));
      continue;
    }
    const line = clean(raw);
    // A bare date range on its own line belongs to the job above it.
    if (cur && !cur.dates && cur.bullets.length === 0 && line.replace(DATE_RANGE, '').replace(/[\s|,()]/g, '') === '') {
      cur.dates = line.match(DATE_RANGE)[0].replace(/\s*[–—-]\s*/, ' – ');
      continue;
    }
    // A non-bullet line right after bullets that has no date/pipe is a wrapped
    // bullet continuation, not a new job.
    if (cur && cur.bullets.length > 0 && !DATE_RANGE.test(line) && !/\s\|\s/.test(line)) {
      cur.bullets[cur.bullets.length - 1] += ' ' + line;
      continue;
    }
    cur = parseJobHeader(raw);
    jobs.push(cur);
  }
  return jobs;
}

// ── Skills / lists ──────────────────────────────────────────────────────────
function splitItems(s) {
  const parts = /[·•|]/.test(s) ? s.split(/\s*[·•|]\s*/) : s.split(/\s*[,;]\s*/);
  return parts.map(clean).filter(Boolean);
}

function parseSkills(lines) {
  const out = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = clean(stripBullet(raw));
    const m = line.match(/^([^:]{2,45}):\s*(.+)$/);
    if (m) out.push({ category: m[1].trim(), items: splitItems(m[2]) });
    else out.push({ category: '', items: splitItems(line) });
  }
  return out;
}

function parseList(lines) {
  const out = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = clean(stripBullet(raw));
    if (/\s·\s/.test(line)) out.push(...line.split(/\s+·\s+/).map(clean).filter(Boolean));
    else out.push(line);
  }
  return out;
}

const LANGUAGE_HINT = /\b(fluent|native|basic|proficient|intermediate|conversational|beginner|bilingual|advanced|elementary|mother tongue)\b/i;

function parseLangAwards(lines) {
  const languages = [], awards = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = clean(stripBullet(raw));
    const m = line.match(/^(languages?|awards?|honou?rs)\s*:\s*(.+)$/i);
    if (m) {
      const items = splitItems(m[2]);
      (/^lang/i.test(m[1]) ? languages : awards).push(...items);
    } else if (LANGUAGE_HINT.test(line)) {
      languages.push(...splitItems(line));
    } else {
      awards.push(...splitItems(line));
    }
  }
  return { languages, awards };
}

function parseEducation(lines) {
  // Blocks separated by blank lines; first line of a block is the headline.
  const blocks = [];
  let cur = [];
  for (const raw of lines) {
    if (!raw.trim()) { if (cur.length) { blocks.push(cur); cur = []; } continue; }
    cur.push(clean(stripBullet(raw)));
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

// ── Whole document ──────────────────────────────────────────────────────────
function parseResume(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const head = [];
  const sections = [];
  let current = null;
  for (const raw of lines) {
    const sec = sectionKeyFor(raw);
    if (sec) { current = { key: sec.key, title: sec.title, lines: [] }; sections.push(current); continue; }
    if (current) current.lines.push(raw); else head.push(raw);
  }

  const headLines = head.map(clean).filter(Boolean);
  const name = headLines[0] || '';
  let title = '';
  let contactLines = [];
  headLines.slice(1).forEach((l, i) => {
    if (i === 0 && !looksLikeContactLine(l)) title = l;
    else contactLines.push(l);
  });

  const get = key => sections.filter(s => s.key === key);
  const joinLines = key => get(key).flatMap(s => s.lines);

  const la = parseLangAwards(joinLines('langawards'));
  const result = {
    name,
    title,
    contact: parseContactLines(contactLines),
    summary: joinLines('summary').map(clean).filter(Boolean).join(' '),
    jobs: parseExperience(joinLines('experience')),
    skills: parseSkills(joinLines('skills')),
    education: parseEducation(joinLines('education')),
    certs: parseList(joinLines('certs')),
    languages: parseList(joinLines('languages')).concat(la.languages),
    awards: parseList(joinLines('awards')).concat(la.awards),
    other: get('other').map(s => ({ title: s.title, lines: s.lines.filter(l => l.trim()).map(l => clean(stripBullet(l))) }))
  };
  return result;
}

module.exports = { parseResume, parseJobHeader, parseContactLines, parseExperience, parseSkills, parseLangAwards, DATE_RANGE };

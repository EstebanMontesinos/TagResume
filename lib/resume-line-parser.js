// ── Shared resume line-classification + page-budget logic ───────────────────
// Extracted from server.js, where this logic used to be duplicated three
// times (once inline for the 2-page budget check, once in /generate-docx,
// once in /generate-pdf). Any change to how a resume line is classified now
// only needs to happen here.
//
// NOTE on isJobHeader vs isJobLine: these are intentionally two different
// heuristics, not a duplicate pair to merge.
//   - isJobHeader is a loose check (any 4-digit number, or " | ") used only
//     for page-weight budgeting (weighLines/enforeTwoPages), where a false
//     positive just means "treat this line as slightly heavier" — cheap to
//     get approximately right.
//   - isJobLine is a stricter check (a real date range like "2019 - 2022" or
//     "2019 - Present", or " | ") used by the DOCX/PDF generators to decide
//     whether to right-align a date column. A false positive there would
//     visibly misformat a resume line, so it requires a real date pattern.
// Merging them would change rendering behavior that hasn't been asked for,
// so both are kept and exported separately.

const SECTION_HEADERS = [
  'PROFESSIONAL SUMMARY', 'EXPERIENCE', 'SKILLS', 'EDUCATION',
  'CERTIFICATIONS', 'LANGUAGES & AWARDS', 'LANGUAGES', 'AWARDS',
  'SUMMARY', 'WORK EXPERIENCE', 'TECHNICAL SKILLS', 'PROJECTS'
];

const FOOTER_SECTIONS = ['EDUCATION', 'CERTIFICATIONS', 'LANGUAGES & AWARDS', 'LANGUAGES', 'AWARDS'];

const LINES_PER_PAGE = 50;
// Was 70, which silently disagreed with the /analyze prompt's own stated
// target ("aim for 80-92 lines" -- see public/index.html) and with
// LINES_PER_PAGE*2=100. That mismatch meant a resume the AI correctly filled
// to ~80 lines could still get hard-trimmed on download, so the downloaded
// file didn't match what the user saw in the preview. Raised to 92 to match
// the prompt's own target so both layers agree on what "fits 2 pages" means.
const TWO_PAGE_BUDGET = 92; // no mid-sentence cuts -- remove whole lines only

function isSectionHeader(line) {
  const upper = line.trim().toUpperCase();
  return SECTION_HEADERS.some(h => upper === h || upper.startsWith(h + ' '));
}

// Loose heuristic — page-weight budgeting only. See note above.
function isJobHeader(line) {
  const t = line.trim();
  return !/^[•\-\*]/.test(t) && (/\d{4}/.test(t) || t.includes(' | '));
}

// Strict heuristic — DOCX/PDF date-column formatting only. See note above.
function isJobLine(line) {
  return !(/^[\s]*[•\-\*]/.test(line)) &&
    (/\d{4}\s*[–\-]\s*(\d{4}|Present)/i.test(line) || line.includes(' | '));
}

function isBullet(line) {
  return /^[\s]*[•\-\*]\s/.test(line);
}

function weighLines(lines) {
  let w = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { w += 0; continue; }
    if (isSectionHeader(line)) { w += 2.5; continue; }
    if (isJobHeader(line)) { w += 1.5; continue; }
    w += Math.max(1, Math.ceil(line.length / 90));
  }
  return w;
}

// ── Hard 2-page enforcer ─────────────────────────────────────────────────────
// Real Word metrics: Calibri 11pt, 1" margins (1440 twips), Letter page.
// This function was previously written but never invoked by any route in
// server.js — the "hard 2-page enforcer" the README describes did not
// actually run. It is now wired into /generate-docx and /generate-pdf.
function enforeTwoPages(text) {
  const lines = text.split('\n');
  if (weighLines(lines) <= TWO_PAGE_BUDGET) return text;

  const mutable = lines.map(t => ({ text: t, removed: false, protected: false }));

  // Mark protected zones:
  // 1. Everything before the first real section header (name, title,
  //    contact/email/phone) — protected unconditionally by position, NOT by
  //    running isJobHeader's loose heuristic on it. A title line like
  //    "AI Product Engineer | Full Stack Developer" contains a pipe, and a
  //    phone number like "+1 (562) 615-2291" contains a 4-digit run --
  //    isJobHeader would misclassify both as job headers, which then made
  //    the orphaned-job-header cleanup below delete them entirely.
  // 2. Section headers themselves — never removed
  // 3. Everything from EDUCATION onwards (footer must always appear intact)
  let sawFirstSectionHeader = false;
  let inFooter = false;
  for (const item of mutable) {
    const t = item.text.trim();
    if (!t) { item.protected = inFooter; continue; }
    const upper = t.toUpperCase();
    if (FOOTER_SECTIONS.some(s => upper === s || upper.startsWith(s + ' '))) {
      inFooter = true;
    }
    if (inFooter) { item.protected = true; continue; }
    if (isSectionHeader(t)) { sawFirstSectionHeader = true; item.protected = true; continue; } // always keep headers
    if (!sawFirstSectionHeader) { item.protected = true; continue; } // name/title/contact block, by position
    if (isJobHeader(t)) { item.protected = true; continue; }      // always keep job titles
  }

  // Remove content lines bottom-up
  // Skip: protected lines, section headers, job headers, blank lines
  // Priority: remove from oldest jobs (bottom) first, but NEVER the Skills section content
  let skillsStart = -1;
  for (let i = 0; i < mutable.length; i++) {
    const upper = mutable[i].text.trim().toUpperCase();
    if (upper === 'SKILLS' || upper.startsWith('SKILLS ')) {
      skillsStart = i;
      break;
    }
  }

  // Count how many non-removed content lines each job header has
  function contentCountForJob(jobIdx) {
    let count = 0;
    for (let j = jobIdx + 1; j < mutable.length; j++) {
      if (mutable[j].removed) continue;
      const t = mutable[j].text.trim();
      if (!t) continue;
      if (isSectionHeader(t) || isJobHeader(t)) break;
      count++;
    }
    return count;
  }

  while (weighLines(mutable.filter(l => !l.removed).map(l => l.text)) > TWO_PAGE_BUDGET) {
    let removed = false;
    const limit = skillsStart > 0 ? skillsStart - 1 : mutable.length - 1;

    // Find the job header that owns each content line so we can enforce min 1 bullet
    for (let i = limit; i >= 0; i--) {
      const item = mutable[i];
      if (item.removed || item.protected) continue;
      const t = item.text.trim();
      if (!t) continue;

      // Find the job header that owns this line
      let ownerJobIdx = -1;
      for (let k = i - 1; k >= 0; k--) {
        if (mutable[k].removed) continue;
        if (isJobHeader(mutable[k].text.trim())) { ownerJobIdx = k; break; }
        if (isSectionHeader(mutable[k].text.trim())) break;
      }

      // If this job only has 1 content line left, skip — never leave it empty
      if (ownerJobIdx >= 0 && contentCountForJob(ownerJobIdx) <= 1) continue;

      item.removed = true; removed = true; break;
    }
    if (!removed) break;
  }

  // Remove orphaned job headers (job title with no content left underneath)
  for (let i = 0; i < mutable.length; i++) {
    const item = mutable[i];
    if (item.removed || item.protected) continue;
    if (!isJobHeader(item.text.trim())) continue;
    // Check if any non-removed, non-blank content follows before next job/section header
    let hasContent = false;
    for (let j = i + 1; j < mutable.length; j++) {
      if (mutable[j].removed) continue;
      const t = mutable[j].text.trim();
      if (!t) continue;
      if (isSectionHeader(t) || isJobHeader(t)) break; // hit next block
      hasContent = true;
      break;
    }
    if (!hasContent) item.removed = true; // orphaned — remove it
  }

  // Clean up double-blank lines
  const result = mutable.filter(l => !l.removed).map(l => l.text);
  const cleaned = [];
  let lastBlank = false;
  for (const line of result) {
    const blank = !line.trim();
    if (blank && lastBlank) continue;
    cleaned.push(line);
    lastBlank = blank;
  }

  return cleaned.join('\n');
}

module.exports = {
  SECTION_HEADERS,
  FOOTER_SECTIONS,
  LINES_PER_PAGE,
  TWO_PAGE_BUDGET,
  isSectionHeader,
  isJobHeader,
  isJobLine,
  isBullet,
  weighLines,
  enforeTwoPages
};

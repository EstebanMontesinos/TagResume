const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, LevelFormat, BorderStyle, TabStopType
} = require('docx');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static('public'));

// ── Resume Vault ──────────────────────────────────────────────────────────────
const VAULT_FILE = path.join(__dirname, 'vault.json');

function loadVault() {
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); }
  catch { return []; }
}

function saveVault(vault) {
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2));
}

// Save a resume entry to the vault
app.post('/vault/save', (req, res) => {
  try {
    const { company, jobTitle, resumeText, analysisScores, keywords } = req.body;
    if (!company || !resumeText) return res.status(400).json({ error: 'company and resumeText required' });

    const vault = loadVault();
    const entry = {
      id:           Date.now().toString(),
      savedAt:      new Date().toISOString(),
      company:      company.trim(),
      jobTitle:     jobTitle || '',
      resumeText,
      analysisScores: analysisScores || null,
      keywords:     keywords || [],
    };
    vault.unshift(entry); // newest first
    saveVault(vault);
    res.json({ success: true, id: entry.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all vault entries (without full resume text for speed)
app.get('/vault/list', (req, res) => {
  try {
    const vault = loadVault();
    const list = vault.map(({ id, savedAt, company, jobTitle, analysisScores, keywords }) =>
      ({ id, savedAt, company, jobTitle, analysisScores, keywords })
    );
    res.json(list);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single vault entry with full resume text
app.get('/vault/:id', (req, res) => {
  try {
    const vault = loadVault();
    const entry = vault.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a vault entry
app.delete('/vault/:id', (req, res) => {
  try {
    const vault = loadVault();
    const filtered = vault.filter(e => e.id !== req.params.id);
    saveVault(filtered);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Anthropic proxy ──────────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
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
        let raw = block.text.trim()
          .replace(/^```json\s*/,'').replace(/^```/,'').replace(/```$/,'').trim();
        // Escape literal control chars inside JSON string values
        let result = '', inString = false, escaped = false;
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
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
        return { ...block, text: result };
      });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Hard 2-page enforcer ─────────────────────────────────────────────────────
// Real Word metrics: Calibri 11pt, 1" margins (1440 twips), Letter page
//   Page height:      15840 twips
//   Top+bottom margin: 2880 twips  (1440 * 2)
//   Usable height:    12960 twips
//   Normal line (11pt spacing): 220 twips body + 60 after = 280 twips
//   Lines per page:   12960 / 280 = ~46 normal lines
//   2-page budget:    92 line-units
//
// Different elements consume different amounts:
//   blank line        : 0.3  (just spacing, 60/280 * 0.5 approx)
//   section header    : 3.0  (22pt font + rule + spacing before/after)
//   job header        : 2.0  (22pt bold + spacing)
//   bullet line       : 1.0 per 90 chars (wrapping)
//   body text         : 1.0 per 110 chars

// Calibri 11pt, 1" margins (1440 twips each side), Letter page
// Usable height: 15840 - 2880 = 12960 twips
// Body line: 220 twips (11pt) + 30 spacing_after = 250 twips per line
// Lines per page: 12960 / 250 = ~51.8 → use 50 to be safe (adds buffer)
//
// Element costs (in line units):
//   blank         : 0   (spacing collapsed, after:0)
//   section header: 2.5 (20pt font=200tw + before:120 + after:40 + rule = ~360tw / 250)
//   job header    : 1.5 (20pt bold + before:100 + after:20 = ~320tw / 250)
//   bullet        : 1.0 per 95 chars (wrapping at usable width ~8280 twips / ~87 chars)
//   body          : 1.0 per 110 chars

const LINES_PER_PAGE = 50;
const TWO_PAGE_BUDGET = 75; // keepNext adds overhead — tighter budget compensates

const FOOTER_SECTIONS = ['EDUCATION','CERTIFICATIONS','LANGUAGES & AWARDS','LANGUAGES','AWARDS'];

function isSectionHeader(line) {
  const upper = line.trim().toUpperCase();
  return ['PROFESSIONAL SUMMARY','EXPERIENCE','SKILLS','EDUCATION',
          'CERTIFICATIONS','LANGUAGES & AWARDS','LANGUAGES','AWARDS',
          'SUMMARY','WORK EXPERIENCE','TECHNICAL SKILLS','PROJECTS']
    .some(h => upper === h || upper.startsWith(h + ' '));
}
function isJobHeader(line) {
  const t = line.trim();
  return !/^[•\-\*]/.test(t) && (/\d{4}/.test(t) || t.includes(' | '));
}
function weighLines(lines) {
  let w = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line)                 { w += 0;   continue; }
    if (isSectionHeader(line)) { w += 2.5; continue; }
    if (isJobHeader(line))     { w += 1.5; continue; }
    w += Math.max(1, Math.ceil(line.length / 90));
  }
  return w;
}

function enforeTwoPages(text) {
  const lines = text.split('\n');
  if (weighLines(lines) <= TWO_PAGE_BUDGET) return text;

  const mutable = lines.map(t => ({ text: t, removed: false, protected: false }));

  // Mark protected zones:
  // 1. First 3 non-empty lines (name, title, contact)
  // 2. Section headers themselves — never removed
  // 3. Everything from EDUCATION onwards (footer must always appear intact)
  let nonEmptyCount = 0;
  let inFooter = false;
  for (const item of mutable) {
    const t = item.text.trim();
    if (!t) { item.protected = inFooter; continue; }
    const upper = t.toUpperCase();
    if (FOOTER_SECTIONS.some(s => upper === s || upper.startsWith(s + ' '))) {
      inFooter = true;
    }
    if (inFooter) { item.protected = true; continue; }
    if (isSectionHeader(t)) { item.protected = true; continue; }  // always keep headers
    if (isJobHeader(t)) { item.protected = true; continue; }      // always keep job titles
    if (nonEmptyCount < 4) { item.protected = true; }             // name/title/contact/email
    nonEmptyCount++;
  }

  // Step 1: Shorten long lines (>120 chars) by trimming to sentence boundary
  // This condenses without losing whole bullets
  for (const item of mutable) {
    if (item.protected || item.removed) continue;
    const t = item.text.trim();
    if (t.length > 130) {
      // Cut at last comma or space before 120 chars
      let cut = item.text.slice(0, 125);
      const lastComma = cut.lastIndexOf(',');
      const lastSpace = cut.lastIndexOf(' ');
      const cutAt = lastComma > 90 ? lastComma : lastSpace;
      item.text = item.text.slice(0, cutAt).trimEnd() + '.';
    }
  }

  // Step 2: If still over budget, remove content lines bottom-up
  // Skip: protected lines, section headers, job headers, blank lines
  // Priority: remove from oldest jobs (bottom) first, but NEVER the Skills section content
  let inSkills = false;
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
    if (item.removed) continue;
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
    const text = enforeTwoPages(rawText); // hard enforce 2 pages
    const lines = text.split('\n');
    const FONT = 'Calibri';
    const COLOR_NAME = '1F3864';
    const COLOR_HEAD = '2E5496';

    function isSectionHeader(line) {
      const upper = line.trim().toUpperCase();
      return ['PROFESSIONAL SUMMARY','EXPERIENCE','SKILLS','EDUCATION',
              'CERTIFICATIONS','LANGUAGES & AWARDS','LANGUAGES','AWARDS',
              'SUMMARY','WORK EXPERIENCE','TECHNICAL SKILLS','PROJECTS']
        .some(h => upper === h || upper.startsWith(h + ' '));
    }
    function isJobLine(line) {
      return !(/^[\s]*[•\-\*]/.test(line)) &&
        (/\d{4}\s*[–\-]\s*(\d{4}|Present)/i.test(line) || line.includes(' | '));
    }
    function isBullet(line) { return /^[\s]*[•\-\*]\s/.test(line); }

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
        level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
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

// ── PDF generator ────────────────────────────────────────────────────────────
app.post('/generate-pdf', async (req, res) => {
  try {
    const { text: rawText } = req.body;
    const text = enforeTwoPages(rawText); // hard enforce 2 pages
    const lines = text.split('\n');
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resume_optimized.pdf"');
    doc.pipe(res);

    const W = doc.page.width - 112;
    const C = { name: '#1F3864', head: '#2E5496', body: '#1a1a1a', muted: '#555555' };

    function isSectionHeader(line) {
      const upper = line.trim().toUpperCase();
      return ['PROFESSIONAL SUMMARY','EXPERIENCE','SKILLS','EDUCATION',
              'CERTIFICATIONS','LANGUAGES & AWARDS','LANGUAGES','AWARDS',
              'SUMMARY','WORK EXPERIENCE','TECHNICAL SKILLS','PROJECTS']
        .some(h => upper === h || upper.startsWith(h + ' '));
    }
    function isJobLine(line) {
      return !(/^[\s]*[•\-\*]/.test(line)) &&
        (/\d{4}\s*[–\-]\s*(\d{4}|Present)/i.test(line) || line.includes(' | '));
    }
    function isBullet(line) { return /^[\s]*[•\-\*]\s/.test(line); }

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
           .text('\u2022  ' + bulletText, { indent: 10, lineGap: 1.5 });
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

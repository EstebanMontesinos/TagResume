// Renders a parsed resume (see lib/resume-sections.js) as a designed,
// presentation-ready PDF: dark sidebar with optional photo, gold accents,
// two-column layout, Carlito (metric-compatible with Calibri) typography.
// Measurements were taken from the user's reference resume so spacing,
// hierarchy and alignment match it closely.
//
// All text is real, selectable text (not images), so ATS parsers can still
// extract it. Content is never dropped: if the sidebar or main column runs
// long they continue onto page 2.
const PDFDocument = require('pdfkit');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const C = {
  teal: '#1F3B3C', gold: '#B08A3E', ink: '#1A1A1A', body: '#262626',
  muted: '#5A5A5A', side: '#EEF2F2', rule: '#8E8E8E'
};
const PAGE_W = 612, PAGE_H = 792;
const SIDE_W = 200, SIDE_X = 19.1, SIDE_TEXT_W = 162;
const MAIN_X = 223, MAIN_R = 590, MAIN_W = MAIN_R - MAIN_X;
const TOP = 30, BOTTOM = 764;

function layout(data, photoBuffer, s) {
  const doc = new PDFDocument({
    size: 'LETTER', margin: 0, bufferPages: true,
    info: { Title: (data.name || 'Resume') + ' - Resume', Author: data.name || '' }
  });
  doc.registerFont('R', path.join(FONT_DIR, 'Carlito-Regular.ttf'));
  doc.registerFont('B', path.join(FONT_DIR, 'Carlito-Bold.ttf'));
  doc.registerFont('I', path.join(FONT_DIR, 'Carlito-Italic.ttf'));
  doc.registerFont('BI', path.join(FONT_DIR, 'Carlito-BoldItalic.ttf'));

  const paintSidebar = () => {
    doc.save().rect(0, 0, SIDE_W, PAGE_H).fill(C.teal).restore();
  };
  paintSidebar();
  doc.on('pageAdded', paintSidebar);

  const txt = (str, x, y, o) => {
    doc.font(o.font || 'R').fontSize((o.size || 9) * s).fillColor(o.color || C.body);
    doc.text(str, x, y, {
      width: o.width, align: o.align || 'left', lineGap: (o.lineGap || 0) * s,
      characterSpacing: (o.cs || 0) * s, lineBreak: o.lineBreak !== false,
      continued: false
    });
  };
  const hOf = (str, o) => {
    doc.font(o.font || 'R').fontSize((o.size || 9) * s);
    return doc.heightOfString(str, { width: o.width, lineGap: (o.lineGap || 0) * s, characterSpacing: (o.cs || 0) * s });
  };

  // ── Sidebar ────────────────────────────────────────────────────────────────
  let sy = 34 * s;
  let sidePage = 0;
  const sideEnsure = h => {
    if (sy + h > BOTTOM) {
      sidePage++;
      if (sidePage < doc.bufferedPageRange().count) doc.switchToPage(sidePage); else doc.addPage();
      sy = TOP;
    }
  };

  if (photoBuffer) {
    const size = 114, px = (SIDE_W - size) / 2, py = 17;
    try {
      doc.save().rect(px, py, size, size).clip();
      doc.image(photoBuffer, px, py, { cover: [size, size], align: 'center', valign: 'center' });
      doc.restore();
      doc.save().lineWidth(2).strokeColor(C.gold).rect(px - 1, py - 1, size + 2, size + 2).stroke().restore();
      sy = py + size + 22.5;
    } catch (e) { /* unreadable image: skip the photo, keep the layout */ }
  }

  const sideHeading = title => {
    sideEnsure(40 * s);
    txt(title, SIDE_X, sy, { font: 'B', size: 9, color: '#FFFFFF', cs: 0.6, width: SIDE_TEXT_W });
    const ly = sy + 15.5 * s;
    doc.save().lineWidth(0.8).strokeColor(C.gold).moveTo(SIDE_X, ly).lineTo(SIDE_X + SIDE_TEXT_W, ly).stroke().restore();
    sy += 20.5 * s;
  };

  if (data.contact && data.contact.length) {
    sideHeading('CONTACT');
    data.contact.forEach(c => {
      const label = c.label + ': ';
      doc.font('B').fontSize(8 * s);
      const lw = doc.widthOfString(label);
      const valW = SIDE_TEXT_W - lw;
      const h = Math.max(hOf(c.value, { size: 8, width: valW }), 9.76 * s);
      sideEnsure(h);
      txt(label, SIDE_X, sy, { font: 'B', size: 8, color: C.gold, lineBreak: false });
      txt(c.value, SIDE_X + lw, sy, { size: 8, color: C.side, width: valW });
      sy += h + 2.2 * s;
    });
    sy += 6 * s;
  }

  if (data.skills && data.skills.length) {
    sideHeading('SKILLS');
    data.skills.forEach(g => {
      if (g.category) {
        sideEnsure(24 * s);
        txt(g.category, SIDE_X, sy, { font: 'B', size: 8, color: C.gold, width: SIDE_TEXT_W });
        sy += 12.4 * s;
      }
      const line = g.items.join(' · ');
      const h = hOf(line, { size: 8.5, width: SIDE_TEXT_W });
      sideEnsure(h);
      txt(line, SIDE_X, sy, { size: 8.5, color: C.side, width: SIDE_TEXT_W });
      sy += h + 3.6 * s;
    });
    sy += 4 * s;
  }

  if (data.education && data.education.length) {
    sideHeading('EDUCATION');
    data.education.forEach(block => {
      block.forEach((line, i) => {
        const o = { font: i === 0 ? 'B' : 'R', size: 8.5, color: i === 0 ? '#FFFFFF' : C.side, width: SIDE_TEXT_W };
        const h = hOf(line, o);
        sideEnsure(h);
        txt(line, SIDE_X, sy, o);
        sy += h + 1.6 * s;
      });
      sy += 3 * s;
    });
    sy += 4 * s;
  }

  const sideList = (title, items) => {
    if (!items || !items.length) return;
    sideHeading(title);
    items.forEach(it => {
      const h = hOf(it, { size: 8.5, width: SIDE_TEXT_W - 14 });
      sideEnsure(h);
      doc.save().fillColor(C.gold).circle(SIDE_X + 3, sy + 4.8 * s, 1.5 * s).fill().restore();
      txt(it, SIDE_X + 11, sy, { size: 8.5, color: C.side, width: SIDE_TEXT_W - 11 });
      sy += h + 3 * s;
    });
    sy += 6 * s;
  };
  sideList('CERTIFICATIONS', data.certs);
  if (data.languages && data.languages.length) {
    sideHeading('LANGUAGES');
    data.languages.forEach(it => {
      const h = hOf(it, { size: 8.5, width: SIDE_TEXT_W });
      sideEnsure(h);
      txt(it, SIDE_X, sy, { size: 8.5, color: C.side, width: SIDE_TEXT_W });
      sy += h + 2.4 * s;
    });
    sy += 6 * s;
  }
  sideList('AWARDS', data.awards);

  // ── Main column ────────────────────────────────────────────────────────────
  doc.switchToPage(0);
  let page = 0;
  let y = 19 * s;
  const mainEnsure = h => {
    if (y + h > BOTTOM) {
      page++;
      if (page < doc.bufferedPageRange().count) doc.switchToPage(page); else doc.addPage();
      y = TOP;
    }
  };

  if (data.name) {
    txt(data.name.toUpperCase(), MAIN_X, y, { font: 'B', size: 18, color: C.teal, cs: 0.4, width: MAIN_W });
    y += 20.5 * s;
  }
  if (data.title) {
    txt(data.title.toUpperCase(), MAIN_X, y, { font: 'B', size: 8.5, color: C.gold, cs: 1.0, width: MAIN_W });
    y += 18.1 * s;
  }

  const mainHeading = (title, ruleColor) => {
    mainEnsure(48 * s);
    txt(title, MAIN_X, y, { font: 'B', size: 10, color: C.teal, cs: 1.5, width: MAIN_W });
    const ly = y + 15.5 * s;
    doc.save().lineWidth(0.8).strokeColor(ruleColor).moveTo(MAIN_X, ly).lineTo(MAIN_R, ly).stroke().restore();
    y += 21.3 * s;
  };

  if (data.summary) {
    mainHeading('PROFESSIONAL SUMMARY', C.rule);
    const h = hOf(data.summary, { size: 8, width: MAIN_W });
    mainEnsure(h);
    txt(data.summary, MAIN_X, y, { size: 8, color: C.body, width: MAIN_W });
    y += h + 7.7 * s;
  }

  const bulletTriangle = (bx, by) => {
    doc.save().fillColor(C.gold)
      .moveTo(bx, by + 3.1 * s).lineTo(bx, by + 8 * s).lineTo(bx + 4.4 * s, by + 5.55 * s).closePath().fill().restore();
  };

  if (data.jobs && data.jobs.length) {
    mainHeading('EXPERIENCE', C.gold);
    data.jobs.forEach(job => {
      const headline = job.title || job.company;
      const dateW = job.dates ? (doc.font('B').fontSize(8.5 * s), doc.widthOfString(job.dates)) + 8 : 0;
      const leftW = MAIN_W - dateW;
      const firstBulletH = job.bullets.length ? hOf(job.bullets[0], { size: 9, width: MAIN_R - 236.1 }) : 0;
      mainEnsure(13.5 * s + firstBulletH + 4);

      // Title (bold) + company (italic) share one line when they fit; for long
      // headlines step the type down slightly before resorting to a second line.
      let lineH = 12.2 * s;
      const company = job.company ? job.company + (job.extra ? ' \u00B7 ' + job.extra : '') : '';
      let placed = false;
      for (const [ts, cs] of [[10, 9], [9.4, 8.5], [8.8, 8]]) {
        doc.font('B').fontSize(ts * s);
        const tW = doc.widthOfString(headline);
        if (!company || !job.title) {
          if (tW <= leftW) { txt(headline, MAIN_X, y, { font: 'B', size: ts, color: C.ink, width: leftW, lineBreak: false }); placed = true; break; }
          continue;
        }
        doc.font('I').fontSize(cs * s);
        const dashW = doc.widthOfString('  \u2014  ');
        const cW = doc.widthOfString(company);
        if (tW + dashW + cW <= leftW) {
          txt(headline, MAIN_X, y, { font: 'B', size: ts, color: C.ink, width: leftW, lineBreak: false });
          txt('  \u2014  ', MAIN_X + tW, y + 0.4 * s, { size: cs, color: C.muted, lineBreak: false });
          txt(company, MAIN_X + tW + dashW, y + 0.4 * s, { font: 'I', size: cs, color: C.muted, lineBreak: false });
          placed = true; break;
        }
      }
      if (!placed) {
        txt(headline, MAIN_X, y, { font: 'B', size: 10, color: C.ink, width: leftW });
        lineH = hOf(headline, { font: 'B', size: 10, width: leftW });
        if (company) {
          txt(company, MAIN_X, y + lineH, { font: 'I', size: 9, color: C.muted, width: leftW, lineBreak: false });
          lineH += 11 * s;
        }
      }
      if (job.dates) {
        txt(job.dates, MAIN_R - dateW + 8, y + 1.5 * s, { font: 'B', size: 8.5, color: C.muted, width: dateW - 8, align: 'right', lineBreak: false });
      }
      y += lineH + 1.5 * s;

      job.bullets.forEach(b => {
        const h = hOf(b, { size: 9, width: MAIN_R - 236.1 });
        mainEnsure(h);
        bulletTriangle(227.1, y);
        txt(b, 236.1, y, { size: 9, color: C.body, width: MAIN_R - 236.1 });
        y += h + 1.4 * s;
      });
      y += 3.5 * s;
    });
  }

  (data.other || []).forEach(sec => {
    if (!sec.lines.length) return;
    y += 4 * s;
    mainHeading(sec.title, C.gold);
    sec.lines.forEach(l => {
      const h = hOf(l, { size: 9, width: MAIN_R - 236.1 });
      mainEnsure(h);
      bulletTriangle(227.1, y);
      txt(l, 236.1, y, { size: 9, color: C.body, width: MAIN_R - 236.1 });
      y += h + 1.7 * s;
    });
  });

  return doc;
}

// Renders to a Buffer. If the content runs past two pages, retries at a
// slightly smaller scale (down to 0.86) before accepting a third page.
function renderDesignedResume(data, opts) {
  opts = opts || {};
  let photo = null;
  if (opts.photoDataUrl) {
    const m = /^data:image\/(?:jpeg|jpg|png);base64,(.+)$/i.exec(opts.photoDataUrl);
    if (m) photo = Buffer.from(m[1], 'base64');
  }
  const scales = opts.scale ? [opts.scale] : [1, 0.96, 0.92, 0.88, 0.86];
  return new Promise((resolve, reject) => {
    let i = 0;
    const attempt = () => {
      const s = scales[i];
      const doc = layout(data, photo, s);
      const pages = doc.bufferedPageRange().count;
      if (pages > 2 && i < scales.length - 1) {
        i++;
        doc.on('data', () => {}); doc.end(); // discard this attempt
        return attempt();
      }
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages, scale: s }));
      doc.on('error', reject);
      doc.end();
    };
    try { attempt(); } catch (e) { reject(e); }
  });
}

module.exports = { renderDesignedResume };

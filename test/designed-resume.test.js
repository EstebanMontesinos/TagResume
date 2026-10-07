// Tests for the designed-resume pipeline: lib/resume-sections.js (parsing the
// Optimizer's plain-text output) and lib/designed-resume-pdf.js (rendering).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResume, parseJobHeader, parseContactLines } = require('../lib/resume-sections');
const { renderDesignedResume } = require('../lib/designed-resume-pdf');

const SAMPLE = `ESTEBAN MONTESINOS
Full Stack AI Product Engineer
+1 (562) 615-2291 | me@example.com | example.org

PROFESSIONAL SUMMARY
Builds things.

EXPERIENCE
Spark Byte Solutions | AI Product Engineer & Consultant | Jul 2022 – Present
• Built pipelines
• Shipped features
Deloitte | Analyst | Jun 2019 – Dec 2019
• Closed deals

SKILLS
Frontend: JavaScript · React
Backend: Node.js · PostgreSQL

EDUCATION
BS Computer Science — Cybersecurity
Western Colorado University

CERTIFICATIONS
UiPath Certified Developer · Blue Prism Certified Developer

LANGUAGES & AWARDS
Languages: English & Spanish (Fluent) · French (Basic)
Awards: Dean's List · COSGC Award`;

test('parseResume splits header, contact, jobs, skills, lists', () => {
  const d = parseResume(SAMPLE);
  assert.equal(d.name, 'ESTEBAN MONTESINOS');
  assert.equal(d.title, 'Full Stack AI Product Engineer');
  assert.deepEqual(d.contact.map(c => c.label), ['Phone', 'Email', 'Web']);
  assert.equal(d.jobs.length, 2);
  assert.equal(d.jobs[0].company, 'Spark Byte Solutions');
  assert.equal(d.jobs[0].title, 'AI Product Engineer & Consultant');
  assert.equal(d.jobs[0].dates, 'Jul 2022 – Present');
  assert.equal(d.jobs[0].bullets.length, 2);
  assert.deepEqual(d.skills[0], { category: 'Frontend', items: ['JavaScript', 'React'] });
  assert.deepEqual(d.certs, ['UiPath Certified Developer', 'Blue Prism Certified Developer']);
  assert.deepEqual(d.languages, ['English & Spanish (Fluent)', 'French (Basic)']);
  assert.deepEqual(d.awards, ["Dean's List", 'COSGC Award']);
});

test('parseJobHeader handles "Title — Company  dates" and pipe layouts', () => {
  const a = parseJobHeader('Business Development Analyst — Deloitte   Jun 2019 – Dec 2019');
  assert.equal(a.title, 'Business Development Analyst');
  assert.equal(a.company, 'Deloitte');
  assert.equal(a.dates, 'Jun 2019 – Dec 2019');
  const b = parseJobHeader('Acme Corp | Senior Engineer  2019 - Present');
  assert.equal(b.company, 'Acme Corp');
  assert.equal(b.title, 'Senior Engineer');
  assert.match(b.dates, /2019 . Present/);
});

test('a title line is not mistaken for contact info, and a missing title is tolerated', () => {
  const d = parseResume('JANE DOE\njane@example.com | 555-123-4567\n\nEXPERIENCE\nAcme | Dev | 2020 - 2021\n• x');
  assert.equal(d.title, '');
  assert.equal(d.contact.length, 2);
  assert.equal(d.jobs.length, 1);
});

test('wrapped bullet lines are merged, not turned into fake jobs', () => {
  const d = parseResume('A B\n\nEXPERIENCE\nAcme | Dev | 2020 - 2021\n• first part of a bullet\nthat continues here\n• second');
  assert.equal(d.jobs.length, 1);
  assert.equal(d.jobs[0].bullets.length, 2);
  assert.match(d.jobs[0].bullets[0], /continues here/);
});

test('parseContactLines classifies and de-duplicates', () => {
  const c = parseContactLines(['Phone: +1 555 123 4567 · me@x.com · linkedin.com/in/me · me@x.com']);
  assert.deepEqual(c.map(x => x.label), ['Phone', 'Email', 'LinkedIn']);
});

test('renderDesignedResume produces a valid PDF within two pages', async () => {
  const out = await renderDesignedResume(parseResume(SAMPLE), {});
  assert.equal(out.buffer.slice(0, 5).toString(), '%PDF-');
  assert.ok(out.pages >= 1 && out.pages <= 2);
});

test('very long resumes shrink to fit two pages instead of spilling to a third', async () => {
  const bullets = Array.from({ length: 5 }, (_, i) =>
    `• Delivered measurable outcome number ${i} across a large enterprise program with many stakeholders and tight deadlines`).join('\n');
  const jobs = Array.from({ length: 7 }, (_, i) => `Company ${i} | Role ${i} | Jan 20${10 + i} – Dec 20${11 + i}\n${bullets}`).join('\n');
  const text = `JANE DOE\nEngineer\n\nEXPERIENCE\n${jobs}\n\nSKILLS\nA: b · c`;
  const out = await renderDesignedResume(parseResume(text), {});
  assert.ok(out.pages <= 2, 'pages=' + out.pages);
});

test('an invalid photo data URL is ignored rather than crashing the render', async () => {
  const out = await renderDesignedResume(parseResume(SAMPLE), { photoDataUrl: 'data:image/jpeg;base64,not-an-image' });
  assert.equal(out.buffer.slice(0, 5).toString(), '%PDF-');
});

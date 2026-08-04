// Tests for lib/resume-line-parser.js, the module extracted from server.js's
// previously-triplicated line-classification logic.
//
// Uses Node's built-in test runner (node:test) so this adds zero new
// dependencies — run with: npm test  (-> node --test test/*.test.js)
// Requires Node.js >= 18.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSectionHeader, isJobHeader, isJobLine, isBullet,
  weighLines, enforeTwoPages, TWO_PAGE_BUDGET
} = require('../lib/resume-line-parser');

test('isSectionHeader matches known headers case-insensitively', () => {
  assert.equal(isSectionHeader('EXPERIENCE'), true);
  assert.equal(isSectionHeader('experience'), true);
  assert.equal(isSectionHeader('SKILLS'), true);
  assert.equal(isSectionHeader('Professional Summary'), true);
  assert.equal(isSectionHeader('Random bullet text'), false);
});

test('isSectionHeader matches a header followed by extra text', () => {
  assert.equal(isSectionHeader('EXPERIENCE (5+ years)'), true);
});

test('isJobHeader (loose, budgeting heuristic) matches any 4-digit year or a pipe', () => {
  assert.equal(isJobHeader('Acme Corp | Senior Engineer'), true);
  assert.equal(isJobHeader('Senior Engineer  2019 - 2022'), true);
  assert.equal(isJobHeader('• Led a team of 5 engineers'), false); // bullets excluded
  assert.equal(isJobHeader('Just some body text with no year'), false);
});

test('isJobLine (strict, formatting heuristic) requires a real date range or a pipe', () => {
  assert.equal(isJobLine('Senior Engineer  2019 - 2022'), true);
  assert.equal(isJobLine('Senior Engineer  2019 - Present'), true);
  assert.equal(isJobLine('Acme Corp | Senior Engineer'), true);
  // isJobLine is stricter than isJobHeader: a bare 4-digit number that
  // isn't a date range shouldn't match.
  assert.equal(isJobLine('Grew revenue by 400% in 2021 alone'), false);
});

test('isBullet matches bullet markers only', () => {
  assert.equal(isBullet('• Did something great'), true);
  assert.equal(isBullet('- Did something great'), true);
  assert.equal(isBullet('Did something great'), false);
});

test('weighLines returns 0 for an empty document', () => {
  assert.equal(weighLines(['', '', '']), 0);
});

test('weighLines weighs section headers and job headers more than plain lines', () => {
  const headerWeight = weighLines(['EXPERIENCE']);
  const jobWeight = weighLines(['Acme Corp | Senior Engineer']);
  const bodyWeight = weighLines(['a']);
  assert.ok(headerWeight > jobWeight);
  assert.ok(jobWeight > bodyWeight);
});

test('enforeTwoPages is a no-op when the resume already fits the budget', () => {
  const shortResume = [
    'Jane Doe',
    'Senior Engineer',
    'jane@example.com',
    '',
    'EXPERIENCE',
    'Acme Corp | Senior Engineer  2019 - Present',
    '• Shipped a thing',
    '',
    'EDUCATION',
    'State University'
  ].join('\n');
  assert.equal(enforeTwoPages(shortResume), shortResume);
});

function makeLongBullets(count) {
  // Each line is padded past 90 chars so it weighs 2 line-units instead of 1,
  // guaranteeing the total exceeds TWO_PAGE_BUDGET (92) and forcing enforeTwoPages
  // to actually remove content rather than being a no-op.
  return Array.from({ length: count }, (_, i) =>
    '• This is a reasonably long accomplishment bullet number ' + i + ' with plenty of extra descriptive detail padded past ninety characters'
  );
}

test('enforeTwoPages trims a resume that exceeds the two-page budget', () => {
  const bullets = makeLongBullets(60);
  const longResume = [
    'Jane Doe',
    'Senior Engineer',
    'jane@example.com',
    '',
    'EXPERIENCE',
    'Acme Corp | Senior Engineer  2019 - Present',
    ...bullets,
    '',
    'EDUCATION',
    'State University'
  ].join('\n');

  // Sanity-check the fixture actually exceeds the budget, otherwise this
  // test would pass for the wrong reason (nothing to trim).
  assert.ok(weighLines(longResume.split('\n')) > TWO_PAGE_BUDGET, 'fixture must exceed the budget for this test to be meaningful');

  const trimmed = enforeTwoPages(longResume);
  const trimmedLines = trimmed.split('\n');

  assert.ok(trimmed.length < longResume.length, 'trimmed output should be shorter');
  assert.ok(weighLines(trimmedLines) <= TWO_PAGE_BUDGET + 1, 'trimmed output should respect the page budget');
});

test('enforeTwoPages never deletes the name/title/contact block, even when the title contains a pipe or the phone number contains a 4-digit run', () => {
  // Regression test for a real bug: isJobHeader's loose heuristic (any
  // 4-digit number, or any " | ") matches a title line like
  // "AI Product Engineer | Full Stack Developer" and a phone number like
  // "+1 (562) 615-2291" (contains the 4-digit run "2291"). That caused the
  // "remove orphaned job headers" pass to misidentify the name/title/contact
  // block as a job header with nothing under it, and delete it outright.
  const bullets = makeLongBullets(60);
  const longResume = [
    'ESTEBAN MONTESINOS',
    'AI Product Engineer | Full Stack Developer',
    '+1 (562) 615-2291 · esteban@example.com · example.org',
    '',
    'PROFESSIONAL SUMMARY',
    'Summary text.',
    '',
    'EXPERIENCE',
    'Acme Corp | Senior Engineer  2019 - Present',
    ...bullets,
    '',
    'EDUCATION',
    'State University'
  ].join('\n');

  assert.ok(weighLines(longResume.split('\n')) > TWO_PAGE_BUDGET, 'fixture must exceed the budget for this test to be meaningful');

  const trimmed = enforeTwoPages(longResume);
  assert.ok(trimmed.includes('ESTEBAN MONTESINOS'), 'name should survive trimming');
  assert.ok(trimmed.includes('AI Product Engineer | Full Stack Developer'), 'title line (with pipe) should survive trimming');
  assert.ok(trimmed.includes('+1 (562) 615-2291'), 'contact line (with 4-digit run) should survive trimming');
});

test('enforeTwoPages never removes protected header/footer content', () => {
  const bullets = makeLongBullets(60);
  const longResume = [
    'Jane Doe',
    'Senior Engineer',
    'jane@example.com',
    '',
    'EXPERIENCE',
    'Acme Corp | Senior Engineer  2019 - Present',
    ...bullets,
    '',
    'EDUCATION',
    'State University',
    'CERTIFICATIONS',
    'PMP'
  ].join('\n');

  const trimmed = enforeTwoPages(longResume);
  assert.ok(trimmed.includes('Jane Doe'));
  assert.ok(trimmed.includes('EDUCATION'));
  assert.ok(trimmed.includes('State University'));
  assert.ok(trimmed.includes('CERTIFICATIONS'));
  assert.ok(trimmed.includes('PMP'));
});

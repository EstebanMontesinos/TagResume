# Semi-Automated Submission — Technical Options (Indeed)

Scope from our last conversation: auto-fill *and* auto-submit, but only for
applications you've explicitly approved in the Tracker first. Target
platform: Indeed.

## The constraint that overrides the architecture choice

Indeed's Terms of Service prohibit using automation, scripts, or bots to
drive the Indeed Apply flow outside of Indeed's own official vendor/API
tooling ([indeed.com/legal](https://www.indeed.com/legal)). Indeed also
states it actively monitors and rate-limits application volume specifically
to catch spam/fraud patterns, which is exactly what a submit-bot produces.
This isn't a gray area in the wording — a script that logs into your
account and submits applications *is* the behavior the clause names,
regardless of whether it runs from your own browser or a server.

Practical risk if this gets built and used: account restriction or
suspension of your own Indeed account, on a platform your job search
depends on. That risk exists under both execution models below — it's not
something a cleverer implementation avoids.

## Option A — Browser extension (runs in your own Chrome)

Fills and submits using your real logged-in Indeed session via a Manifest
V3 extension (content script on the job page + background service worker
talking to your Tracker's API).

- Pros: no separate login/2FA/session handling — it's just your browser;
  reaches the same DOM state a human would see.
- Cons: a second codebase and deployment target entirely separate from the
  current Node/Express app (real build, not an afternoon); still an
  automation pattern Indeed's fraud detection is built to catch, since it's
  the account's *behavior* (click timing, sequencing, volume) that gets
  flagged, not just the code's location.

## Option B — Headless server automation (Playwright/Puppeteer from server.js)

Fits the existing architecture, but has to independently manage your Indeed
login/session server-side.

- Pros: no extension to install or maintain; consistent with how the rest
  of this app is built.
- Cons: storing your Indeed credentials or session cookie on the server is
  its own security liability; breaks immediately on any 2FA or CAPTCHA
  challenge (which Indeed uses specifically to stop this exact thing); and
  headless browsers have well-documented fingerprints that anti-bot systems
  already check for, making this the higher-detection-risk option of the
  two, not the lower one.

## Recommendation

Don't build direct Indeed auto-submit under either model — the ToS
conflict and account risk apply equally to both, and this is the one place
in the whole project where "more automation" trades directly against the
safety of your own job search account.

Two lower-risk paths that get most of the real benefit without crossing
that line:

1. **Stop at the packet, not the click** (already built): Job Inbox scores
   the fit, the Optimizer tailors the resume/cover letter, the Tracker
   holds both plus notes — everything is ready before you open Indeed. The
   only manual step left is the actual click-and-paste, which keeps you
   the one interacting with Indeed's site.
2. **Fill-assist, not fill-and-submit**: a small extension/bookmarklet that
   reads the current application's data from your Tracker and offers to
   paste it into whatever field you're focused on — one click per field or
   per form, driven by you, never queued or run unattended. This stays on
   the "tool that helps a human fill a form" side of the line instead of
   "bot that applies on your behalf," and is a much smaller build than
   either option above.

## Open question for you

Given the ToS conflict: do you want the fill-assist version (safer, smaller
build, no account risk), or do you want to accept the account-risk tradeoff
and proceed with full automation anyway? I'd rather you make that call
explicitly than have me pick a default here.

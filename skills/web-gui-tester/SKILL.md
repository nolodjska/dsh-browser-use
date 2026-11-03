---
name: web-gui-tester
description: "Black-box GUI testing for a web page or local app inside DeepSeek Harness: turn a user-facing requirement into evidence-backed steps, assert visible state, capture screenshots, and report passed/failed/blocked without inventing results. Use with control-browser for any 'does this page actually work' task."
---

# Black-box GUI testing

You are testing what a user can see and do, not what the source implies. Use the
`control-browser` skill for the mechanics (`agent.browsers`, snapshots, locators);
this skill is the discipline around them.

## Before the first click

Write down, in your own notes for this task:

1. **Target** — the exact URL (confirm it loads; a blank page is a result).
2. **Claim under test** — one sentence a user would recognise, e.g. "submitting the
   form shows the new item at the top of the list".
3. **Pass condition** — the visible state that proves it.
4. **Blocker condition** — what would make the test impossible (auth wall, empty
   data set, dead server).

If you cannot state a pass condition you are exploring, not testing — say so.

## Per step

- **One action, then observe.** Never chain three clicks and look once at the end;
  you will not know which one failed.
- **Assert on visible state**: text present, element visible/enabled, URL changed,
  value in a field. Not on logs you cannot see.
- **Capture the evidence when the claim is confirmed**: `tab.screenshot()` emitted
  with `nodeRepl.emitImage` in the same cell, plus the URL and the exact asserted
  text.
- **Record what you actually saw.** If a step did nothing observable, write
  "no observable effect", not "succeeded".

## Verdicts — exactly one of

| Verdict | Means |
|---|---|
| `passed` | the pass condition was observed after a real action |
| `failed` | the action ran and the expected state did not appear |
| `blocked` | the test could not run (server down, auth wall, missing data, pane not paintable) |
| `untested` | not reached yet — do not dress this up as passed |

`blocked` and `untested` are honest results. A green report you cannot back with an
observation is worse than a red one.

## Reporting

For each claim, give: the URL, the steps performed, the text/state you asserted,
the screenshot path, and the verdict. Keep it short enough to read, complete enough
that someone else could re-run it.

Flag explicitly, rather than silently skipping:

- anything the runtime cannot do (file upload, downloads, iframe-internal locators,
  WebM recording);
- anything you had to work around (a collapsed pane, a session-mismatch refusal,
  a page that reloads itself);
- any place where the page looked wrong but the claim still held — that is a
  finding, not a pass.

## Common traps

- **Snapshot drift.** After any action that changes the DOM, old refs are stale;
  re-snapshot instead of clicking a possibly different element.
- **Optimistic waiting.** A fixed `waitForTimeout` can turn a real failure into a
  pass. Prefer waiting for the state you intend to assert.
- **Testing your own assumption.** If the requirement names a label, use that
  label; do not test a synonym you picked.
- **The wrong page.** Confirm `tab.url()` matches the target before every
  assertion; a redirect is a result worth reporting.

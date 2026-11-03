# Recording

Not implemented.

`tab.recording.start()` / `status()` / `cancel()` answer
`capability_unsupported`. There is no screencast transport in this runtime: the
guest is driven over the DevTools Protocol, and producing a WebM would mean running
`Page.startScreencast` plus an encoder, tracking frames, timestamps and output
paths. That is a separate feature with its own failure modes, and shipping a
half-working recorder would be worse than shipping none.

## What to do instead

- For a single moment: `await tab.screenshot()` and `nodeRepl.emitImage(bytes)`.
- For a sequence: take one screenshot per state you care about, each with the URL
  and the asserted state recorded next to it. That is more useful evidence than a
  video nobody scrubs.
- If a user genuinely needs video, an external screen recorder is the honest
  answer; say so rather than improvising.

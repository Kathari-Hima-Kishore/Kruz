# dump/

Scratch space for **Kruz** work. Nothing here is source — it is created on demand
and deleted by hand.

## What belongs here

- **Screenshots for image analysis.** `page.screenshot` can write a PNG/JPEG and
  *also* return the image for visual analysis at the same time:

  ```json
  { "target": { "ref": "e81" }, "type": "png", "path": "dump/card.png" }
  ```

  You still receive the image to look at, and you keep a copy to re-examine later
  without re-driving the browser.

- **Verification captures.** Before/after pairs when checking whether a layout,
  render, or overlay actually changed.

- **Scratch harnesses** for ad-hoc verification against the built `dist`
  (`node dist/mcp/server.js` imported directly, so the stdio transport is not bound).

## What does *not* belong here

Anything that is part of Kruz: source, tests, and the three docs (`SKILL.md`,
`MODEL_GUIDE.md`, `README.md`). If something in here turns out to be worth keeping,
it belongs in `src/` or a real test suite, not here.

## Not in git

`dump/` is gitignored. It will not appear in `git status`, and nothing written here
can be committed by accident.
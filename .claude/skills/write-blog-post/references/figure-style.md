# Blog figure style

Every figure in `packages/web/public/blog/` is a hand-written, self-contained
SVG drawn in one style. The site is dark-only, so figures are dark too.

## Skeleton

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 400" role="img" aria-label="A full sentence-level description of everything the figure shows, for screen readers.">
  <style>
    text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;fill:#e7ebf2}
    .lbl{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;fill:#8892a4;letter-spacing:.02em}
    .k{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
  </style>
  <defs>
    <!-- marker ids must be unique per FILE; use a short per-figure suffix -->
    <marker id="arX" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8892a4"/></marker>
  </defs>
  <rect x="0" y="0" width="720" height="400" fill="#0d0e11"/>
  <!-- content -->
</svg>
```

- Width 640–720. Pick the height to fit the content plus a caption band.
- Always paint the full background `<rect>`.

## Palette

| Role | Colour |
| --- | --- |
| Background | `#0d0e11` |
| Card / panel | `#13151a`, stroke `#2a2d38` |
| Box inside a card | `#1a1d24`, stroke `#2a2d38` |
| Faint guide lines | `#1d2028` |
| Primary text | `#e7ebf2` |
| Secondary text | `#c5ccd6`, `#aeb6c2` |
| Muted labels (`.lbl`) | `#8892a4`, dimmest `#556072` |
| **LoreKit / the highlighted thing** | amber `#f5a623`; a highlighted box is fill `#2a2010` with an amber stroke |
| The contrasting alternative | indigo `#7c8cf8`, light `#aeb9ff` |
| Good / positive | green `#34d399`, light `#7ce6bf` |
| Bad / expiry / removal | red `#f87171` |

Use amber for one thing per figure: the point the reader should notice.

## Type

- `.lbl` (monospace, muted, often uppercase) for section labels, axes, and captions.
- `.k` (monospace) for identifiers: field names, scopes, keys, file names.
- Sans for prose labels inside boxes, at 11–13px. Nothing below 9px.

## Common patterns

- **Side-by-side comparison:** two columns at x≈80 and x≈400, a dashed
  divider at x=360, a coloured `.lbl` heading per column, and a two-line
  centred caption under a rule at the bottom (see
  `structure-vs-similarity.svg`, `export-vs-address.svg`).
- **Record / card:** one big card, `.lbl` zone headings, field names left in
  `.k`, explanations right-aligned in `.lbl` (see `memory-record.svg`).
- **Timeline:** label column on the left, track lines from x=200, filled dots
  for writes, hollow dots for reads, a tinted bar for a window (see
  `forgetting-defaults.svg`).

## Gotchas

- **Don't use symbol glyphs (✕, ✓, emoji) for meaning.** They can fall back to
  a font that ignores `fill`. Draw them with `<path>` (for example, two
  crossing strokes with `stroke-linecap="round"`).
- Monospace text runs about 0.6 × font-size per character. Measure before
  putting it in a box, and render to check.
- Escape `&` as `&amp;` and `>` as `&gt;` in text.

## Embedding

```mdx
<figure>
  <img src="/blog/<name>.svg" alt="What the figure shows, in one or two sentences." width="720" height="400" />
  <figcaption>The takeaway, not just the subject. One to three sentences.</figcaption>
</figure>
```

`width` and `height` must match the `viewBox` so the layout doesn't jump while
the figure loads. Put the figure right after the paragraph it illustrates,
with a blank line on both sides.

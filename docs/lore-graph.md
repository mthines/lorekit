# Lore Graph — the 3D memory map

A WebGL view of an account's lore: every memory a point in space, every scope a
cluster, every relationship a line. This document is the feasibility record and
the design contract — **read it before changing the model, the layout, or the
scene**, because most of the decisions here exist to keep a 5,000-node view at
60 fps and are not obvious from the code alone.

## Is it feasible? Yes — and the reason is the memory cap

The question a 3D graph normally dies on is "how many nodes?", and here it has a
hard answer: a free-plan account is capped at **5,000 active memories**
([limits.md](./limits.md)), enforced by a `BEFORE INSERT` trigger. So the view is
not sizing for an unbounded graph; it is sizing for a known ceiling.

At that ceiling the three costs land like this:

| Cost | At 5,000 memories | Why it is not a problem |
|------|-------------------|-------------------------|
| **Draw calls** | 2 | All memory nodes are one instanced draw; all edges are one `LineSegments`. Draw-call count is independent of node count. |
| **Graph build** | ~30–130 ms, median ~50 ms ([reproduce it](#reproducing-the-build-figure)) | Runs once per dataset change, not per frame, and off the main thread. |
| **Force layout** | the real cost — naive all-pairs repulsion is 25 M interactions/iteration | Solved by not doing it that way: see [Layout](#layout). |
| **Fetching the data** | **the actual bottleneck** | `GET /memories` caps at 100 rows/page, so 5,000 memories is 50 round trips. See [Fetching](#fetching). |

So the honest verdict is: the *rendering* is comfortably feasible, the *layout*
is feasible with the right algorithm, and the *data path* is the part that needs
a server-side answer rather than a client-side one.

## Model — `packages/web/src/lib/lore-graph/`

Pure, dependency-free, unit-tested (`build.spec.ts`). It never imports Three.js,
so the relationship semantics can be reviewed and changed without touching the
renderer.

### Nodes

Two kinds only: **memory** and **scope**. An early sketch added a node per
label, which reads well on a whiteboard and badly on screen — a popular label
becomes a hub every memory is tethered to, and the layout collapses into a
starburst about the label rather than a map of the lore. Labels are edges
between memories instead.

Node identity is the natural key (`scope::key`), not the array index, so a
refetch that re-orders the list does not move the user's selection.

### Edges

Every edge kind is derivable from a single memory row — no extra request, no
server-side join. An edge a user cannot explain by pointing at a field is a
decorative line.

| Kind | Meaning |
|------|---------|
| `scope` | memory → its scope node. The skeleton; never capped away. |
| `label` | two memories share one or more labels. |
| `key` | two memories share a `namespace::` key prefix (`aw-lessons::…`). |
| `repo` | two memories were recorded from the same `origin_repo`. |

Relation strength is the **Jaccard** overlap of the two term sets (shared over
union), scaled by a **per-kind weight**. Two corrections are baked into that
sentence, both of which the first version got wrong:

- Normalising by the *smaller* set instead of the union scores a single-label
  memory as a perfect twin of every memory carrying that label — manufacturing
  exactly the false clusters the view exists to disprove.
- Jaccard alone is **not comparable across kinds.** A key namespace and an
  origin repo contribute exactly one term each, so every such pair scores a
  perfect `1/1` and outranks even a genuine label twin before any budget is
  applied. `KIND_WEIGHT` (`label 1`, `key 0.55`, `repo 0.35`) encodes the actual
  evidence strength: sharing a label vocabulary says something about two
  memories; being written from the same repository is the weakest signal the
  model has, and is already visible from the scope clustering.

The `kinds` option's **order is irrelevant** — the candidate sort is total
(strength, then kind rank, then node indices), so it never depends on which kind
happened to be generated first.

### The three bounds that keep it linear

Applied in this order, each reporting what it dropped in `graph.truncated`:

1. **Hub suppression** (`hubSize`, default 64). A term carried by more than 64
   memories is a *facet*, not a relation — "everything here is a lesson" tells
   you nothing about which two memories relate — and it is also the term whose
   posting list makes the pair count quadratic. One label on 3,000 memories
   would alone yield ~4.5 M pairs. Dropping it removes the cost and the noise in
   one move, which is why it is first rather than a later cap.
2. **Degree cap** (`maxDegree`, default 12) — counted in **distinct neighbours,
   not edges**. Strongest first. A pair that shares a label *and* a key
   namespace *and* a repo produces three edges between the same two nodes;
   spending three of the budget on them would declare a node full after one
   neighbour. What the cap protects is legibility, and a hairball is twelve
   *different* nodes — three parallel lines to one node is a single, slightly
   bolder relationship. So an edge to an already-connected neighbour is free.
3. **Edge budget** (`maxEdges`, default 15,000), strongest first.

`truncated` is not optional decoration: a picture of "the shape of your lore"
that quietly omits half of it is worse than no picture, so the UI must say when
a bound fired.

### Reproducing the build figure

The number above is not folklore — run it yourself:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/bench-lore-graph.mjs --runs 9
```

```text
buildLoreGraph — 5,000 memories, 9 runs
  node       v24.19.0
  min/med/max 30.3 ms / 51.2 ms / 145.4 ms
  nodes      5,025
  edges      20,000
  truncated  [{"of":"edges","total":26008,"kept":15000}]
```

The spread is wide because the harness this was captured on is a shared cloud
container; the shape of the number is what matters — tens of milliseconds, not
seconds, and flat in the node count rather than quadratic.

The benchmark imports the real `build.ts` (Node strips the types; a small
`registerHooks` resolver supplies the `@/` alias), so it can never drift into
measuring a copy. It is **not** a test and gates nothing — a wall-clock
assertion in the suite would be the one check that goes red on a noisy runner
with no code change, and a flaky guard trains everyone to re-run rather than to
read. `build.spec.ts` pins the bounded-output property instead, which is what
would actually regress if an accidental all-pairs path crept back in.

## Layout

**Do not run naive `O(n²)` force-directed layout.** At 5,000 nodes that is 25 M
interactions per iteration and hundreds of iterations to settle.

The design is two-stage:

1. **A deterministic analytic seed.** Scopes are placed on a Fibonacci sphere;
   memories are placed around their scope's centre from a hash of their natural
   key. This is `O(n)`, produces a usable picture on the first frame, and is
   *stable* — the same lore lands in the same place tomorrow, which is what
   makes the view navigable rather than a new abstract painting per visit.
2. **A bounded relaxation pass**, in a Web Worker, using a spatial grid for
   repulsion (never all-pairs), with a fixed iteration budget. It only refines
   the seed, so a slow device that never finishes still shows the right thing.

Positions are `Float32Array`s from end to end — the worker posts a transferable
buffer straight into the GPU attribute, with no per-node object allocation.

## Rendering

Follows `agent-skills`' `animations/rules/three-d.md` and the accessibility floor
in `packages/web/CLAUDE.md`:

- **React Three Fiber**, lazy-loaded (`React.lazy` + `Suspense`). Three.js is
  ~150 KB gzipped and must not enter the dashboard's initial bundle — the view is
  opt-in, so the cost is opt-in too.
- **Instanced.** One `InstancedMesh` for nodes, one `LineSegments` for edges.
- **`frameloop="demand"`.** A memory map is static until the user moves it.
  Rendering only on interaction takes idle GPU and battery cost to zero.
- **`dpr={[1, 2]}`** so a 4K display does not shade four times the pixels.
- **Never per-frame React state.** Camera and hover values live in refs, mutated
  inside `useFrame`.
- **`prefers-reduced-motion`** disables auto-rotation and camera easing; the
  scene is still fully usable by dragging.

## Accessibility

A `<canvas>` is opaque to assistive technology, so the 3D view can never be the
only way to reach a memory. The rules:

- The graph is a **second view of the existing Lore Explorer list**, toggled, not
  a replacement. The list remains the keyboard- and screen-reader-complete path.
- The canvas carries an `aria-hidden="true"` presentation layer with a live
  text summary (node count, scope count, current selection) beside it.
- Selecting a node opens the same `LessonDetailSheet` the list opens, so
  everything reachable in 3D is reachable in 2D.

## Fetching

This is the open constraint, and the one place the view must not take a
shortcut. `GET /memories` returns at most 100 rows per keyset page, so a
whole-account graph is up to 50 round trips.

Two options, in preference order:

1. **A compact server-side projection** (`GET /memories/graph`) returning nodes
   and edges rather than full rows — no `value` bodies, which are the bulk of the
   payload. This is the right long-term answer and follows the package rule that
   *any account-wide aggregate belongs in Postgres behind an endpoint, never a
   `select … limit N` plus a browser-side reduce* (`packages/web/CLAUDE.md`).
2. **A bounded page walk** of the existing endpoint with an explicit cap, the cap
   surfaced in the UI through `graph.truncated`.

What is **not** acceptable is a direct PostgREST query from the dashboard: it
re-implements the tenant scope, archived partition, expiry filter and cursor the
REST handler already owns, and PostgREST truncates silently at its row cap — so
the graph would be quietly wrong for exactly the accounts with the most lore.

## Related

- [limits.md](./limits.md) — the 5,000-memory cap this is sized against.
- [storybook.md](./storybook.md) — how the scene's stories and visual baselines run.
- `packages/web/CLAUDE.md` — the REST-only data-access rule and the motion /
  accessibility conventions.

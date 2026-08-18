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
| **Graph build** | ~80–100 ms (measured, `buildLoreGraph`) | Runs once per dataset change, not per frame. Pure and `Float32Array`-shaped, so it moves to the worker with the layout — see [Layout](#layout). |
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
union). Normalising by the smaller set instead — the obvious first attempt —
scores a single-label memory as a perfect twin of every memory carrying that
label, which manufactures exactly the false clusters the view exists to disprove.

### The three bounds that keep it linear

Applied in this order, each reporting what it dropped in `graph.truncated`:

1. **Hub suppression** (`hubSize`, default 64). A term carried by more than 64
   memories is a *facet*, not a relation — "everything here is a lesson" tells
   you nothing about which two memories relate — and it is also the term whose
   posting list makes the pair count quadratic. One label on 3,000 memories
   would alone yield ~4.5 M pairs. Dropping it removes the cost and the noise in
   one move, which is why it is first rather than a later cap.
2. **Degree cap** (`maxDegree`, default 12). Strongest neighbours first. A
   hairball around one node hides the clustering the view is for.
3. **Edge budget** (`maxEdges`, default 15,000), strongest first.

`truncated` is not optional decoration: a picture of "the shape of your lore"
that quietly omits half of it is worse than no picture, so the UI must say when
a bound fired.

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

**At the 5,000-memory ceiling**, the seed is effectively free and relaxation
costs ~10-15 ms per iteration on a developer machine — so a 30-iteration pass is
~300-450 ms and the 120-iteration default is a second or two.

Those are observations, not a contract. What `layout.spec.ts` actually *asserts*
is a ceiling of **100 ms per iteration** (a 30-iteration pass under 3 s), which
is ~7× the observed cost so a slow shared CI runner does not go red on load
alone. That gap is deliberate and the guarantee still holds: the regression the
budget exists to catch is an accidental all-pairs path, which at 5,000 nodes is
~1000× the work, not 7×.

Both stages are intended to run in a Web Worker off the main thread — the
`Float32Array` shape above is what makes that transfer free — but the worker
itself is not part of this module; it lands with the R3F scene. Either way both
stages refine an already-correct picture, so the view is interactive from the
first frame.

Two properties the specs pin, because they are what make the view usable rather
than merely fast:

- **Scope nodes are pinned.** The relaxation moves memories, never scopes.
  Scopes are the map's landmarks, and a simulation free to drift them turns
  every refetch into a re-orientation exercise. It also makes the system
  trivially stable — every memory is attracted to a fixed anchor, so there is no
  global rotation or collapse for damping to fight.
- **No randomness anywhere**, including the nudge that separates two exactly
  coincident nodes. A layout seeded from `Math.random()` is a different picture
  every visit, which costs the user the one thing a spatial view is for:
  recognising where things are. A new memory fixes its bearing from its scope
  centre for good; only the cluster's radius breathes as it grows.

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

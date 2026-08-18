'use client';

/**
 * The WebGL half of the Lore Graph — the only file in the feature that imports
 * Three.js, and the only one loaded lazily.
 *
 * Everything it draws was computed elsewhere: the graph by
 * `lib/lore-graph/build.ts`, the positions by the layout worker, the colour and
 * radius buffers by `lib/lore-graph/attributes.ts`. This component's whole job
 * is to get those arrays onto the GPU and turn a click into a node id, which is
 * why it has no tests of its own and the four modules behind it have eighty.
 *
 * ## The rules this scene is built to (agent-skills `animations/rules/three-d.md`)
 *
 * - **Two draw calls, whatever the account size.** One `instancedMesh` for every
 *   node, one `lineSegments` for every edge. A `<mesh>` per memory would be
 *   5,000 draws and a dead frame budget.
 * - **`frameloop="demand"`.** A memory map is static until someone moves it.
 *   Rendering only on interaction takes idle GPU and battery to zero — which
 *   matters because this view lives on a dashboard people leave open.
 * - **No per-frame React state.** Hover is the one piece of interaction state,
 *   and it is set only when the hovered instance actually CHANGES, not on every
 *   pointer move.
 * - **`dpr={[1, 2]}`** so a 4K display does not shade four times the pixels.
 * - **`prefers-reduced-motion` removes the inertia**, not the interaction: with
 *   damping off the camera stops the instant the pointer does, which is the
 *   difference between a control and a drifting scene.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useReducedMotion } from 'motion/react';
import {
  edgeColors,
  edgePositions,
  framingDistance,
  nodeColors,
  nodeRadii,
} from '@/lib/lore-graph/attributes';
import { boundingRadius } from '@/lib/lore-graph/layout';
import { EDGE_HEX, hexToRgb, SELECTION_HEX } from '@/lib/lore-graph/palette';
import type { LoreGraph } from '@/lib/lore-graph/types';

export interface LoreGraphSceneProps {
  graph: LoreGraph;
  /** `x, y, z` per node, in `graph.nodes` order. */
  positions: Float32Array;
  /** Node id of the current selection, or null. */
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  /** Node id under the pointer, or null when it leaves. */
  onHover: (nodeId: string | null) => void;
}

const EDGE_RGB = hexToRgb(EDGE_HEX);
const SELECTION_COLOR = new THREE.Color(SELECTION_HEX);

/** A unit sphere, deliberately low-poly: at these radii nobody counts facets. */
const NODE_SEGMENTS = { width: 10, height: 8 } as const;

function Nodes({
  graph,
  positions,
  onSelect,
  onHover,
}: Omit<LoreGraphSceneProps, 'selectedId'>) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((state) => state.invalidate);
  const hovered = useRef<number | null>(null);

  const radii = useMemo(() => nodeRadii(graph), [graph]);
  const colors = useMemo(() => nodeColors(graph), [graph]);

  // `useLayoutEffect`, not `useEffect`: the matrices must be written before the
  // browser paints, or the first frame shows every instance stacked at the
  // origin — a visible flash of a black hole on every rebuild.
  useLayoutEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;

    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    // One scratch colour for the whole rebuild, like the scratch matrix and
    // vectors above: `setColorAt` copies into the instance buffer, so the
    // object is never retained and a per-instance `new THREE.Color` would only
    // hand the GC 5,000 corpses per rebuild.
    const colour = new THREE.Color();

    for (let i = 0; i < graph.nodes.length; i++) {
      position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      scale.setScalar(radii[i]);
      instanced.setMatrixAt(i, matrix.compose(position, rotation, scale));
      instanced.setColorAt(i, colour.setRGB(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]));
    }

    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    // The bounding sphere is what the raycaster tests first; a stale one from
    // the previous layout makes nodes un-clickable in a region of the screen.
    instanced.computeBoundingSphere();
    invalidate();
  }, [graph, positions, radii, colors, invalidate]);

  const handleMove = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const instance = event.instanceId ?? null;
    // Only react when the hovered instance actually changes. Firing a state
    // update per pointer-move event would re-render the tree at pointer rate,
    // which is the single most common way an R3F scene gets slow.
    if (instance === hovered.current) return;
    hovered.current = instance;
    onHover(instance === null ? null : graph.nodes[instance].id);
    invalidate();
  };

  const handleLeave = () => {
    if (hovered.current === null) return;
    hovered.current = null;
    onHover(null);
    invalidate();
  };

  return (
    <instancedMesh
      // Remounting on a node-count change is deliberate: an InstancedMesh's
      // count is fixed at construction, and reusing one across a resize leaves
      // stale instances drawn at the origin.
      key={graph.nodes.length}
      ref={mesh}
      args={[undefined, undefined, Math.max(graph.nodes.length, 1)]}
      onPointerMove={handleMove}
      onPointerOut={handleLeave}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        if (event.instanceId !== undefined) onSelect(graph.nodes[event.instanceId].id);
      }}
    >
      <sphereGeometry args={[1, NODE_SEGMENTS.width, NODE_SEGMENTS.height]} />
      {/* Unlit on purpose: no lights to place, no per-fragment lighting maths,
          and flat discs of scope colour against a near-black field is exactly
          the star-chart reading this view wants. */}
      <meshBasicMaterial vertexColors toneMapped={false} />
    </instancedMesh>
  );
}

function Edges({ graph, positions }: Pick<LoreGraphSceneProps, 'graph' | 'positions'>) {
  const geometry = useRef<THREE.BufferGeometry>(null);
  const invalidate = useThree((state) => state.invalidate);

  const vertices = useMemo(() => edgePositions(graph, positions), [graph, positions]);
  const colors = useMemo(() => edgeColors(graph, EDGE_RGB), [graph]);

  useLayoutEffect(() => {
    const buffer = geometry.current;
    if (!buffer) return;
    buffer.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    buffer.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    buffer.computeBoundingSphere();
    invalidate();
  }, [vertices, colors, invalidate]);

  return (
    <lineSegments frustumCulled={false}>
      <bufferGeometry ref={geometry} />
      {/* Additive blending is what lets one material carry per-edge weight —
          the opacity is pre-multiplied into the vertex colour. See
          `edgeColors`. `depthWrite` off so edges never occlude the nodes they
          connect. */}
      <lineBasicMaterial
        vertexColors
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </lineSegments>
  );
}

/** A wireframe shell around the selected node — readable from any angle, no billboarding. */
function Selection({
  graph,
  positions,
  selectedId,
}: Pick<LoreGraphSceneProps, 'graph' | 'positions' | 'selectedId'>) {
  const invalidate = useThree((state) => state.invalidate);
  const index = useMemo(
    () => (selectedId ? graph.nodes.findIndex((node) => node.id === selectedId) : -1),
    [graph, selectedId],
  );
  // Memoised for the same reason `Nodes` memoises it: this component re-renders
  // on every hover, and `nodeRadii` rebuilds the whole per-node array. Declared
  // above the early return so the hook order never depends on the selection.
  const radii = useMemo(() => nodeRadii(graph), [graph]);

  useEffect(() => invalidate(), [index, invalidate]);
  if (index < 0) return null;

  const radius = radii[index] * 1.8;
  return (
    <mesh
      position={[positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]]}
      raycast={() => null}
    >
      <sphereGeometry args={[radius, 16, 12]} />
      <meshBasicMaterial color={SELECTION_COLOR} wireframe toneMapped={false} transparent opacity={0.9} />
    </mesh>
  );
}

/**
 * Frame the whole graph.
 *
 * Solved from the bounding radius rather than animated with a "zoom to fit", so
 * a two-node account and a five-thousand-node one are both correctly framed on
 * the first frame — no transition the user has to sit through before they can
 * read anything.
 */
function Framing({ positions }: { positions: Float32Array }) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const framed = useRef(false);

  useEffect(() => {
    if (framed.current || positions.length === 0) return;
    framed.current = true;
    camera.position.set(0, 0, framingDistance(boundingRadius(positions)));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [positions, camera, invalidate]);

  return null;
}

export default function LoreGraphScene({
  graph,
  positions,
  selectedId,
  onSelect,
  onHover,
}: LoreGraphSceneProps) {
  const reduceMotion = useReducedMotion();

  // Positions arrive from the worker; until the first report there is nothing
  // to place, and drawing an empty instanced mesh at the origin looks broken.
  // Derived during render rather than mirrored into state by an effect: it is a
  // pure function of the two props, so state would only lag a commit behind its
  // own inputs and cost an extra render pass on every rebuild.
  const ready = positions.length === graph.nodes.length * 3;

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      camera={{ fov: 50, near: 0.1, far: 4_000, position: [0, 0, 200] }}
      // The canvas conveys nothing a screen reader can use; the equivalent is
      // the live summary and the list view beside it. See `LoreGraphView`.
      aria-hidden="true"
    >
      {ready && (
        <>
          <Framing positions={positions} />
          <Edges graph={graph} positions={positions} />
          <Nodes graph={graph} positions={positions} onSelect={onSelect} onHover={onHover} />
          <Selection graph={graph} positions={positions} selectedId={selectedId} />
        </>
      )}
      <OrbitControls
        makeDefault
        enablePan={false}
        // Inertia is a nicety that becomes motion sickness for a reader who
        // asked for less of it. The control still works — it just stops when
        // the pointer does.
        enableDamping={!reduceMotion}
        dampingFactor={0.08}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
      />
    </Canvas>
  );
}

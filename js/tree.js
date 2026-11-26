/**
 * Pure recursive fractal tree generator (no DOM or Canvas drawing).
 * Produces an ordered list of branch growth events suitable for both
 * visual animation and future musical sequencing.
 */

const DEFAULT_TRUNK_LENGTH = 100;
const DEFAULT_BASE_DURATION = 0.95; // seconds at 1.0x speed

/**
 * Clamp a numeric value within [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert degrees to radians.
 * @param {number} degrees
 * @returns {number}
 */
export function degToRad(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Hash an arbitrary numeric seed into a well-distributed 32-bit unsigned integer.
 * @param {number} seed
 * @returns {number}
 */
function hashSeed(seed) {
  let h = (Math.trunc(Number(seed)) >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Create a deterministic PRNG (Mulberry32) when a seed is provided,
 * or fall back to Math.random when seed is omitted/null/empty.
 * @param {number | string | null | undefined} seed
 * @returns {() => number}
 */
export function createSeededRandom(seed) {
  if (seed === undefined || seed === null || seed === '' || Number.isNaN(Number(seed))) {
    return () => Math.random();
  }

  let state = hashSeed(seed);
  return function nextRandom() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a binary fractal tree recursively and return an ordered list of branch events.
 *
 * Coordinate convention:
 * - Trunk originates at (0, 0) growing upward (angle = -Math.PI / 2).
 * - Each child starts growing only after its parent finishes:
 *   child.startTime >= parent.startTime + parent.duration.
 *
 * @param {Object} [options]
 * @param {number} [options.depth=7] Recursion depth from 1 to 10.
 * @param {number} [options.branchAngle=25] Branching angle in degrees (10 to 60).
 * @param {number} [options.lengthRatio=0.72] Child-to-parent length ratio (0.5 to 0.8).
 * @param {number} [options.randomness=0.2] Organic variation factor (0 to 1).
 * @param {number|null} [options.seed] Optional numeric seed for reproducible trees.
 * @param {number} [options.trunkLength=100] Canonical trunk length.
 * @param {number} [options.baseDuration=0.95] Base trunk growth duration in seconds.
 * @returns {Array<Object>} Chronologically ordered branch events.
 */
export function generateFractalTree(options = {}) {
  const maxDepth = Math.round(clamp(Number(options.depth ?? 7), 1, 10));
  const branchAngleDeg = clamp(Number(options.branchAngle ?? 25), 10, 60);
  const lengthRatio = clamp(Number(options.lengthRatio ?? 0.72), 0.5, 0.8);
  const randomness = clamp(Number(options.randomness ?? 0.2), 0, 1);
  const trunkLength = Number(options.trunkLength ?? DEFAULT_TRUNK_LENGTH);
  const baseDuration = Number(options.baseDuration ?? DEFAULT_BASE_DURATION);

  const rand = createSeededRandom(options.seed);
  const randomSigned = () => rand() * 2 - 1;
  const baseAngleRad = degToRad(branchAngleDeg);

  const events = [];
  let nextId = 1;

  /**
   * Recursively build branch events from trunk to leaves.
   * Base case: depth >= maxDepth marks the branch as a leaf and terminates recursion.
   */
  function buildBranch({
    parentId,
    depth,
    startX,
    startY,
    length,
    angle,
    side,
    startTime,
  }) {
    const id = nextId++;
    const endX = startX + Math.cos(angle) * length;
    const endY = startY + Math.sin(angle) * length;
    const isLeaf = depth >= maxDepth;

    // Scale duration gently by branch length so shorter outer twigs grow briskly
    // while keeping total growth calm and staggered when organic variation is present.
    const lengthFactor = Math.pow(Math.max(0.05, length / trunkLength), 0.45);
    const duration = Math.max(0.16, Number((baseDuration * lengthFactor).toFixed(4)));

    events.push({
      id,
      parentId,
      depth,
      startX,
      startY,
      endX,
      endY,
      length,
      angle,
      side,
      isLeaf,
      startTime,
      duration,
    });

    // Clear base case: outer leaf branch has no children.
    if (isLeaf) {
      return;
    }

    // Children begin only after their parent finishes growing.
    const childStartTime = startTime + duration;
    const childDepth = depth + 1;

    for (const childSide of ['left', 'right']) {
      const direction = childSide === 'left' ? -1 : 1;
      const spreadJitter = 1 + randomSigned() * 0.35 * randomness;
      const swayJitter = randomSigned() * degToRad(6) * randomness;
      const childAngle = angle + direction * baseAngleRad * spreadJitter + swayJitter;

      const ratioJitter = 1 + randomSigned() * 0.22 * randomness;
      const effectiveRatio = clamp(lengthRatio * ratioJitter, 0.38, 0.9);
      const childLength = length * effectiveRatio;

      buildBranch({
        parentId: id,
        depth: childDepth,
        startX: endX,
        startY: endY,
        length: childLength,
        angle: childAngle,
        side: childSide,
        startTime: childStartTime,
      });
    }
  }

  const trunkAngle = -Math.PI / 2 + randomSigned() * degToRad(5) * randomness;
  const initialLength = trunkLength * (1 + randomSigned() * 0.08 * randomness);

  buildBranch({
    parentId: null,
    depth: 1,
    startX: 0,
    startY: 0,
    length: initialLength,
    angle: trunkAngle,
    side: 'trunk',
    startTime: 0,
  });

  // Sort strictly by startTime so downstream animation and audio schedulers
  // can iterate chronologically.
  events.sort((a, b) => a.startTime - b.startTime || a.depth - b.depth || a.id - b.id);

  return events;
}

/**
 * Compute bounding box of a generated branch event list.
 * @param {Array<Object>} events
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number, width: number, height: number }}
 */
export function getTreeBounds(events) {
  if (!events || events.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const branch of events) {
    if (branch.startX < minX) minX = branch.startX;
    if (branch.startX > maxX) maxX = branch.startX;
    if (branch.endX < minX) minX = branch.endX;
    if (branch.endX > maxX) maxX = branch.endX;

    if (branch.startY < minY) minY = branch.startY;
    if (branch.startY > maxY) maxY = branch.startY;
    if (branch.endY < minY) minY = branch.endY;
    if (branch.endY > maxY) maxY = branch.endY;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Compute total 1.0x playback duration (in seconds) until the final leaf finishes.
 * @param {Array<Object>} events
 * @returns {number}
 */
export function getTreeTotalDuration(events) {
  let maxEnd = 0;
  for (const branch of events) {
    const end = branch.startTime + branch.duration;
    if (end > maxEnd) {
      maxEnd = end;
    }
  }
  return maxEnd;
}

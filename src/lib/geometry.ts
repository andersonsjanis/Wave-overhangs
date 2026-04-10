import type { Bounds, ToolpathSegment } from '../types/gcode';

const EPSILON = 1e-6;

export function segmentLength(
  segment: Pick<ToolpathSegment, 'x1' | 'y1' | 'x2' | 'y2'>
): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

export function pointOnSegment(
  segment: Pick<ToolpathSegment, 'x1' | 'y1' | 'x2' | 'y2'>,
  t: number
) {
  return {
    x: segment.x1 + (segment.x2 - segment.x1) * t,
    y: segment.y1 + (segment.y2 - segment.y1) * t
  };
}

export function distancePointToSegment(
  point: { x: number; y: number },
  segment: Pick<ToolpathSegment, 'x1' | 'y1' | 'x2' | 'y2'>
): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared < EPSILON) {
    return Math.hypot(point.x - segment.x1, point.y - segment.y1);
  }

  const projection =
    ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, projection));
  const closestX = segment.x1 + clamped * dx;
  const closestY = segment.y1 + clamped * dy;

  return Math.hypot(point.x - closestX, point.y - closestY);
}

export function createBoundsFromSegments(
  segments: Array<Pick<ToolpathSegment, 'x1' | 'y1' | 'x2' | 'y2'>>
): Bounds | null {
  if (segments.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    minX = Math.min(minX, segment.x1, segment.x2);
    minY = Math.min(minY, segment.y1, segment.y2);
    maxX = Math.max(maxX, segment.x1, segment.x2);
    maxY = Math.max(maxY, segment.y1, segment.y2);
  }

  return { minX, minY, maxX, maxY };
}

export function mergeBounds(boundsList: Array<Bounds | null>): Bounds | null {
  const definedBounds = boundsList.filter((bounds): bounds is Bounds => Boolean(bounds));

  if (definedBounds.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const bounds of definedBounds) {
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }

  return { minX, minY, maxX, maxY };
}

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  };
}

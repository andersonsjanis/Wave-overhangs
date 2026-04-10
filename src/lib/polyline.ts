import type { Coordinate, LinePart } from '../types/gcode';

function segmentEndpointKey(x: number, y: number) {
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

export function splitSegmentsIntoConnectedPolylines(segments: LinePart[]): Coordinate[][] {
  const edges = segments.map((segment, index) => ({
    index,
    startKey: segmentEndpointKey(segment.x1, segment.y1),
    endKey: segmentEndpointKey(segment.x2, segment.y2),
    start: [segment.x1, segment.y1] as Coordinate,
    end: [segment.x2, segment.y2] as Coordinate
  }));
  const edgeIndexesByKey = new Map<string, number[]>();
  const pointByKey = new Map<string, Coordinate>();

  for (const edge of edges) {
    pointByKey.set(edge.startKey, edge.start);
    pointByKey.set(edge.endKey, edge.end);
    edgeIndexesByKey.set(edge.startKey, [
      ...(edgeIndexesByKey.get(edge.startKey) ?? []),
      edge.index
    ]);
    edgeIndexesByKey.set(edge.endKey, [
      ...(edgeIndexesByKey.get(edge.endKey) ?? []),
      edge.index
    ]);
  }

  const unusedEdgeIndexes = new Set(edges.map((edge) => edge.index));
  const polylines: Coordinate[][] = [];

  while (unusedEdgeIndexes.size > 0) {
    const firstEdgeIndex = unusedEdgeIndexes.values().next().value as number;
    const componentEdgeIndexes = new Set<number>();
    const queue = [firstEdgeIndex];

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const edgeIndex = queue[queueIndex];
      if (componentEdgeIndexes.has(edgeIndex)) {
        continue;
      }

      componentEdgeIndexes.add(edgeIndex);
      const edge = edges[edgeIndex];

      for (const key of [edge.startKey, edge.endKey]) {
        for (const neighborIndex of edgeIndexesByKey.get(key) ?? []) {
          if (!componentEdgeIndexes.has(neighborIndex)) {
            queue.push(neighborIndex);
          }
        }
      }
    }

    for (const edgeIndex of componentEdgeIndexes) {
      unusedEdgeIndexes.delete(edgeIndex);
    }

    const degreeByKey = new Map<string, number>();
    for (const edgeIndex of componentEdgeIndexes) {
      const edge = edges[edgeIndex];
      degreeByKey.set(edge.startKey, (degreeByKey.get(edge.startKey) ?? 0) + 1);
      degreeByKey.set(edge.endKey, (degreeByKey.get(edge.endKey) ?? 0) + 1);
    }

    const firstComponentEdge = edges[componentEdgeIndexes.values().next().value as number];
    let currentKey =
      [...degreeByKey.entries()].find(([, degree]) => degree === 1)?.[0] ??
      firstComponentEdge.startKey;
    const usedComponentEdges = new Set<number>();
    const firstPoint = pointByKey.get(currentKey) ?? firstComponentEdge.start;
    const points: Coordinate[] = [firstPoint];

    while (usedComponentEdges.size < componentEdgeIndexes.size) {
      const nextEdgeIndex = (edgeIndexesByKey.get(currentKey) ?? []).find(
        (edgeIndex) =>
          componentEdgeIndexes.has(edgeIndex) && !usedComponentEdges.has(edgeIndex)
      );

      if (nextEdgeIndex === undefined) {
        break;
      }

      usedComponentEdges.add(nextEdgeIndex);
      const edge = edges[nextEdgeIndex];
      const nextPoint = currentKey === edge.startKey ? edge.end : edge.start;
      currentKey = currentKey === edge.startKey ? edge.endKey : edge.startKey;
      points.push(nextPoint);
    }

    if (points.length >= 2) {
      polylines.push(points);
    }
  }

  return polylines;
}

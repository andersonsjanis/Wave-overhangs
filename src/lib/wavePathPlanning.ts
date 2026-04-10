import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import polygonClipping from 'polygon-clipping';
import { DEFAULT_WAVE_PATH_SETTINGS } from './config';
import { distancePointToSegment } from './geometry';
import { splitSegmentsIntoConnectedPolylines } from './polyline';
import type {
  AnalyzedLayerData,
  Coordinate,
  LinePart,
  MultiPolygonShape,
  PolygonRing,
  PolygonShape,
  WaveFidelity,
  WavePathPlan,
  WavePathSettings
} from '../types/gcode';

const EPSILON = 1e-6;
const CIRCLE_SEGMENT_COUNT = 32;
const BOOLEAN_BATCH_SIZE = 1;
const ENABLE_WAVE_TIMING_LOGS = false;
const HUYGENS_LINE_BUFFER_EPS = 1e-6;

interface BoundaryCell {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  centerX: number;
  centerY: number;
}

interface BoundaryGrid {
  cellSize: number;
  cells: BoundaryCell[];
  cellLookup: Map<string, BoundaryCell>;
  minX: number;
  minY: number;
}

type RasterWavefront =
  | { kind: 'line'; segments: LinePart[] }
  | { kind: 'area'; cells: BoundaryCell[] };

function nowMilliseconds() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

function withWaveTiming<T>(label: string, run: () => T) {
  const startedAt = ENABLE_WAVE_TIMING_LOGS ? nowMilliseconds() : 0;
  const result = run();

  if (ENABLE_WAVE_TIMING_LOGS) {
    const elapsed = nowMilliseconds() - startedAt;
    console.debug(`[wave-timing] ${label}: ${elapsed.toFixed(2)}ms`);
  }

  return result;
}

function coordinateKey(x: number, y: number) {
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

function lineLength(line: Pick<LinePart, 'x1' | 'y1' | 'x2' | 'y2'>) {
  return Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
}

function normalizedRasterSubdivisions(settings: WavePathSettings) {
  return Math.max(1, Math.round(settings.rasterSubdivisions ?? 1));
}

function buildBoundaryGrid(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): BoundaryGrid | null {
  const cells: BoundaryCell[] = [];
  const cellMap = new Map<string, BoundaryCell>();
  let detectedCellSize = 0;
  let gridMinX = Number.POSITIVE_INFINITY;
  let gridMinY = Number.POSITIVE_INFINITY;
  const subdivisions = normalizedRasterSubdivisions(settings);

  for (const polygon of layer.overhangRegion) {
    const ring = polygon[0];
    if (!ring || ring.length < 4) {
      continue;
    }

    const xs = ring.map(([x]) => x);
    const ys = ring.map(([, y]) => y);
    const x1 = Math.min(...xs);
    const x2 = Math.max(...xs);
    const y1 = Math.min(...ys);
    const y2 = Math.max(...ys);
    const width = x2 - x1;
    const height = y2 - y1;

    if (width < EPSILON || height < EPSILON) {
      continue;
    }

    detectedCellSize = detectedCellSize || Math.max(width, height);
    const subcellWidth = width / subdivisions;
    const subcellHeight = height / subdivisions;

    for (let row = 0; row < subdivisions; row += 1) {
      for (let col = 0; col < subdivisions; col += 1) {
        const subcellX1 = x1 + col * subcellWidth;
        const subcellY1 = y1 + row * subcellHeight;
        const subcellX2 = subcellX1 + subcellWidth;
        const subcellY2 = subcellY1 + subcellHeight;
        const key = coordinateKey(subcellX1, subcellY1);

        if (cellMap.has(key)) {
          continue;
        }

        const cell: BoundaryCell = {
          key,
          x1: subcellX1,
          y1: subcellY1,
          x2: subcellX2,
          y2: subcellY2,
          centerX: (subcellX1 + subcellX2) / 2,
          centerY: (subcellY1 + subcellY2) / 2
        };

        gridMinX = Math.min(gridMinX, subcellX1);
        gridMinY = Math.min(gridMinY, subcellY1);
        cells.push(cell);
        cellMap.set(key, cell);
      }
    }
  }

  if (cells.length === 0 || detectedCellSize <= 0) {
    return null;
  }

  return {
    cellSize: detectedCellSize / subdivisions,
    cells,
    cellLookup: cellMap,
    minX: gridMinX,
    minY: gridMinY
  };
}

function cellNeighborKey(cell: BoundaryCell, grid: BoundaryGrid, dx: number, dy: number) {
  return coordinateKey(cell.x1 + dx * grid.cellSize, cell.y1 + dy * grid.cellSize);
}

function cellEdgeToLinePart(cell: BoundaryCell, direction: { dx: number; dy: number }): LinePart {
  if (direction.dx < 0) {
    return { x1: cell.x1, y1: cell.y1, x2: cell.x1, y2: cell.y2, length: cell.y2 - cell.y1 };
  }

  if (direction.dx > 0) {
    return { x1: cell.x2, y1: cell.y1, x2: cell.x2, y2: cell.y2, length: cell.y2 - cell.y1 };
  }

  if (direction.dy < 0) {
    return { x1: cell.x1, y1: cell.y1, x2: cell.x2, y2: cell.y1, length: cell.x2 - cell.x1 };
  }

  return { x1: cell.x1, y1: cell.y2, x2: cell.x2, y2: cell.y2, length: cell.x2 - cell.x1 };
}

function mergeAxisAlignedLines(lines: LinePart[]): LinePart[] {
  const horizontal = new Map<string, Array<{ start: number; end: number; y: number }>>();
  const vertical = new Map<string, Array<{ start: number; end: number; x: number }>>();
  const other: LinePart[] = [];

  for (const line of lines) {
    if (Math.abs(line.y1 - line.y2) < EPSILON) {
      const y = line.y1;
      const entries = horizontal.get(y.toFixed(6)) ?? [];
      entries.push({ start: Math.min(line.x1, line.x2), end: Math.max(line.x1, line.x2), y });
      horizontal.set(y.toFixed(6), entries);
    } else if (Math.abs(line.x1 - line.x2) < EPSILON) {
      const x = line.x1;
      const entries = vertical.get(x.toFixed(6)) ?? [];
      entries.push({ start: Math.min(line.y1, line.y2), end: Math.max(line.y1, line.y2), x });
      vertical.set(x.toFixed(6), entries);
    } else {
      other.push(line);
    }
  }

  const merged = [...other];

  for (const entries of horizontal.values()) {
    entries.sort((a, b) => a.start - b.start);
    let current = entries[0];

    for (const entry of entries.slice(1)) {
      if (entry.start <= current.end + EPSILON) {
        current.end = Math.max(current.end, entry.end);
      } else {
        merged.push({
          x1: current.start,
          y1: current.y,
          x2: current.end,
          y2: current.y,
          length: current.end - current.start
        });
        current = entry;
      }
    }

    if (current) {
      merged.push({
        x1: current.start,
        y1: current.y,
        x2: current.end,
        y2: current.y,
        length: current.end - current.start
      });
    }
  }

  for (const entries of vertical.values()) {
    entries.sort((a, b) => a.start - b.start);
    let current = entries[0];

    for (const entry of entries.slice(1)) {
      if (entry.start <= current.end + EPSILON) {
        current.end = Math.max(current.end, entry.end);
      } else {
        merged.push({
          x1: current.x,
          y1: current.start,
          x2: current.x,
          y2: current.end,
          length: current.end - current.start
        });
        current = entry;
      }
    }

    if (current) {
      merged.push({
        x1: current.x,
        y1: current.start,
        x2: current.x,
        y2: current.end,
        length: current.end - current.start
      });
    }
  }

  return merged.filter((line) => line.length > EPSILON);
}

function contourSegmentsForCells(cells: BoundaryCell[], grid: BoundaryGrid) {
  const cellKeys = new Set(cells.map((cell) => cell.key));
  const directions = [
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 }
  ];
  const segments: LinePart[] = [];

  for (const cell of cells) {
    for (const direction of directions) {
      const neighborKey = cellNeighborKey(cell, grid, direction.dx, direction.dy);

      if (!cellKeys.has(neighborKey)) {
        segments.push(cellEdgeToLinePart(cell, direction));
      }
    }
  }

  return mergeAxisAlignedLines(segments);
}

function samplePointsAlongSegments(segments: LinePart[], spacing: number) {
  const safeSpacing = Math.max(spacing, EPSILON);
  const points: Coordinate[] = [];

  for (const segment of segments) {
    const length = lineLength(segment);
    if (length <= EPSILON) {
      continue;
    }

    const steps = Math.max(1, Math.round(length / safeSpacing));
    for (let index = 0; index <= steps; index += 1) {
      const distance = Math.min(index * safeSpacing, length);
      const t = distance / length;
      points.push([
        segment.x1 + (segment.x2 - segment.x1) * t,
        segment.y1 + (segment.y2 - segment.y1) * t
      ]);
    }

    const end: Coordinate = [segment.x2, segment.y2];
    const previous = points[points.length - 1];
    if (!previous || Math.hypot(previous[0] - end[0], previous[1] - end[1]) > EPSILON) {
      points.push(end);
    }
  }

  return points;
}

function emitterSegmentsFromWavefront(wavefront: RasterWavefront, grid: BoundaryGrid) {
  if (wavefront.kind === 'line') {
    return wavefront.segments;
  }

  return contourSegmentsForCells(wavefront.cells, grid);
}

function cellsInsideCircleUnion(points: Coordinate[], grid: BoundaryGrid, radius: number) {
  const candidateCells = new Map<string, BoundaryCell>();
  const cellReach = (Math.SQRT2 * grid.cellSize) / 2;
  const safeRadius = Math.max(radius, 0) + cellReach;

  for (const [x, y] of points) {
    const minColumn = Math.floor((x - safeRadius - grid.minX) / grid.cellSize);
    const maxColumn = Math.floor((x + safeRadius - grid.minX) / grid.cellSize);
    const minRow = Math.floor((y - safeRadius - grid.minY) / grid.cellSize);
    const maxRow = Math.floor((y + safeRadius - grid.minY) / grid.cellSize);

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minColumn; col <= maxColumn; col += 1) {
        const key = coordinateKey(
          grid.minX + col * grid.cellSize,
          grid.minY + row * grid.cellSize
        );
        const cell = grid.cellLookup.get(key);

        if (
          cell &&
          Math.hypot(cell.centerX - x, cell.centerY - y) <= safeRadius
        ) {
          candidateCells.set(cell.key, cell);
        }
      }
    }
  }

  return [...candidateCells.values()];
}

function filterUnfilledCells(candidateCells: BoundaryCell[], filledKeys: Set<string>) {
  return candidateCells.filter((cell) => !filledKeys.has(cell.key));
}

function seedOccupiedCells(grid: BoundaryGrid, seedSegments: LinePart[]) {
  const lineBuffer = Math.max((Math.SQRT2 * grid.cellSize) / 2, EPSILON);

  return grid.cells.filter((cell) =>
    seedSegments.some(
      (segment) =>
        distancePointToSegment({ x: cell.centerX, y: cell.centerY }, segment) <= lineBuffer
    )
  );
}

function forwardContourSegmentsForCells(
  cells: BoundaryCell[],
  grid: BoundaryGrid,
  filledKeys: Set<string>
) {
  const cellKeys = new Set(cells.map((cell) => cell.key));
  const directions = [
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 }
  ];
  const segments: LinePart[] = [];

  for (const cell of cells) {
    for (const direction of directions) {
      const neighborKey = cellNeighborKey(cell, grid, direction.dx, direction.dy);

      if (!cellKeys.has(neighborKey) && !filledKeys.has(neighborKey)) {
        segments.push(cellEdgeToLinePart(cell, direction));
      }
    }
  }

  return mergeAxisAlignedLines(segments);
}

function propagateOneStep(
  emitterSegments: LinePart[],
  filledKeys: Set<string>,
  grid: BoundaryGrid,
  settings: WavePathSettings
) {
  const points = samplePointsAlongSegments(emitterSegments, settings.discretizationDistance);

  if (points.length === 0) {
    return [];
  }

  // Raster equivalent of unioning wavelength-radius circles and clipping to
  // the boundary polygon: only cells from the confirmed boundary grid are tested.
  const propagatedRegion = cellsInsideCircleUnion(points, grid, settings.wavelength);

  return filterUnfilledCells(propagatedRegion, filledKeys);
}

type ClippingGeometry = PolygonShape | MultiPolygonShape;

type VectorWavefront =
  | { kind: 'line'; segments: LinePart[] }
  | { kind: 'area'; geometry: MultiPolygonShape };

function vectorRingArea(ring: PolygonRing) {
  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    area += x1 * y2 - x2 * y1;
  }

  return area / 2;
}

function vectorPolygonArea(polygon: PolygonShape) {
  if (polygon.length === 0) {
    return 0;
  }

  const [outerRing, ...holes] = polygon;
  return (
    Math.abs(vectorRingArea(outerRing)) -
    holes.reduce((total, ring) => total + Math.abs(vectorRingArea(ring)), 0)
  );
}

function vectorMultiPolygonArea(geometry: MultiPolygonShape) {
  return geometry.reduce((total, polygon) => total + vectorPolygonArea(polygon), 0);
}

function closeVectorRing(ring: PolygonRing): PolygonRing {
  if (ring.length === 0) {
    return ring;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (Math.abs(first[0] - last[0]) < EPSILON && Math.abs(first[1] - last[1]) < EPSILON) {
    return ring;
  }

  return [...ring, first];
}

function normalizeVectorGeometry(geometry: MultiPolygonShape): MultiPolygonShape {
  return geometry
    .map((polygon) =>
      polygon
        .map(closeVectorRing)
        .filter((ring) => ring.length >= 4 && Math.abs(vectorRingArea(ring)) > EPSILON)
    )
    .filter((polygon) => polygon.length > 0 && vectorPolygonArea(polygon) > EPSILON);
}

function hasVectorArea(geometry: MultiPolygonShape) {
  return geometry.length > 0 && vectorMultiPolygonArea(geometry) > EPSILON;
}

function isCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

function clippingGeometryToMultiPolygon(geometry: ClippingGeometry): MultiPolygonShape {
  if (geometry.length === 0) {
    return [];
  }

  return isCoordinate((geometry as PolygonShape)[0]?.[0])
    ? [geometry as PolygonShape]
    : (geometry as MultiPolygonShape);
}

function unionVectorGeometries(geometries: ClippingGeometry[]) {
  let result: MultiPolygonShape = [];

  for (let index = 0; index < geometries.length; index += BOOLEAN_BATCH_SIZE) {
    const batch = geometries.slice(index, index + BOOLEAN_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }

    const batchUnion =
      batch.length === 1
        ? normalizeVectorGeometry(clippingGeometryToMultiPolygon(batch[0]))
        : normalizeVectorGeometry(polygonClipping.union(...batch));

    if (!hasVectorArea(batchUnion)) {
      continue;
    }

    result =
      result.length === 0
        ? batchUnion
        : normalizeVectorGeometry(polygonClipping.union(result, batchUnion));
  }

  return result;
}

function intersectVectorGeometries(
  subjectGeometry: MultiPolygonShape,
  clipGeometry: MultiPolygonShape
) {
  if (!hasVectorArea(subjectGeometry) || !hasVectorArea(clipGeometry)) {
    return [];
  }

  return normalizeVectorGeometry(polygonClipping.intersection(subjectGeometry, clipGeometry));
}

function differenceVectorGeometry(
  subjectGeometry: MultiPolygonShape,
  clipGeometry: MultiPolygonShape
) {
  if (!hasVectorArea(subjectGeometry)) {
    return [];
  }

  if (!hasVectorArea(clipGeometry)) {
    return subjectGeometry;
  }

  return normalizeVectorGeometry(polygonClipping.difference(subjectGeometry, clipGeometry));
}

function circlePolygon([centerX, centerY]: Coordinate, radius: number): PolygonShape {
  const ring: PolygonRing = [];

  for (let index = 0; index < CIRCLE_SEGMENT_COUNT; index += 1) {
    const angle = (Math.PI * 2 * index) / CIRCLE_SEGMENT_COUNT;
    ring.push([
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius
    ]);
  }
  ring.push(ring[0]);

  return [ring];
}

function linePartsFromRing(ring: PolygonRing) {
  const segments: LinePart[] = [];

  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    const length = Math.hypot(x2 - x1, y2 - y1);

    if (length > EPSILON) {
      segments.push({ x1, y1, x2, y2, length });
    }
  }

  return segments;
}

function linePartsFromVectorGeometry(geometry: MultiPolygonShape) {
  return geometry.flatMap((polygon) => polygon.flatMap(linePartsFromRing));
}

function geoJsonGeometryFromMultiPolygon(geometry: MultiPolygonShape): GeoJsonGeometry {
  return {
    type: 'MultiPolygon',
    coordinates: geometry
  };
}

function emitterSegmentsFromVectorWavefront(wavefront: VectorWavefront) {
  if (wavefront.kind === 'line') {
    return wavefront.segments;
  }

  return wavefront.geometry.flatMap((polygon) =>
    polygon.length === 0 ? [] : linePartsFromRing(polygon[0])
  );
}

function areaLikeGeometryFromVectorWavefront(wavefront: VectorWavefront) {
  if (wavefront.kind === 'area') {
    return wavefront.geometry;
  }

  // polygon-clipping works on polygon areas, not raw LineStrings. W0 is kept
  // as the confirmed seed emitter; clipping to the confirmed boundary prevents
  // backward area outside the overhang from being retained.
  return [];
}

function areaLikeGeometryFromSeedSegments(
  segments: LinePart[],
  lineBufferEps = HUYGENS_LINE_BUFFER_EPS
) {
  if (segments.length === 0) {
    return [];
  }

  const buffered = cleanJstsGeometry(
    BufferOp.bufferOp(seedSegmentsToJstsGeometry(segments), lineBufferEps, 8),
    8
  );

  return normalizeVectorGeometry(multiPolygonFromGeoJsonGeometry(jstsWriteGeometry(buffered)));
}

function areaLikeGeometryForHuygensWavefront(
  wavefront: VectorWavefront,
  lineBufferEps = HUYGENS_LINE_BUFFER_EPS
) {
  if (wavefront.kind === 'area') {
    return wavefront.geometry;
  }

  return areaLikeGeometryFromSeedSegments(wavefront.segments, lineBufferEps);
}

function clipSeedSegmentsToVectorBoundary(
  seedSegments: LinePart[],
  boundaryGeometry: MultiPolygonShape
) {
  if (seedSegments.length === 0 || !hasVectorArea(boundaryGeometry)) {
    return [];
  }

  const clipped = jstsOverlay(
    'intersection',
    seedSegmentsToJstsGeometry(seedSegments),
    jstsReadGeometry({
      type: 'MultiPolygon',
      coordinates: boundaryGeometry
    }),
    8
  );

  const clippedSegments = linePartsFromGeoJsonGeometry(jstsWriteGeometry(clipped));
  return clippedSegments.length > 0 ? clippedSegments : seedSegments;
}

function significantNewHuygensGeometry(
  newGeometry: MultiPolygonShape,
  accumulatedGeometry: MultiPolygonShape,
  settings: WavePathSettings
) {
  if (!hasVectorArea(newGeometry)) {
    return false;
  }

  const delta = jstsOverlay(
    'difference',
    jstsReadGeometry({
      type: 'MultiPolygon',
      coordinates: newGeometry
    }),
    jstsReadGeometry({
      type: 'MultiPolygon',
      coordinates: accumulatedGeometry
    }),
    8
  );

  return jstsHasArea(delta) && jstsGeometryArea(delta) > minSignificantVectorArea(settings);
}

function midpointDistanceToSegments(segment: LinePart, targetSegments: LinePart[]) {
  const midpoint = {
    x: (segment.x1 + segment.x2) / 2,
    y: (segment.y1 + segment.y2) / 2
  };

  return targetSegments.reduce(
    (minimum, target) => Math.min(minimum, distancePointToSegment(midpoint, target)),
    Number.POSITIVE_INFINITY
  );
}

function keepSegmentsNearMaximumDistance(
  segments: LinePart[],
  currentSeedSegments: LinePart[],
  referenceSegments: LinePart[],
  settings: WavePathSettings
) {
  if (
    segments.length === 0 ||
    currentSeedSegments.length === 0 ||
    referenceSegments.length === 0
  ) {
    return segments;
  }

  const scoredSegments = segments.map((segment) => ({
    segment,
    distance: midpointDistanceToSegments(segment, referenceSegments)
  }));
  const maximumDistance = scoredSegments.reduce(
    (maximum, entry) => Math.max(maximum, entry.distance),
    0
  );
  const currentDistance = averageEmitterDistanceForSegments(
    currentSeedSegments,
    referenceSegments
  );
  const distanceTolerance = Math.max(
    EPSILON * 32,
    settings.discretizationDistance * 1.5,
    settings.wavelength * 0.2
  );
  const progressTolerance = Math.max(
    EPSILON * 32,
    settings.discretizationDistance * 0.5,
    settings.wavelength * 0.15
  );

  if (maximumDistance <= currentDistance + progressTolerance) {
    return [];
  }

  return scoredSegments
    .filter((entry) => entry.distance + distanceTolerance >= maximumDistance)
    .map((entry) => entry.segment);
}

function intersectJstsGeometriesRaw(subjectGeometry: any, clipGeometry: any) {
  if (!subjectGeometry || subjectGeometry.isEmpty?.() || !clipGeometry || clipGeometry.isEmpty?.()) {
    return null;
  }

  return OverlayOp.intersection(subjectGeometry, clipGeometry);
}

function propagateHuygensStep(
  currentSeedSegments: LinePart[],
  referenceSegments: LinePart[],
  boundaryGeometry: any,
  settings: WavePathSettings
) {
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);

  if (currentSeedSegments.length === 0 || !boundaryGeometry || boundaryGeometry.isEmpty?.()) {
    return { clippedBand: null, forwardSegments: [] as LinePart[] };
  }

  const seedGeometry = seedSegmentsToJstsGeometry(currentSeedSegments);
  const propagatedBand = cleanJstsGeometry(
    BufferOp.bufferOp(
      seedGeometry,
      settings.wavelength,
      fidelity.waveBufferQuadrantSegments
    ),
    fidelity.cleanupQuadrantSegments
  );

  if (!jstsHasArea(propagatedBand)) {
    return { clippedBand: null, forwardSegments: [] as LinePart[] };
  }

  const clippedBand = jstsOverlay(
    'intersection',
    propagatedBand,
    boundaryGeometry,
    fidelity.cleanupQuadrantSegments
  );

  if (!jstsHasArea(clippedBand)) {
    return { clippedBand: null, forwardSegments: [] as LinePart[] };
  }

  const propagatedBoundary = propagatedBand.getBoundary();
  const clippedBoundary = clippedBand.getBoundary();
  const curveGeometry = intersectJstsGeometriesRaw(clippedBoundary, propagatedBoundary);
  const curveSegments = linePartsFromGeoJsonGeometry(jstsWriteGeometry(curveGeometry));

  if (curveSegments.length === 0) {
    return { clippedBand, forwardSegments: [] as LinePart[] };
  }

  return {
    clippedBand,
    forwardSegments: keepSegmentsNearMaximumDistance(
      curveSegments,
      currentSeedSegments,
      referenceSegments,
      settings
    )
  };
}

function circleUnionFromPoints(points: Coordinate[], radius: number) {
  if (points.length === 0) {
    return [];
  }

  return unionVectorGeometries(points.map((point) => circlePolygon(point, radius)));
}

function buildVectorBoundaryGeometry(layer: AnalyzedLayerData) {
  return unionVectorGeometries(layer.overhangRegion);
}

function minSignificantVectorArea(settings: WavePathSettings) {
  return Math.max(
    EPSILON,
    settings.minAddedCells * settings.discretizationDistance * settings.discretizationDistance * 0.01
  );
}

function localRecurrenceToleranceDistance(settings: WavePathSettings) {
  return Math.max(
    EPSILON * 32,
    Math.min(settings.wavelength, settings.discretizationDistance) * 0.1
  );
}

function propagateVectorStep(
  currentWavefront: VectorWavefront,
  accumulatedGeometry: MultiPolygonShape,
  boundaryGeometry: MultiPolygonShape,
  settings: WavePathSettings
) {
  const emitterSegments = emitterSegmentsFromVectorWavefront(currentWavefront);
  const points = samplePointsAlongSegments(emitterSegments, settings.discretizationDistance);

  if (points.length === 0) {
    return [];
  }

  // Huygens-style step: sample W_i, union true wavelength-radius circle
  // polygons, and clip the result to the user-confirmed overhang boundary.
  const propagatedRegion = circleUnionFromPoints(points, settings.wavelength);
  const clippedRegion = intersectVectorGeometries(propagatedRegion, boundaryGeometry);

  return differenceVectorGeometry(clippedRegion, accumulatedGeometry);
}

type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Coordinate }
  | { type: 'MultiPoint'; coordinates: Coordinate[] }
  | { type: 'LineString'; coordinates: Coordinate[] }
  | { type: 'MultiLineString'; coordinates: Coordinate[][] }
  | { type: 'Polygon'; coordinates: PolygonShape }
  | { type: 'MultiPolygon'; coordinates: MultiPolygonShape }
  | { type: 'GeometryCollection'; geometries: GeoJsonGeometry[] };

const geoJsonReader = new GeoJSONReader(undefined as never);
const geoJsonWriter = new GeoJSONWriter();

function getFidelityProfile(
  fidelity: WaveFidelity,
  waveBufferQuadrantSegmentsOverride?: number
) {
  const withOverride = <T extends { waveBufferQuadrantSegments: number }>(profile: T) => ({
    ...profile,
    waveBufferQuadrantSegments:
      waveBufferQuadrantSegmentsOverride ?? profile.waveBufferQuadrantSegments
  });

  if (fidelity === 'low') {
    return withOverride({
      cleanupQuadrantSegments: 4,
      boundarySmoothingQuadrantSegments: 8,
      waveBufferQuadrantSegments: 8,
      boundarySmoothingFactor: 0.45
    });
  }

  if (fidelity === 'high') {
    return withOverride({
      cleanupQuadrantSegments: 8,
      boundarySmoothingQuadrantSegments: 24,
      waveBufferQuadrantSegments: 24,
      boundarySmoothingFactor: 0.7
    });
  }

  return withOverride({
    cleanupQuadrantSegments: 6,
    boundarySmoothingQuadrantSegments: 16,
    waveBufferQuadrantSegments: 16,
    boundarySmoothingFactor: 0.6
  });
}

function jstsReadGeometry(geometry: GeoJsonGeometry): any {
  return geoJsonReader.read(geometry);
}

function jstsWriteGeometry(geometry: any): GeoJsonGeometry | null {
  if (!geometry || geometry.isEmpty?.()) {
    return null;
  }

  return geoJsonWriter.write(geometry) as GeoJsonGeometry;
}

function jstsGeometryArea(geometry: any) {
  return typeof geometry?.getArea === 'function' ? geometry.getArea() as number : 0;
}

function jstsHasArea(geometry: any) {
  return Boolean(geometry && !geometry.isEmpty?.() && jstsGeometryArea(geometry) > EPSILON);
}

function cleanJstsGeometry(geometry: any, quadrantSegments = 8) {
  if (!geometry || geometry.isEmpty?.()) {
    return geometry;
  }

  return BufferOp.bufferOp(geometry, 0, quadrantSegments);
}

function estimateOverhangCellSize(layer: AnalyzedLayerData) {
  let smallestSize = Number.POSITIVE_INFINITY;

  for (const polygon of layer.overhangRegion) {
    const ring = polygon[0];
    if (!ring || ring.length < 4) {
      continue;
    }

    const xs = ring.map(([x]) => x);
    const ys = ring.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const size = Math.max(width, height);

    if (size > EPSILON && size < smallestSize) {
      smallestSize = size;
    }
  }

  return Number.isFinite(smallestSize) ? smallestSize : 0;
}

function seedSegmentsToJstsGeometry(seedSegments: LinePart[]) {
  const coordinates = seedSegments
    .filter((segment) => segment.length > EPSILON)
    .map((segment) => [
      [segment.x1, segment.y1],
      [segment.x2, segment.y2]
    ] as Coordinate[]);

  return coordinates.length === 1
    ? jstsReadGeometry({ type: 'LineString', coordinates: coordinates[0] })
    : jstsReadGeometry({ type: 'MultiLineString', coordinates });
}

function overhangBoundaryToJstsGeometry(
  layer: AnalyzedLayerData,
  settings: WavePathSettings
) {
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);
  const boundaryGeometry = cleanJstsGeometry(
    jstsReadGeometry({
      type: 'MultiPolygon',
      coordinates: layer.overhangRegion
    }),
    fidelity.cleanupQuadrantSegments
  );
  const cellSize = estimateOverhangCellSize(layer);
  const smoothingRadius =
    cellSize > EPSILON ? cellSize * fidelity.boundarySmoothingFactor : 0;

  // The current overhang region arrives as many adjacent raster cell polygons.
  // A zero-width buffer dissolves those touching cells into a cleaner area for
  // later intersection/difference steps. A small outward/inward buffer pair
  // then smooths grid-aliasing from the raster footprint itself, so curved
  // wavefronts can emerge from the geometry generation rather than canvas
  // post-processing.
  if (smoothingRadius <= EPSILON) {
    return boundaryGeometry;
  }

  const expanded = BufferOp.bufferOp(
    boundaryGeometry,
    smoothingRadius,
    fidelity.boundarySmoothingQuadrantSegments
  );
  const smoothed = BufferOp.bufferOp(
    expanded,
    -smoothingRadius,
    fidelity.boundarySmoothingQuadrantSegments
  );
  return cleanJstsGeometry(smoothed, fidelity.cleanupQuadrantSegments);
}

function jstsOverlay(
  operation: 'intersection' | 'difference' | 'union',
  subjectGeometry: any,
  clipGeometry: any,
  cleanupQuadrantSegments: number
) {
  if (!subjectGeometry || subjectGeometry.isEmpty?.()) {
    return subjectGeometry;
  }

  if (!clipGeometry || clipGeometry.isEmpty?.()) {
    return subjectGeometry;
  }

  const runOverlay = (subject: any, clip: any) => {
    if (operation === 'intersection') {
      return OverlayOp.intersection(subject, clip);
    }

    if (operation === 'difference') {
      return OverlayOp.difference(subject, clip);
    }

    return OverlayOp.union(subject, clip);
  };

  try {
    return cleanJstsGeometry(
      runOverlay(subjectGeometry, clipGeometry),
      cleanupQuadrantSegments
    );
  } catch {
    const cleanedSubject = cleanJstsGeometry(subjectGeometry, cleanupQuadrantSegments);
    const cleanedClip = cleanJstsGeometry(clipGeometry, cleanupQuadrantSegments);
    return cleanJstsGeometry(
      runOverlay(cleanedSubject, cleanedClip),
      cleanupQuadrantSegments
    );
  }
}

function linePartsFromCoordinates(coordinates: Coordinate[]) {
  const segments: LinePart[] = [];

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const [x1, y1] = coordinates[index];
    const [x2, y2] = coordinates[index + 1];
    const length = Math.hypot(x2 - x1, y2 - y1);

    if (length > EPSILON) {
      segments.push({ x1, y1, x2, y2, length });
    }
  }

  return segments;
}

function linePartsFromGeoJsonGeometry(geometry: GeoJsonGeometry | null): LinePart[] {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
    return [];
  }

  if (geometry.type === 'LineString') {
    return linePartsFromCoordinates(geometry.coordinates);
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.flatMap(linePartsFromCoordinates);
  }

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.flatMap(linePartsFromCoordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap((polygon) => polygon.flatMap(linePartsFromCoordinates));
  }

  return geometry.geometries.flatMap(linePartsFromGeoJsonGeometry);
}

function linePartsFromGeoJsonWavefrontGeometry(geometry: GeoJsonGeometry | null): LinePart[] {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
    return [];
  }

  if (geometry.type === 'LineString') {
    return linePartsFromCoordinates(geometry.coordinates);
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.flatMap(linePartsFromCoordinates);
  }

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.length === 0 ? [] : linePartsFromCoordinates(geometry.coordinates[0]);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap((polygon) =>
      polygon.length === 0 ? [] : linePartsFromCoordinates(polygon[0])
    );
  }

  return geometry.geometries.flatMap(linePartsFromGeoJsonWavefrontGeometry);
}

function multiPolygonFromGeoJsonGeometry(geometry: GeoJsonGeometry | null): MultiPolygonShape {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return [geometry.coordinates];
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates;
  }

  if (geometry.type === 'GeometryCollection') {
    return geometry.geometries.flatMap(multiPolygonFromGeoJsonGeometry);
  }

  return [];
}

function pointInRing(point: { x: number; y: number }, ring: PolygonRing) {
  let inside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    const intersects =
      y1 > point.y !== y2 > point.y &&
      point.x < ((x2 - x1) * (point.y - y1)) / (y2 - y1 + EPSILON) + x1;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInPolygonGeometry(point: { x: number; y: number }, polygon: PolygonShape) {
  if (polygon.length === 0 || !pointInRing(point, polygon[0])) {
    return false;
  }

  for (const hole of polygon.slice(1)) {
    if (pointInRing(point, hole)) {
      return false;
    }
  }

  return true;
}

function pointInMultiPolygonGeometry(point: { x: number; y: number }, geometry: MultiPolygonShape) {
  return geometry.some((polygon) => pointInPolygonGeometry(point, polygon));
}

function wavefrontSegmentsFacingRemainingGeometry(
  wavefrontGeometry: GeoJsonGeometry | null,
  remainingGeometry: GeoJsonGeometry | null,
  settings: WavePathSettings
) {
  const wavefrontPolygons = multiPolygonFromGeoJsonGeometry(wavefrontGeometry);
  const remainingPolygons = multiPolygonFromGeoJsonGeometry(remainingGeometry);
  const sampleOffset = localRecurrenceToleranceDistance(settings);
  const segments: LinePart[] = [];

  for (const polygon of wavefrontPolygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const [x1, y1] = ring[index];
        const [x2, y2] = ring[index + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);

        if (length <= EPSILON) {
          continue;
        }

        const midpoint = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
        const unitNormal = { x: -dy / length, y: dx / length };
        const sampleA = {
          x: midpoint.x + unitNormal.x * sampleOffset,
          y: midpoint.y + unitNormal.y * sampleOffset
        };
        const sampleB = {
          x: midpoint.x - unitNormal.x * sampleOffset,
          y: midpoint.y - unitNormal.y * sampleOffset
        };
        const facesRemaining =
          (!pointInMultiPolygonGeometry(sampleA, wavefrontPolygons) &&
            pointInMultiPolygonGeometry(sampleA, remainingPolygons)) ||
          (!pointInMultiPolygonGeometry(sampleB, wavefrontPolygons) &&
            pointInMultiPolygonGeometry(sampleB, remainingPolygons));

        if (facesRemaining) {
          segments.push({ x1, y1, x2, y2, length });
        }
      }
    }
  }

  return segments;
}

function wavefrontSegmentsFacingAwayFromPreviousBand(
  wavefrontGeometry: GeoJsonGeometry | null,
  previousBandGeometry: GeoJsonGeometry | null,
  settings: WavePathSettings
) {
  const wavefrontPolygons = multiPolygonFromGeoJsonGeometry(wavefrontGeometry);
  const previousBandPolygons = multiPolygonFromGeoJsonGeometry(previousBandGeometry);

  if (wavefrontPolygons.length === 0) {
    return [];
  }

  if (previousBandPolygons.length === 0) {
    return linePartsFromGeoJsonWavefrontGeometry(wavefrontGeometry);
  }

  const sampleOffset = localRecurrenceToleranceDistance(settings);
  const segments: LinePart[] = [];

  for (const polygon of wavefrontPolygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const [x1, y1] = ring[index];
        const [x2, y2] = ring[index + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);

        if (length <= EPSILON) {
          continue;
        }

        const midpoint = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
        const unitNormal = { x: -dy / length, y: dx / length };
        const sampleA = {
          x: midpoint.x + unitNormal.x * sampleOffset,
          y: midpoint.y + unitNormal.y * sampleOffset
        };
        const sampleB = {
          x: midpoint.x - unitNormal.x * sampleOffset,
          y: midpoint.y - unitNormal.y * sampleOffset
        };
        const outsideFacesPreviousBand =
          (!pointInMultiPolygonGeometry(sampleA, wavefrontPolygons) &&
            pointInMultiPolygonGeometry(sampleA, previousBandPolygons)) ||
          (!pointInMultiPolygonGeometry(sampleB, wavefrontPolygons) &&
            pointInMultiPolygonGeometry(sampleB, previousBandPolygons));

        if (!outsideFacesPreviousBand) {
          segments.push({ x1, y1, x2, y2, length });
        }
      }
    }
  }

  return segments;
}

function filterWavefrontSegmentsByEmitterDistance(
  segments: LinePart[],
  emitterSegments: LinePart[],
  settings: WavePathSettings
) {
  if (segments.length === 0 || emitterSegments.length === 0) {
    return segments;
  }

  const minimumFrontDistance = Math.max(
    settings.wavelength * 0.5,
    settings.discretizationDistance * 0.5
  );

  return segments.filter((segment) => {
    const midpoint = {
      x: (segment.x1 + segment.x2) / 2,
      y: (segment.y1 + segment.y2) / 2
    };

    return emitterSegments.every(
      (emitter) => distancePointToSegment(midpoint, emitter) >= minimumFrontDistance
    );
  });
}

function filterWavefrontSegmentsAlongBoundaryTrim(
  segments: LinePart[],
  boundarySegments: LinePart[],
  settings: WavePathSettings
) {
  if (segments.length === 0 || boundarySegments.length === 0) {
    return segments;
  }

  const boundaryTolerance = Math.max(
    EPSILON * 32,
    Math.min(settings.wavelength, settings.discretizationDistance) * 0.08
  );
  const sampleParameters = [0.25, 0.5, 0.75];

  return segments.filter((segment) => {
    let closeSampleCount = 0;

    for (const t of sampleParameters) {
      const point = {
        x: segment.x1 + (segment.x2 - segment.x1) * t,
        y: segment.y1 + (segment.y2 - segment.y1) * t
      };

      const touchesBoundary = boundarySegments.some(
        (boundarySegment) =>
          distancePointToSegment(point, boundarySegment) <= boundaryTolerance
      );

      if (touchesBoundary) {
        closeSampleCount += 1;
      }
    }

    return closeSampleCount < sampleParameters.length;
  });
}

function collectPolylineLeafEndpoints(segments: LinePart[]) {
  if (segments.length === 0) {
    return [];
  }

  const nodeToSegments = buildWavefrontGraph(segments);
  const coordinatesByKey = new Map<string, { x: number; y: number }>();

  for (const segment of segments) {
    coordinatesByKey.set(endpointNodeKey(segment.x1, segment.y1), {
      x: segment.x1,
      y: segment.y1
    });
    coordinatesByKey.set(endpointNodeKey(segment.x2, segment.y2), {
      x: segment.x2,
      y: segment.y2
    });
  }

  return [...nodeToSegments.entries()]
    .filter(([, connectedSegments]) => connectedSegments.length === 1)
    .map(([nodeKey]) => coordinatesByKey.get(nodeKey))
    .filter((coordinate): coordinate is { x: number; y: number } => Boolean(coordinate));
}

function filterWavefrontBranchesNearEmitterEndpoints(
  segments: LinePart[],
  emitterSegments: LinePart[],
  settings: WavePathSettings
) {
  if (segments.length === 0 || emitterSegments.length === 0) {
    return segments;
  }

  const emitterLeafEndpoints = collectPolylineLeafEndpoints(emitterSegments);

  if (emitterLeafEndpoints.length === 0) {
    return segments;
  }

  const endpointRadius = Math.max(
    settings.discretizationDistance * 1.25,
    settings.wavelength * 0.65
  );
  const maximumBranchLength = Math.max(
    settings.discretizationDistance * 4,
    settings.wavelength * 1.1
  );

  return splitSegmentsIntoConnectedPolylines(segments).flatMap((polyline) => {
    const polylineSegments = linePartsFromCoordinates(polyline);

    if (polylineSegments.length === 0) {
      return [];
    }

    const totalLength = polylineSegments.reduce(
      (sum, segment) => sum + segment.length,
      0
    );
    const polylineEndpoints = [polyline[0], polyline[polyline.length - 1]].map(([x, y]) => ({
      x,
      y
    }));
    const startsNearEmitterEndpoint = polylineEndpoints.some((polylineEndpoint) =>
      emitterLeafEndpoints.some(
        (emitterEndpoint) =>
          Math.hypot(
            polylineEndpoint.x - emitterEndpoint.x,
            polylineEndpoint.y - emitterEndpoint.y
          ) <= endpointRadius
      )
    );

    return startsNearEmitterEndpoint && totalLength + EPSILON < maximumBranchLength
      ? []
      : polylineSegments;
  });
}

function averageEmitterDistanceForSegments(
  segments: LinePart[],
  emitterSegments: LinePart[]
) {
  if (segments.length === 0 || emitterSegments.length === 0) {
    return 0;
  }

  let totalDistance = 0;

  for (const segment of segments) {
    const midpoint = {
      x: (segment.x1 + segment.x2) / 2,
      y: (segment.y1 + segment.y2) / 2
    };
    totalDistance += emitterSegments.reduce(
      (minimum, emitter) => Math.min(minimum, distancePointToSegment(midpoint, emitter)),
      Number.POSITIVE_INFINITY
    );
  }

  return totalDistance / segments.length;
}

function keepFarthestWavefrontComponents(
  segments: LinePart[],
  emitterSegments: LinePart[],
  settings: WavePathSettings
) {
  if (segments.length === 0 || emitterSegments.length === 0) {
    return segments;
  }

  const components = splitSegmentsIntoConnectedPolylines(segments).map((polyline) => {
    const polylineSegments = linePartsFromCoordinates(polyline);
    return {
      segments: polylineSegments,
      score: averageEmitterDistanceForSegments(polylineSegments, emitterSegments)
    };
  });

  if (components.length === 0) {
    return [];
  }

  const bestScore = components.reduce(
    (maximum, component) => Math.max(maximum, component.score),
    0
  );
  const scoreTolerance = Math.max(
    settings.wavelength * 0.4,
    settings.discretizationDistance * 1.5
  );

  return components
    .filter((component) => component.score + scoreTolerance >= bestScore)
    .flatMap((component) => component.segments);
}

function endpointNodeKey(x: number, y: number) {
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

function segmentEndpointKeys(segment: LinePart) {
  return [
    endpointNodeKey(segment.x1, segment.y1),
    endpointNodeKey(segment.x2, segment.y2)
  ] as const;
}

function buildWavefrontGraph(segments: LinePart[], activeSegments?: Set<number>) {
  const nodeToSegments = new Map<string, number[]>();

  segments.forEach((segment, index) => {
    if (activeSegments && !activeSegments.has(index)) {
      return;
    }

    for (const key of segmentEndpointKeys(segment)) {
      const connected = nodeToSegments.get(key) ?? [];
      connected.push(index);
      nodeToSegments.set(key, connected);
    }
  });

  return nodeToSegments;
}

function activeIncidentSegments(
  nodeKey: string,
  nodeToSegments: Map<string, number[]>,
  activeSegments: Set<number>,
  excludedSegmentIndex?: number
) {
  return (nodeToSegments.get(nodeKey) ?? []).filter(
    (segmentIndex) =>
      activeSegments.has(segmentIndex) && segmentIndex !== excludedSegmentIndex
  );
}

function pruneShortLeafBranches(
  segments: LinePart[],
  minimumBranchLength: number
) {
  if (segments.length === 0) {
    return segments;
  }

  const activeSegments = new Set(segments.map((_, index) => index));
  let removedAny = true;

  while (removedAny) {
    removedAny = false;
    const nodeToSegments = buildWavefrontGraph(segments, activeSegments);
    const leafNodeKeys = [...nodeToSegments.keys()].filter(
      (nodeKey) => activeIncidentSegments(nodeKey, nodeToSegments, activeSegments).length === 1
    );

    for (const leafNodeKey of leafNodeKeys) {
      const leafSegments = activeIncidentSegments(
        leafNodeKey,
        nodeToSegments,
        activeSegments
      );

      if (leafSegments.length !== 1) {
        continue;
      }

      const traversedSegments: number[] = [];
      let traversedLength = 0;
      let currentNodeKey = leafNodeKey;
      let previousSegmentIndex: number | undefined;
      const visitedInTraversal = new Set<string>([leafNodeKey]);

      while (true) {
        const nextCandidates = activeIncidentSegments(
          currentNodeKey,
          nodeToSegments,
          activeSegments,
          previousSegmentIndex
        );

        if (nextCandidates.length !== 1) {
          break;
        }

        const segmentIndex = nextCandidates[0];
        const segment = segments[segmentIndex];
        traversedSegments.push(segmentIndex);
        traversedLength += segment.length;
        previousSegmentIndex = segmentIndex;

        const [startKey, endKey] = segmentEndpointKeys(segment);
        const nextNodeKey = currentNodeKey === startKey ? endKey : startKey;

        if (visitedInTraversal.has(nextNodeKey)) {
          break;
        }

        currentNodeKey = nextNodeKey;
        visitedInTraversal.add(currentNodeKey);

        if (
          activeIncidentSegments(currentNodeKey, nodeToSegments, activeSegments).length !== 2
        ) {
          break;
        }
      }

      if (
        traversedSegments.length > 0 &&
        traversedLength + EPSILON < minimumBranchLength
      ) {
        for (const segmentIndex of traversedSegments) {
          activeSegments.delete(segmentIndex);
        }
        removedAny = true;
      }
    }
  }

  return segments.filter((_, index) => activeSegments.has(index));
}

function keepSignificantConnectedWavefrontComponents(
  segments: LinePart[],
  minimumComponentLength: number
) {
  if (segments.length === 0) {
    return segments;
  }

  const nodeToSegments = buildWavefrontGraph(segments);
  const visited = new Set<number>();
  const components: Array<{ segmentIndexes: number[]; totalLength: number }> = [];

  for (let index = 0; index < segments.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    const componentSegmentIndexes: number[] = [];
    let totalLength = 0;
    const stack = [index];

    while (stack.length > 0) {
      const currentIndex = stack.pop();

      if (currentIndex === undefined || visited.has(currentIndex)) {
        continue;
      }

      visited.add(currentIndex);
      componentSegmentIndexes.push(currentIndex);
      totalLength += segments[currentIndex].length;

      for (const nodeKey of segmentEndpointKeys(segments[currentIndex])) {
        for (const neighborIndex of nodeToSegments.get(nodeKey) ?? []) {
          if (!visited.has(neighborIndex)) {
            stack.push(neighborIndex);
          }
        }
      }
    }

    components.push({ segmentIndexes: componentSegmentIndexes, totalLength });
  }

  const longestComponentLength = components.reduce(
    (maximum, component) => Math.max(maximum, component.totalLength),
    0
  );
  const keptSegmentIndexes = new Set<number>();

  for (const component of components) {
    if (
      component.totalLength + EPSILON >= minimumComponentLength ||
      component.totalLength + EPSILON >= longestComponentLength
    ) {
      for (const segmentIndex of component.segmentIndexes) {
        keptSegmentIndexes.add(segmentIndex);
      }
    }
  }

  return segments.filter((_, index) => keptSegmentIndexes.has(index));
}

function cleanExtractedWavefrontSegments(
  segments: LinePart[],
  settings: WavePathSettings
) {
  if (segments.length === 0) {
    return segments;
  }

  const minimumBranchLength = Math.max(
    settings.discretizationDistance * 1.5,
    settings.wavelength * 0.35
  );
  const minimumComponentLength = Math.max(
    settings.discretizationDistance * 2,
    settings.wavelength * 0.75
  );

  return keepSignificantConnectedWavefrontComponents(
    pruneShortLeafBranches(segments, minimumBranchLength),
    minimumComponentLength
  );
}

function propagateJstsStepFullHistory(
  currentWavefront: any,
  accumulatedGeometry: any | null,
  boundaryGeometry: any,
  settings: WavePathSettings
) {
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);

  // Timing hooks are intentionally lightweight so the local-recurrence path can
  // be compared against the legacy full-history boolean chain when needed.
  const propagatedRegion = withWaveTiming('full-history buffer', () =>
    cleanJstsGeometry(
      BufferOp.bufferOp(
        currentWavefront,
        settings.wavelength,
        fidelity.waveBufferQuadrantSegments
      ),
      fidelity.cleanupQuadrantSegments
    )
  );
  const clippedRegion = withWaveTiming('full-history intersection', () =>
    jstsOverlay(
      'intersection',
      propagatedRegion,
      boundaryGeometry,
      fidelity.cleanupQuadrantSegments
    )
  );
  return accumulatedGeometry
    ? withWaveTiming('full-history difference', () =>
        jstsOverlay(
          'difference',
          clippedRegion,
          accumulatedGeometry,
          fidelity.cleanupQuadrantSegments
        )
      )
    : clippedRegion;
}

function propagateJstsStepBoundaryIntersection(
  currentWavefront: any,
  boundaryGeometry: any,
  settings: WavePathSettings
) {
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);

  const propagatedRegion = withWaveTiming('boundary-intersection buffer', () =>
    cleanJstsGeometry(
      BufferOp.bufferOp(
        currentWavefront,
        settings.wavelength,
        fidelity.waveBufferQuadrantSegments
      ),
      fidelity.cleanupQuadrantSegments
    )
  );

  return withWaveTiming('boundary-intersection clip', () =>
    jstsOverlay(
      'intersection',
      propagatedRegion,
      boundaryGeometry,
      fidelity.cleanupQuadrantSegments
    )
  );
}

function propagateJstsStepLocalRecurrence(
  currentWavefront: any,
  previousBandGeometry: any | null,
  boundaryGeometry: any,
  settings: WavePathSettings
) {
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);

  const propagatedRegion = withWaveTiming('local buffer', () =>
    cleanJstsGeometry(
      BufferOp.bufferOp(
        currentWavefront,
        settings.wavelength,
        fidelity.waveBufferQuadrantSegments
      ),
      fidelity.cleanupQuadrantSegments
    )
  );
  const clippedRegion = withWaveTiming('local intersection', () =>
    jstsOverlay(
      'intersection',
      propagatedRegion,
      boundaryGeometry,
      fidelity.cleanupQuadrantSegments
    )
  );
  const subtractionGeometry =
    previousBandGeometry && jstsHasArea(previousBandGeometry)
      ? withWaveTiming('local reference expand', () =>
          cleanJstsGeometry(
            BufferOp.bufferOp(
              previousBandGeometry,
              localRecurrenceToleranceDistance(settings),
              fidelity.waveBufferQuadrantSegments
            ),
            fidelity.cleanupQuadrantSegments
          )
        )
      : null;

  return subtractionGeometry && jstsHasArea(subtractionGeometry)
    ? withWaveTiming('local difference', () =>
        jstsOverlay(
          'difference',
          clippedRegion,
          subtractionGeometry,
          fidelity.cleanupQuadrantSegments
        )
      )
    : clippedRegion;
}

function buildInitialBackwardReferenceGeometry(currentWavefront: any, settings: WavePathSettings) {
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);
  const referenceRadius = Math.max(
    settings.wavelength * 0.5,
    settings.discretizationDistance * 0.5,
    EPSILON
  );

  return cleanJstsGeometry(
    BufferOp.bufferOp(currentWavefront, referenceRadius, fidelity.waveBufferQuadrantSegments),
    fidelity.cleanupQuadrantSegments
  );
}

function extractBackwardAwareWavefrontSegments(
  nextGeometry: any,
  backwardReferenceGeometry: any,
  currentEmitterSegments: LinePart[],
  boundarySegments: LinePart[],
  settings: WavePathSettings,
  timingLabel: string
) {
  return withWaveTiming(timingLabel, () =>
    cleanExtractedWavefrontSegments(
      filterWavefrontSegmentsAlongBoundaryTrim(
        filterWavefrontBranchesNearEmitterEndpoints(
          filterWavefrontSegmentsByEmitterDistance(
            wavefrontSegmentsFacingAwayFromPreviousBand(
              jstsWriteGeometry(nextGeometry),
              jstsWriteGeometry(backwardReferenceGeometry),
              settings
            ),
            currentEmitterSegments,
            settings
          ),
          currentEmitterSegments,
          settings
        ),
        boundarySegments,
        settings
      ),
      settings
    )
  );
}

function extractLegacyStableWavefrontSegments(
  nextGeometry: any,
  settings: WavePathSettings,
  timingLabel: string
) {
  return withWaveTiming(timingLabel, () =>
    cleanExtractedWavefrontSegments(
      linePartsFromGeoJsonWavefrontGeometry(jstsWriteGeometry(nextGeometry)),
      settings
    )
  );
}

function generateRasterWavePathPlan(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  const grid = buildBoundaryGrid(layer, settings);
  const seedSegments = layer.waveGuide.seedSegments;

  if (!grid || seedSegments.length === 0) {
    return {
      layerIndex: layer.index,
      seedSegments,
      boundarySegments: layer.waveGuide.boundarySegments,
      wavefronts: [],
      generationMode: 'raster-fallback',
      settings
    };
  }

  const wavefronts: WavePathPlan['wavefronts'] = [];
  const accumulated = new Set(seedOccupiedCells(grid, seedSegments).map((cell) => cell.key));
  let currentEmitterSegments = seedSegments;

  for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
    const nextCells = propagateOneStep(currentEmitterSegments, accumulated, grid, settings);

    if (nextCells.length === 0 || nextCells.length < settings.minAddedCells) {
      break;
    }

    const nextSegments = forwardContourSegmentsForCells(
      nextCells,
      grid,
      accumulated
    );

    if (nextSegments.length === 0) {
      break;
    }

    for (const cell of nextCells) {
      accumulated.add(cell.key);
    }

    wavefronts.push({
      iteration,
      segments: nextSegments,
      cellCount: nextCells.length
    });

    currentEmitterSegments = nextSegments;
  }

  return {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments: layer.waveGuide.boundarySegments,
    wavefronts,
    generationMode: 'raster-fallback',
    settings
  };
}

async function yieldToBrowser() {
  await new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }

    setTimeout(resolve, 0);
  });
}

function generateJstsWavePathPlanFullHistory(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  const seedSegments = layer.waveGuide.seedSegments;
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);
  const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

  if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
    return {
      layerIndex: layer.index,
      seedSegments,
      boundarySegments: layer.waveGuide.boundarySegments,
      wavefronts: [],
      generationMode: 'vector',
      settings
    };
  }

  const wavefronts: WavePathPlan['wavefronts'] = [];
  const areaThreshold = minSignificantVectorArea(settings);
  let accumulatedGeometry: any | null = null;
  let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

  for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
    const nextGeometry = propagateJstsStepFullHistory(
      currentWavefront,
      accumulatedGeometry,
      boundaryGeometry,
      settings
    );
    const addedArea = jstsGeometryArea(nextGeometry);

    if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
      break;
    }

    accumulatedGeometry =
      accumulatedGeometry === null
        ? nextGeometry
        : jstsOverlay(
            'union',
            accumulatedGeometry,
            nextGeometry,
            fidelity.cleanupQuadrantSegments
          );

    const nextSegments = withWaveTiming('full-history wavefront extraction', () =>
      cleanExtractedWavefrontSegments(
        filterWavefrontSegmentsAlongBoundaryTrim(
          wavefrontSegmentsFacingRemainingGeometry(
            jstsWriteGeometry(nextGeometry),
            jstsWriteGeometry(
              jstsOverlay(
                'difference',
                boundaryGeometry,
                accumulatedGeometry,
                fidelity.cleanupQuadrantSegments
              )
            ),
            settings
          ),
          layer.waveGuide.boundarySegments,
          settings
        ),
        settings
      )
    );

    if (nextSegments.length === 0) {
      break;
    }

    wavefronts.push({
      iteration,
      segments: nextSegments,
      cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
    });

    currentWavefront = seedSegmentsToJstsGeometry(nextSegments);
  }

  return {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments: layer.waveGuide.boundarySegments,
    wavefronts,
    generationMode: 'vector',
    settings
  };
}

function generateJstsWavePathPlanLegacyStable(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  const seedSegments = layer.waveGuide.seedSegments;
  const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);
  const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

  if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
    return {
      layerIndex: layer.index,
      seedSegments,
      boundarySegments: layer.waveGuide.boundarySegments,
      wavefronts: [],
      generationMode: 'vector',
      settings
    };
  }

  const wavefronts: WavePathPlan['wavefronts'] = [];
  const areaThreshold = minSignificantVectorArea(settings);
  let accumulatedGeometry: any | null = null;
  let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

  for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
    const nextGeometry = propagateJstsStepFullHistory(
      currentWavefront,
      accumulatedGeometry,
      boundaryGeometry,
      settings
    );
    const addedArea = jstsGeometryArea(nextGeometry);

    if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
      break;
    }

    accumulatedGeometry =
      accumulatedGeometry === null
        ? nextGeometry
        : jstsOverlay(
            'union',
            accumulatedGeometry,
            nextGeometry,
            fidelity.cleanupQuadrantSegments
          );

    const nextSegments = extractLegacyStableWavefrontSegments(
      nextGeometry,
      settings,
      'legacy-stable wavefront extraction'
    );

    if (nextSegments.length === 0) {
      break;
    }

    wavefronts.push({
      iteration,
      segments: nextSegments,
      cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
    });

    currentWavefront = seedSegmentsToJstsGeometry(nextSegments);
  }

  return {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments: layer.waveGuide.boundarySegments,
    wavefronts,
    generationMode: 'vector',
    settings
  };
}

function generateJstsWavePathPlanBoundaryIntersection(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  const seedSegments = layer.waveGuide.seedSegments;
  const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

  if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
    return {
      layerIndex: layer.index,
      seedSegments,
      boundarySegments: layer.waveGuide.boundarySegments,
      wavefronts: [],
      generationMode: 'vector',
      settings
    };
  }

  const wavefronts: WavePathPlan['wavefronts'] = [];
  const areaThreshold = minSignificantVectorArea(settings);
  let previousBandGeometry: any | null = null;
  let currentEmitterSegments = seedSegments;
  let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

  for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
    const backwardReferenceGeometry =
      previousBandGeometry ?? buildInitialBackwardReferenceGeometry(currentWavefront, settings);
    const nextGeometry = propagateJstsStepBoundaryIntersection(
      currentWavefront,
      boundaryGeometry,
      settings
    );
    const addedArea = jstsGeometryArea(nextGeometry);

    if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
      break;
    }

    const nextSegments = extractBackwardAwareWavefrontSegments(
      nextGeometry,
      backwardReferenceGeometry,
      currentEmitterSegments,
      layer.waveGuide.boundarySegments,
      settings,
      'boundary-intersection wavefront extraction'
    );

    if (nextSegments.length === 0) {
      break;
    }

    wavefronts.push({
      iteration,
      segments: nextSegments,
      cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
    });

    previousBandGeometry = nextGeometry;
    currentEmitterSegments = nextSegments;
    currentWavefront = seedSegmentsToJstsGeometry(nextSegments);
  }

  return {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments: layer.waveGuide.boundarySegments,
    wavefronts,
    generationMode: 'vector',
    settings
  };
}

function generateJstsWavePathPlanLocalRecurrence(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  const seedSegments = layer.waveGuide.seedSegments;
  const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

  if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
    return {
      layerIndex: layer.index,
      seedSegments,
      boundarySegments: layer.waveGuide.boundarySegments,
      wavefronts: [],
      generationMode: 'vector',
      settings
    };
  }

  const wavefronts: WavePathPlan['wavefronts'] = [];
  const areaThreshold = minSignificantVectorArea(settings);
  let previousBandGeometry: any | null = null;
  let currentEmitterSegments = seedSegments;
  let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

  for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
    const backwardReferenceGeometry =
      previousBandGeometry ?? buildInitialBackwardReferenceGeometry(currentWavefront, settings);
    const nextGeometry = propagateJstsStepLocalRecurrence(
      currentWavefront,
      previousBandGeometry,
      boundaryGeometry,
      settings
    );
    const addedArea = jstsGeometryArea(nextGeometry);

    if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
      break;
    }

    const nextSegments = extractBackwardAwareWavefrontSegments(
      nextGeometry,
      backwardReferenceGeometry,
      currentEmitterSegments,
      layer.waveGuide.boundarySegments,
      settings,
      'local wavefront extraction'
    );

    if (nextSegments.length === 0) {
      break;
    }

    wavefronts.push({
      iteration,
      segments: nextSegments,
      cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
    });

    previousBandGeometry = nextGeometry;
    currentEmitterSegments = nextSegments;
    currentWavefront = seedSegmentsToJstsGeometry(nextSegments);
  }

  return {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments: layer.waveGuide.boundarySegments,
    wavefronts,
    generationMode: 'vector',
    settings
  };
}

function generateHuygensWavePathPlan(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);
  const seedSegments = layer.waveGuide.seedSegments;

  if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
    return {
      layerIndex: layer.index,
      seedSegments,
      boundarySegments: layer.waveGuide.boundarySegments,
      wavefronts: [],
      generationMode: 'vector',
      settings
    };
  }

  const wavefronts: WavePathPlan['wavefronts'] = [];
  let currentSeedSegments = seedSegments;
  let referenceSegments = seedSegments;

  for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
    const nextStep = propagateHuygensStep(
      currentSeedSegments,
      referenceSegments,
      boundaryGeometry,
      settings
    );

    if (
      !nextStep.clippedBand ||
      !jstsHasArea(nextStep.clippedBand) ||
      nextStep.forwardSegments.length === 0
    ) {
      break;
    }

    wavefronts.push({
      iteration,
      segments: nextStep.forwardSegments,
      cellCount: Math.max(1, nextStep.forwardSegments.length)
    });

    referenceSegments = currentSeedSegments;
    currentSeedSegments = nextStep.forwardSegments;
  }

  return {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments: layer.waveGuide.boundarySegments,
    wavefronts,
    generationMode: 'vector',
    settings
  };
}

function generateJstsWavePathPlan(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  if (settings.wavePropagationModel === 'huygens') {
    return generateHuygensWavePathPlan(layer, settings);
  }

  return generateRasterWavePathPlan(layer, settings);
}

export function generateWavePathPlan(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS
): WavePathPlan {
  return generateJstsWavePathPlan(layer, settings);
}

export async function generateWavePathPlanProgressively(
  layer: AnalyzedLayerData,
  settings: WavePathSettings = DEFAULT_WAVE_PATH_SETTINGS,
  onProgress?: (plan: WavePathPlan) => void
): Promise<WavePathPlan> {
  const seedSegments = layer.waveGuide.seedSegments;
  const boundarySegments = layer.waveGuide.boundarySegments;
  const basePlan: Omit<WavePathPlan, 'wavefronts' | 'generationMode'> = {
    layerIndex: layer.index,
    seedSegments,
    boundarySegments,
    settings
  };

  const emitProgress = async (plan: WavePathPlan) => {
    onProgress?.(plan);
    await yieldToBrowser();
  };

  const generateRasterWavePathPlanProgressively = async () => {
    const grid = buildBoundaryGrid(layer, settings);

    if (!grid || seedSegments.length === 0) {
      return {
        ...basePlan,
        generationMode: 'raster-fallback' as const,
        wavefronts: []
      };
    }

    const wavefronts: WavePathPlan['wavefronts'] = [];
    const accumulated = new Set(seedOccupiedCells(grid, seedSegments).map((cell) => cell.key));
    let currentEmitterSegments = seedSegments;

    for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
      const nextCells = propagateOneStep(currentEmitterSegments, accumulated, grid, settings);

      if (nextCells.length === 0 || nextCells.length < settings.minAddedCells) {
        break;
      }

      const nextSegments = forwardContourSegmentsForCells(nextCells, grid, accumulated);

      if (nextSegments.length === 0) {
        break;
      }

      for (const cell of nextCells) {
        accumulated.add(cell.key);
      }

      wavefronts.push({
        iteration,
        segments: nextSegments,
        cellCount: nextCells.length
      });

      currentEmitterSegments = nextSegments;

      await emitProgress({
        ...basePlan,
        generationMode: 'raster-fallback',
        wavefronts: [...wavefronts]
      });
    }

    return {
      ...basePlan,
      generationMode: 'raster-fallback' as const,
      wavefronts
    };
  };

  const tryGenerateVectorProgressivelyFullHistory = async () => {
    const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);
    const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

    if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
      return {
        ...basePlan,
        generationMode: 'vector' as const,
        wavefronts: []
      };
    }

    const wavefronts: WavePathPlan['wavefronts'] = [];
    const areaThreshold = minSignificantVectorArea(settings);
    let accumulatedGeometry: any | null = null;
    let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

    for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
      const nextGeometry = propagateJstsStepFullHistory(
        currentWavefront,
        accumulatedGeometry,
        boundaryGeometry,
        settings
      );
      const addedArea = jstsGeometryArea(nextGeometry);

      if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
        break;
      }

      accumulatedGeometry =
        accumulatedGeometry === null
          ? nextGeometry
          : jstsOverlay(
              'union',
              accumulatedGeometry,
              nextGeometry,
              fidelity.cleanupQuadrantSegments
            );

      const nextSegments = withWaveTiming('full-history wavefront extraction', () =>
        cleanExtractedWavefrontSegments(
          filterWavefrontSegmentsAlongBoundaryTrim(
            wavefrontSegmentsFacingRemainingGeometry(
              jstsWriteGeometry(nextGeometry),
              jstsWriteGeometry(
                jstsOverlay(
                  'difference',
                  boundaryGeometry,
                  accumulatedGeometry,
                  fidelity.cleanupQuadrantSegments
                )
              ),
              settings
            ),
            layer.waveGuide.boundarySegments,
            settings
          ),
          settings
        )
      );

      if (nextSegments.length === 0) {
        break;
      }

      wavefronts.push({
        iteration,
        segments: nextSegments,
        cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
      });

      currentWavefront = seedSegmentsToJstsGeometry(nextSegments);

      await emitProgress({
        ...basePlan,
        generationMode: 'vector',
        wavefronts: [...wavefronts]
      });
    }

    return {
      ...basePlan,
      generationMode: 'vector' as const,
      wavefronts
    };
  };

  const tryGenerateVectorProgressivelyBoundaryIntersection = async () => {
    const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

    if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
      return {
        ...basePlan,
        generationMode: 'vector' as const,
        wavefronts: []
      };
    }

    const wavefronts: WavePathPlan['wavefronts'] = [];
    const areaThreshold = minSignificantVectorArea(settings);
    let previousBandGeometry: any | null = null;
    let currentEmitterSegments = seedSegments;
    let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

    for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
      const backwardReferenceGeometry =
        previousBandGeometry ?? buildInitialBackwardReferenceGeometry(currentWavefront, settings);
      const nextGeometry = propagateJstsStepBoundaryIntersection(
        currentWavefront,
        boundaryGeometry,
        settings
      );
      const addedArea = jstsGeometryArea(nextGeometry);

      if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
        break;
      }

      const nextSegments = extractBackwardAwareWavefrontSegments(
        nextGeometry,
        backwardReferenceGeometry,
        currentEmitterSegments,
        layer.waveGuide.boundarySegments,
        settings,
        'boundary-intersection wavefront extraction'
      );

      if (nextSegments.length === 0) {
        break;
      }

      wavefronts.push({
        iteration,
        segments: nextSegments,
        cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
      });

      previousBandGeometry = nextGeometry;
      currentEmitterSegments = nextSegments;
      currentWavefront = seedSegmentsToJstsGeometry(nextSegments);

      await emitProgress({
        ...basePlan,
        generationMode: 'vector',
        wavefronts: [...wavefronts]
      });
    }

    return {
      ...basePlan,
      generationMode: 'vector' as const,
      wavefronts
    };
  };

  const tryGenerateVectorProgressivelyLegacyStable = async () => {
    const fidelity = getFidelityProfile(settings.fidelity, settings.waveBufferQuadrantSegments);
    const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

    if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
      return {
        ...basePlan,
        generationMode: 'vector' as const,
        wavefronts: []
      };
    }

    const wavefronts: WavePathPlan['wavefronts'] = [];
    const areaThreshold = minSignificantVectorArea(settings);
    let accumulatedGeometry: any | null = null;
    let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

    for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
      const nextGeometry = propagateJstsStepFullHistory(
        currentWavefront,
        accumulatedGeometry,
        boundaryGeometry,
        settings
      );
      const addedArea = jstsGeometryArea(nextGeometry);

      if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
        break;
      }

      accumulatedGeometry =
        accumulatedGeometry === null
          ? nextGeometry
          : jstsOverlay(
              'union',
              accumulatedGeometry,
              nextGeometry,
              fidelity.cleanupQuadrantSegments
            );

      const nextSegments = extractLegacyStableWavefrontSegments(
        nextGeometry,
        settings,
        'legacy-stable wavefront extraction'
      );

      if (nextSegments.length === 0) {
        break;
      }

      wavefronts.push({
        iteration,
        segments: nextSegments,
        cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
      });

      currentWavefront = seedSegmentsToJstsGeometry(nextSegments);

      await emitProgress({
        ...basePlan,
        generationMode: 'vector',
        wavefronts: [...wavefronts]
      });
    }

    return {
      ...basePlan,
      generationMode: 'vector' as const,
      wavefronts
    };
  };

  const tryGenerateVectorProgressivelyLocalRecurrence = async () => {
    const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

    if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
      return {
        ...basePlan,
        generationMode: 'vector' as const,
        wavefronts: []
      };
    }

    const wavefronts: WavePathPlan['wavefronts'] = [];
    const areaThreshold = minSignificantVectorArea(settings);
    let previousBandGeometry: any | null = null;
    let currentEmitterSegments = seedSegments;
    let currentWavefront: any = seedSegmentsToJstsGeometry(seedSegments);

    for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
      const backwardReferenceGeometry =
        previousBandGeometry ?? buildInitialBackwardReferenceGeometry(currentWavefront, settings);
      const nextGeometry = propagateJstsStepLocalRecurrence(
        currentWavefront,
        previousBandGeometry,
        boundaryGeometry,
        settings
      );
      const addedArea = jstsGeometryArea(nextGeometry);

      if (!jstsHasArea(nextGeometry) || addedArea < areaThreshold) {
        break;
      }

      const nextSegments = extractBackwardAwareWavefrontSegments(
        nextGeometry,
        backwardReferenceGeometry,
        currentEmitterSegments,
        layer.waveGuide.boundarySegments,
        settings,
        'local wavefront extraction'
      );

      if (nextSegments.length === 0) {
        break;
      }

      wavefronts.push({
        iteration,
        segments: nextSegments,
        cellCount: Math.max(1, Math.round(addedArea / settings.discretizationDistance ** 2))
      });

      previousBandGeometry = nextGeometry;
      currentEmitterSegments = nextSegments;
      currentWavefront = seedSegmentsToJstsGeometry(nextSegments);

      await emitProgress({
        ...basePlan,
        generationMode: 'vector',
        wavefronts: [...wavefronts]
      });
    }

    return {
      ...basePlan,
      generationMode: 'vector' as const,
      wavefronts
    };
  };

  const generateHuygensWavePathPlanProgressively = async () => {
    const boundaryGeometry = overhangBoundaryToJstsGeometry(layer, settings);

    if (!jstsHasArea(boundaryGeometry) || seedSegments.length === 0) {
      return {
        ...basePlan,
        generationMode: 'vector' as const,
        wavefronts: []
      };
    }

    const wavefronts: WavePathPlan['wavefronts'] = [];
    let currentSeedSegments = seedSegments;
    let referenceSegments = seedSegments;

    for (let iteration = 1; iteration <= settings.iterationLimit; iteration += 1) {
      const nextStep = propagateHuygensStep(
        currentSeedSegments,
        referenceSegments,
        boundaryGeometry,
        settings
      );

      if (
        !nextStep.clippedBand ||
        !jstsHasArea(nextStep.clippedBand) ||
        nextStep.forwardSegments.length === 0
      ) {
        break;
      }

      wavefronts.push({
        iteration,
        segments: nextStep.forwardSegments,
        cellCount: Math.max(1, nextStep.forwardSegments.length)
      });

      referenceSegments = currentSeedSegments;
      currentSeedSegments = nextStep.forwardSegments;

      await emitProgress({
        ...basePlan,
        generationMode: 'vector',
        wavefronts: [...wavefronts]
      });
    }

    return {
      ...basePlan,
      generationMode: 'vector' as const,
      wavefronts
    };
  };

  if (settings.wavePropagationModel === 'huygens') {
    return generateHuygensWavePathPlanProgressively();
  }

  return generateRasterWavePathPlanProgressively();
}

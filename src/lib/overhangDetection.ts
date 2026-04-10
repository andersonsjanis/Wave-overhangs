import { DEFAULT_OVERHANG_SETTINGS } from './config';
import { createBoundsFromSegments, distancePointToSegment, pointOnSegment } from './geometry';
import type {
  AnalyzedGcode,
  AnalyzedLayerData,
  AnalyzedSegment,
  Bounds,
  LinePart,
  MultiPolygonShape,
  OverhangSettings,
  ParsedGcode,
  PolygonRing,
  ToolpathSegment,
  WaveOverhangGuide
} from '../types/gcode';

const MIN_SEGMENT_LENGTH = 1e-6;

interface FootprintGrid {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  cellSize: number;
  cells: Uint8Array;
}

function emptyGrid(): FootprintGrid {
  return {
    minX: 0,
    minY: 0,
    cols: 0,
    rows: 0,
    cellSize: 1,
    cells: new Uint8Array()
  };
}

function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  };
}

function getGridCellSize(bounds: Bounds, settings: OverhangSettings) {
  const width = Math.max(bounds.maxX - bounds.minX, settings.footprintGridSize);
  const height = Math.max(bounds.maxY - bounds.minY, settings.footprintGridSize);
  const requestedCellSize = Math.max(settings.footprintGridSize, MIN_SEGMENT_LENGTH);
  const requestedCellCount =
    Math.ceil(width / requestedCellSize) * Math.ceil(height / requestedCellSize);

  if (requestedCellCount <= settings.maxFootprintGridCells) {
    return requestedCellSize;
  }

  return Math.sqrt((width * height) / settings.maxFootprintGridCells);
}

function buildLayerOuterFootprintGrid(
  segments: ToolpathSegment[],
  settings: OverhangSettings
): FootprintGrid {
  const segmentBounds = createBoundsFromSegments(segments);

  if (!segmentBounds) {
    return emptyGrid();
  }

  const halfWidth = settings.extrusionWidth / 2;
  const bounds = expandBounds(segmentBounds, settings.extrusionWidth * 2);
  const cellSize = getGridCellSize(bounds, settings);
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize));
  const depositedCells = new Uint8Array(cols * rows);

  const toColumn = (x: number) => Math.floor((x - bounds.minX) / cellSize);
  const toRow = (y: number) => Math.floor((y - bounds.minY) / cellSize);

  for (const segment of segments) {
    const minColumn = Math.max(0, toColumn(Math.min(segment.x1, segment.x2) - halfWidth));
    const maxColumn = Math.min(cols - 1, toColumn(Math.max(segment.x1, segment.x2) + halfWidth));
    const minRow = Math.max(0, toRow(Math.min(segment.y1, segment.y2) - halfWidth));
    const maxRow = Math.min(rows - 1, toRow(Math.max(segment.y1, segment.y2) + halfWidth));

    for (let row = minRow; row <= maxRow; row += 1) {
      const y = bounds.minY + (row + 0.5) * cellSize;
      for (let col = minColumn; col <= maxColumn; col += 1) {
        const x = bounds.minX + (col + 0.5) * cellSize;

        if (distancePointToSegment({ x, y }, segment) <= halfWidth) {
          depositedCells[row * cols + col] = 1;
        }
      }
    }
  }

  return {
    minX: bounds.minX,
    minY: bounds.minY,
    cols,
    rows,
    cellSize,
    // Fill interior holes by flood-filling outside empty space, then treating
    // all non-outside cells as part of the outer layer footprint.
    cells: removeInteriorHoles(depositedCells, cols, rows)
  };
}

function removeInteriorHoles(depositedCells: Uint8Array, cols: number, rows: number) {
  const exterior = new Uint8Array(depositedCells.length);
  const queue: number[] = [];

  const enqueueIfExterior = (col: number, row: number) => {
    const index = row * cols + col;

    if (depositedCells[index] === 0 && exterior[index] === 0) {
      exterior[index] = 1;
      queue.push(index);
    }
  };

  for (let col = 0; col < cols; col += 1) {
    enqueueIfExterior(col, 0);
    enqueueIfExterior(col, rows - 1);
  }

  for (let row = 0; row < rows; row += 1) {
    enqueueIfExterior(0, row);
    enqueueIfExterior(cols - 1, row);
  }

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const index = queue[queueIndex];
    const col = index % cols;
    const row = Math.floor(index / cols);

    if (col > 0) enqueueIfExterior(col - 1, row);
    if (col < cols - 1) enqueueIfExterior(col + 1, row);
    if (row > 0) enqueueIfExterior(col, row - 1);
    if (row < rows - 1) enqueueIfExterior(col, row + 1);
  }

  const outerFootprintCells = new Uint8Array(depositedCells.length);
  for (let index = 0; index < depositedCells.length; index += 1) {
    outerFootprintCells[index] = depositedCells[index] || !exterior[index] ? 1 : 0;
  }

  return outerFootprintCells;
}

function isPointInsideFootprint(grid: FootprintGrid, x: number, y: number) {
  if (grid.cols === 0 || grid.rows === 0) {
    return false;
  }

  const col = Math.floor((x - grid.minX) / grid.cellSize);
  const row = Math.floor((y - grid.minY) / grid.cellSize);

  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) {
    return false;
  }

  return grid.cells[row * grid.cols + col] === 1;
}

function cellToPolygon(grid: FootprintGrid, col: number, row: number): PolygonRing[] {
  const x1 = grid.minX + col * grid.cellSize;
  const y1 = grid.minY + row * grid.cellSize;
  const x2 = x1 + grid.cellSize;
  const y2 = y1 + grid.cellSize;

  return [[
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1]
  ]];
}

function cellCenter(grid: FootprintGrid, col: number, row: number) {
  return {
    x: grid.minX + (col + 0.5) * grid.cellSize,
    y: grid.minY + (row + 0.5) * grid.cellSize
  };
}

function cellEdgeToLinePart(
  grid: FootprintGrid,
  col: number,
  row: number,
  direction: { col: number; row: number }
): LinePart {
  const x1 = grid.minX + col * grid.cellSize;
  const y1 = grid.minY + row * grid.cellSize;
  const x2 = x1 + grid.cellSize;
  const y2 = y1 + grid.cellSize;

  if (direction.col < 0) {
    return { x1, y1, x2: x1, y2, length: grid.cellSize };
  }

  if (direction.col > 0) {
    return { x1: x2, y1, x2, y2, length: grid.cellSize };
  }

  if (direction.row < 0) {
    return { x1, y1, x2, y2: y1, length: grid.cellSize };
  }

  return { x1, y1: y2, x2, y2, length: grid.cellSize };
}

function mergeAxisAlignedLines(lines: LinePart[]): LinePart[] {
  const horizontal = new Map<string, Array<{ start: number; end: number; y: number }>>();
  const vertical = new Map<string, Array<{ start: number; end: number; x: number }>>();
  const other: LinePart[] = [];

  for (const line of lines) {
    if (Math.abs(line.y1 - line.y2) < MIN_SEGMENT_LENGTH) {
      const y = line.y1;
      const key = y.toFixed(6);
      const entries = horizontal.get(key) ?? [];
      entries.push({ start: Math.min(line.x1, line.x2), end: Math.max(line.x1, line.x2), y });
      horizontal.set(key, entries);
    } else if (Math.abs(line.x1 - line.x2) < MIN_SEGMENT_LENGTH) {
      const x = line.x1;
      const key = x.toFixed(6);
      const entries = vertical.get(key) ?? [];
      entries.push({ start: Math.min(line.y1, line.y2), end: Math.max(line.y1, line.y2), x });
      vertical.set(key, entries);
    } else {
      other.push(line);
    }
  }

  const merged: LinePart[] = [...other];

  for (const entries of horizontal.values()) {
    entries.sort((a, b) => a.start - b.start);
    let current = entries[0];

    for (const entry of entries.slice(1)) {
      if (entry.start <= current.end + MIN_SEGMENT_LENGTH) {
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
      if (entry.start <= current.end + MIN_SEGMENT_LENGTH) {
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

  return merged.filter((line) => line.length > MIN_SEGMENT_LENGTH);
}

function buildWaveGuideFromOverhangMask(
  currentFootprint: FootprintGrid,
  previousFootprint: FootprintGrid,
  overhangCells: Uint8Array
): WaveOverhangGuide {
  const seedSegments: LinePart[] = [];
  const boundarySegments: LinePart[] = [];
  const directions = [
    { col: -1, row: 0 },
    { col: 1, row: 0 },
    { col: 0, row: -1 },
    { col: 0, row: 1 }
  ];

  const isOverhangCell = (col: number, row: number) => {
    if (
      col < 0 ||
      col >= currentFootprint.cols ||
      row < 0 ||
      row >= currentFootprint.rows
    ) {
      return false;
    }

    return overhangCells[row * currentFootprint.cols + col] === 1;
  };

  for (let row = 0; row < currentFootprint.rows; row += 1) {
    for (let col = 0; col < currentFootprint.cols; col += 1) {
      if (!isOverhangCell(col, row)) {
        continue;
      }

      for (const direction of directions) {
        const neighborCol = col + direction.col;
        const neighborRow = row + direction.row;

        if (isOverhangCell(neighborCol, neighborRow)) {
          continue;
        }

        const line = cellEdgeToLinePart(currentFootprint, col, row, direction);
        const neighbor = cellCenter(currentFootprint, neighborCol, neighborRow);
        const edgeMidpoint = pointOnSegment(line, 0.5);
        const neighborIsSupported =
          isPointInsideFootprint(previousFootprint, neighbor.x, neighbor.y) ||
          isPointInsideFootprint(previousFootprint, edgeMidpoint.x, edgeMidpoint.y);

        if (neighborIsSupported) {
          seedSegments.push(line);
        } else {
          boundarySegments.push(line);
        }
      }
    }
  }

  return {
    seedSegments: mergeAxisAlignedLines(seedSegments),
    boundarySegments: mergeAxisAlignedLines(boundarySegments)
  };
}

function computeOverhangCells(
  currentFootprint: FootprintGrid,
  previousFootprint: FootprintGrid,
  settings: OverhangSettings
): { overhangRegion: MultiPolygonShape; overhangArea: number; waveGuide: WaveOverhangGuide } {
  const overhangRegion: MultiPolygonShape = [];
  let overhangArea = 0;
  const overhangCells = new Uint8Array(currentFootprint.cells.length);

  if (currentFootprint.cols === 0 || currentFootprint.rows === 0) {
    return {
      overhangRegion,
      overhangArea,
      waveGuide: { seedSegments: [], boundarySegments: [] }
    };
  }

  for (let row = 0; row < currentFootprint.rows; row += 1) {
    for (let col = 0; col < currentFootprint.cols; col += 1) {
      const index = row * currentFootprint.cols + col;
      if (currentFootprint.cells[index] === 0) {
        continue;
      }

      const x = currentFootprint.minX + (col + 0.5) * currentFootprint.cellSize;
      const y = currentFootprint.minY + (row + 0.5) * currentFootprint.cellSize;

      if (!isPointInsideFootprint(previousFootprint, x, y)) {
        overhangCells[index] = 1;
        overhangArea += currentFootprint.cellSize * currentFootprint.cellSize;
        if (overhangArea > settings.overhangAreaThreshold) {
          overhangRegion.push(cellToPolygon(currentFootprint, col, row));
        }
      }
    }
  }

  return {
    overhangRegion,
    overhangArea,
    waveGuide: buildWaveGuideFromOverhangMask(
      currentFootprint,
      previousFootprint,
      overhangCells
    )
  };
}

function linePartFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): LinePart {
  return {
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    length: Math.hypot(end.x - start.x, end.y - start.y)
  };
}

function mergeLineParts(parts: LinePart[], nextPart: LinePart): LinePart[] {
  const previous = parts[parts.length - 1];

  if (
    previous &&
    Math.abs(previous.x2 - nextPart.x1) < MIN_SEGMENT_LENGTH &&
    Math.abs(previous.y2 - nextPart.y1) < MIN_SEGMENT_LENGTH
  ) {
    previous.x2 = nextPart.x2;
    previous.y2 = nextPart.y2;
    previous.length += nextPart.length;
    return parts;
  }

  parts.push(nextPart);
  return parts;
}

function splitSegmentByOverhangRegion(
  segment: ToolpathSegment,
  previousFootprint: FootprintGrid,
  settings: OverhangSettings
): { normalParts: LinePart[]; overhangParts: LinePart[]; overhangRatio: number } {
  if (previousFootprint.cols === 0 || previousFootprint.rows === 0) {
    return {
      normalParts: [
        linePartFromPoints({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 })
      ],
      overhangParts: [],
      overhangRatio: 0
    };
  }

  const stepCount = Math.max(1, Math.ceil(segment.length / settings.samplingStep));
  const normalParts: LinePart[] = [];
  const overhangParts: LinePart[] = [];
  let overhangLength = 0;

  for (let index = 0; index < stepCount; index += 1) {
    const start = pointOnSegment(segment, index / stepCount);
    const end = pointOnSegment(segment, (index + 1) / stepCount);
    const part = linePartFromPoints(start, end);

    if (part.length < MIN_SEGMENT_LENGTH) {
      continue;
    }

    const midpoint = pointOnSegment(part, 0.5);
    const isOverhang = !isPointInsideFootprint(previousFootprint, midpoint.x, midpoint.y);

    if (isOverhang) {
      overhangLength += part.length;
      mergeLineParts(overhangParts, part);
    } else {
      mergeLineParts(normalParts, part);
    }
  }

  return {
    normalParts,
    overhangParts,
    overhangRatio: segment.length > 0 ? overhangLength / segment.length : 0
  };
}

function analyzeSegment(
  segment: ToolpathSegment,
  previousFootprint: FootprintGrid,
  settings: OverhangSettings
): AnalyzedSegment {
  const { normalParts, overhangParts, overhangRatio } = splitSegmentByOverhangRegion(
    segment,
    previousFootprint,
    settings
  );

  return {
    ...segment,
    // Retained for existing UI/tests: supported length = 1 - overhanging length.
    supportRatio: 1 - overhangRatio,
    overhangRatio,
    isCandidateOverhang: overhangParts.length > 0,
    normalParts,
    overhangParts
  };
}

export function analyzeOverhangs(
  parsed: ParsedGcode,
  settings: OverhangSettings = DEFAULT_OVERHANG_SETTINGS
): AnalyzedGcode {
  const footprints = parsed.layers.map((layer) =>
    buildLayerOuterFootprintGrid(layer.extrusionSegments, settings)
  );

  const analyzedLayers: AnalyzedLayerData[] = parsed.layers.map((layer, index) => {
    const previousFootprint = index > 0 ? footprints[index - 1] : emptyGrid();
    const footprint = footprints[index];
    const treatAsBuildPlateSupported = index <= 1;
    const { overhangRegion, overhangArea, waveGuide } =
      treatAsBuildPlateSupported
        ? {
            overhangRegion: [],
            overhangArea: 0,
            waveGuide: { seedSegments: [], boundarySegments: [] }
          }
        : computeOverhangCells(footprint, previousFootprint, settings);
    const analyzedSegments = treatAsBuildPlateSupported
      ? layer.extrusionSegments.map((segment) => ({
          ...segment,
          supportRatio: 1,
          overhangRatio: 0,
          isCandidateOverhang: false,
          normalParts: [
            {
              x1: segment.x1,
              y1: segment.y1,
              x2: segment.x2,
              y2: segment.y2,
              length: segment.length
            }
          ],
          overhangParts: []
        }))
      : layer.extrusionSegments.map((segment) =>
          analyzeSegment(segment, previousFootprint, settings)
        );

    return {
      ...layer,
      extrusionSegments: analyzedSegments,
      overhangSegmentCount: analyzedSegments.filter((segment) => segment.isCandidateOverhang)
        .length,
      footprint: [],
      overhangRegion,
      overhangArea,
      waveGuide
    };
  });

  return {
    ...parsed,
    layers: analyzedLayers,
    extrusionSegments: analyzedLayers.flatMap((layer) => layer.extrusionSegments),
    settings
  };
}

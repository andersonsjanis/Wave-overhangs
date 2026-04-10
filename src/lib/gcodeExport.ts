import { splitSegmentsIntoConnectedPolylines } from './polyline';
import type {
  AnalyzedGcode,
  AnalyzedLayerData,
  AnalyzedSegment,
  Coordinate,
  GcodeExportSettings,
  LinePart,
  PositioningMode,
  WavePathPlan
} from '../types/gcode';
import { DEFAULT_GCODE_EXPORT_SETTINGS } from './config';

const EXPORT_PRINT_FEEDRATE = 120;
const EXPORT_TRAVEL_FEEDRATE = 60 * 40;
const POSITION_EPSILON = 1e-6;
const EXTRUSION_EPSILON = 1e-9;
const EXTRUSION_DECIMALS = 5;

interface ExportOptions {
  printFeedrate?: number;
  travelFeedrate?: number;
  beadArea?: number;
  filamentDiameter?: number;
  retractionDistance?: number;
}

interface CursorState {
  x: number;
  y: number;
}

interface ReplacementMotionSettings extends GcodeExportSettings {
  printFeedrate: number;
  travelFeedrate: number;
}

interface VisiblePathPart {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  feedrate: number;
  sourceLineNumber: number;
}

interface LineBlockReplacement {
  startLineNumber: number;
  endLineNumber: number;
  lines: string[];
}

function appendLines(target: string[], lines: string[]) {
  for (const line of lines) {
    target.push(line);
  }
}

function formatCoordinate(value: number) {
  const rounded = Math.abs(value) < POSITION_EPSILON ? 0 : value;
  return rounded.toFixed(3).replace(/\.?0+$/, '');
}

function formatExtrusionDistance(value: number) {
  const rounded = Math.abs(value) < EXTRUSION_EPSILON ? 0 : value;
  return rounded.toFixed(EXTRUSION_DECIMALS).replace(/\.?0+$/, '');
}

function sameCursor(cursor: CursorState, point: Coordinate) {
  return (
    Math.abs(cursor.x - point[0]) < POSITION_EPSILON &&
    Math.abs(cursor.y - point[1]) < POSITION_EPSILON
  );
}

function calculateExtrusionDistance(
  segmentLength: number,
  beadArea: number,
  filamentDiameter: number
) {
  const filamentRadius = filamentDiameter / 2;
  const filamentArea = Math.PI * filamentRadius * filamentRadius;
  return (beadArea * segmentLength) / filamentArea;
}

function beginRelativeExtrusionBlock(lines: string[], extrusionMode: PositioningMode) {
  if (extrusionMode === 'absolute') {
    lines.push('M83');
  }
}

function endRelativeExtrusionBlock(
  lines: string[],
  extrusionMode: PositioningMode,
  extrusionPositionEnd: number
) {
  if (extrusionMode === 'absolute') {
    lines.push('M82');
    lines.push(`G92 E${formatExtrusionDistance(extrusionPositionEnd)}`);
  }
}

function emitTravelMove(
  lines: string[],
  cursor: CursorState,
  point: Coordinate,
  feedrate: number,
  retractionDistance: number
) {
  if (sameCursor(cursor, point)) {
    return;
  }

  if (retractionDistance > EXTRUSION_EPSILON) {
    lines.push(`G1 E-${formatExtrusionDistance(retractionDistance)}`);
  }

  lines.push(
    `G0 F${formatCoordinate(feedrate)} X${formatCoordinate(point[0])} Y${formatCoordinate(point[1])}`
  );

  if (retractionDistance > EXTRUSION_EPSILON) {
    lines.push(`G1 E${formatExtrusionDistance(retractionDistance)}`);
  }

  cursor.x = point[0];
  cursor.y = point[1];
}

function emitPrintMove(
  lines: string[],
  cursor: CursorState,
  point: Coordinate,
  feedrate: number,
  beadArea: number,
  filamentDiameter: number
) {
  if (sameCursor(cursor, point)) {
    return;
  }

  const extrusionDistance = calculateExtrusionDistance(
    Math.hypot(point[0] - cursor.x, point[1] - cursor.y),
    beadArea,
    filamentDiameter
  );
  lines.push(
    `G1 F${formatCoordinate(feedrate)} X${formatCoordinate(point[0])} Y${formatCoordinate(
      point[1]
    )} E${formatExtrusionDistance(extrusionDistance)}`
  );
  cursor.x = point[0];
  cursor.y = point[1];
}

function emitSegmentParts(
  lines: string[],
  cursor: CursorState,
  parts: LinePart[],
  settings: ReplacementMotionSettings
) {
  for (const part of parts) {
    emitTravelMove(
      lines,
      cursor,
      [part.x1, part.y1],
      settings.travelFeedrate,
      settings.retractionDistance
    );
    emitPrintMove(
      lines,
      cursor,
      [part.x2, part.y2],
      settings.printFeedrate,
      settings.beadArea,
      settings.filamentDiameter
    );
  }
}

function orientPolylineFromCursor(polyline: Coordinate[], cursor: CursorState) {
  const start = polyline[0];
  const end = polyline[polyline.length - 1];
  const distanceToStart = Math.hypot(cursor.x - start[0], cursor.y - start[1]);
  const distanceToEnd = Math.hypot(cursor.x - end[0], cursor.y - end[1]);
  return distanceToStart <= distanceToEnd ? polyline : [...polyline].reverse();
}

function orderPolylinesForCursor(polylines: Coordinate[][], cursor: CursorState) {
  const remaining = [...polylines];
  const ordered: Coordinate[][] = [];
  let current = { ...cursor };

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestOrientation: Coordinate[] | null = null;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = orientPolylineFromCursor(remaining[index], current);
      const start = candidate[0];
      const distance = Math.hypot(current.x - start[0], current.y - start[1]);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
        bestOrientation = candidate;
      }
    }

    const next = bestOrientation ?? remaining[bestIndex];
    ordered.push(next);
    const end = next[next.length - 1];
    current = { x: end[0], y: end[1] };
    remaining.splice(bestIndex, 1);
  }

  return ordered;
}

function emitPolylinePathBlock(
  lines: string[],
  cursor: CursorState,
  polylines: Coordinate[][],
  settings: ReplacementMotionSettings
) {
  const orderedPolylines = orderPolylinesForCursor(polylines, cursor);

  for (const polyline of orderedPolylines) {
    emitTravelMove(
      lines,
      cursor,
      polyline[0],
      settings.travelFeedrate,
      settings.retractionDistance
    );

    for (const point of polyline.slice(1)) {
      emitPrintMove(
        lines,
        cursor,
        point,
        settings.printFeedrate,
        settings.beadArea,
        settings.filamentDiameter
      );
    }
  }
}

function emitWavefrontPathBlock(
  lines: string[],
  cursor: CursorState,
  plan: WavePathPlan,
  settings: ReplacementMotionSettings
) {
  if (plan.seedSegments.length > 0) {
    emitPolylinePathBlock(
      lines,
      cursor,
      splitSegmentsIntoConnectedPolylines(plan.seedSegments),
      settings
    );
  }

  for (const wavefront of plan.wavefronts) {
    emitPolylinePathBlock(
      lines,
      cursor,
      splitSegmentsIntoConnectedPolylines(wavefront.segments),
      settings
    );
  }
}

function visiblePartsFromSegment(
  segment: AnalyzedSegment,
  settings: ReplacementMotionSettings
): VisiblePathPart[] {
  const feedrate = segment.feedrate ?? settings.printFeedrate;

  if (!segment.isCandidateOverhang) {
    return [
      {
        x1: segment.x1,
        y1: segment.y1,
        x2: segment.x2,
        y2: segment.y2,
        length: segment.length,
        feedrate,
        sourceLineNumber: segment.sourceLineNumber
      }
    ];
  }

  return segment.normalParts.map((part) => ({
    x1: part.x1,
    y1: part.y1,
    x2: part.x2,
    y2: part.y2,
    length: part.length,
    feedrate,
    sourceLineNumber: segment.sourceLineNumber
  }));
}

function firstSegmentLineNumber(layer: AnalyzedLayerData) {
  const lineNumbers = [
    ...layer.extrusionSegments.map((segment) => segment.sourceLineNumber),
    ...layer.travelSegments.map((segment) => segment.sourceLineNumber)
  ];

  return lineNumbers.length > 0 ? Math.min(...lineNumbers) : null;
}

function lastSegmentLineNumber(layer: AnalyzedLayerData) {
  const lineNumbers = [
    ...layer.extrusionSegments.map((segment) => segment.sourceLineNumber),
    ...layer.travelSegments.map((segment) => segment.sourceLineNumber)
  ];

  return lineNumbers.length > 0 ? Math.max(...lineNumbers) : null;
}

function nextLayerStartLineNumber(data: AnalyzedGcode, layerIndex: number) {
  for (let index = layerIndex + 1; index < data.layers.length; index += 1) {
    const lineNumber = firstSegmentLineNumber(data.layers[index]);

    if (lineNumber !== null) {
      return lineNumber;
    }
  }

  return null;
}

function replacementLayerIndexes(
  data: AnalyzedGcode,
  wavePathPlans: Record<number, WavePathPlan>
) {
  return data.layers
    .filter(
      (layer) =>
        layer.extrusionSegments.some((segment) => segment.isCandidateOverhang) &&
        wavePathPlans[layer.index] &&
        wavePathPlans[layer.index].wavefronts.length > 0
    )
    .map((layer) => layer.index);
}

function defaultOutputFileName(fileName: string) {
  return fileName.replace(/(?:\.gcode|\.txt)?$/i, '-post-processed.gcode');
}

function buildLayerReplacement(
  data: AnalyzedGcode,
  layer: AnalyzedLayerData,
  plan: WavePathPlan,
  settings: ReplacementMotionSettings
): LineBlockReplacement | null {
  const sortedExtrusionSegments = [...layer.extrusionSegments].sort(
    (left, right) => left.sourceLineNumber - right.sourceLineNumber
  );
  const firstSegment = sortedExtrusionSegments[0];
  const lastSegment = sortedExtrusionSegments[sortedExtrusionSegments.length - 1];
  const startLineNumber = firstSegmentLineNumber(layer);
  const fallbackEndLineNumber = lastSegmentLineNumber(layer);

  if (!firstSegment || !lastSegment || startLineNumber === null || fallbackEndLineNumber === null) {
    return null;
  }

  const nextLayerStart = nextLayerStartLineNumber(data, layer.index);
  const endLineNumber =
    nextLayerStart !== null ? nextLayerStart - 1 : fallbackEndLineNumber;
  const lastCandidateSourceLine = Math.max(
    ...sortedExtrusionSegments
      .filter((segment) => segment.isCandidateOverhang)
      .map((segment) => segment.sourceLineNumber)
  );
  const leadingVisibleParts: VisiblePathPart[] = [];
  const trailingVisibleParts: VisiblePathPart[] = [];

  for (const segment of sortedExtrusionSegments) {
    const target =
      segment.sourceLineNumber <= lastCandidateSourceLine
        ? leadingVisibleParts
        : trailingVisibleParts;

    for (const part of visiblePartsFromSegment(segment, settings)) {
      target.push(part);
    }
  }
  const firstWaveSegment =
    plan.seedSegments[0] ?? plan.wavefronts[0]?.segments[0] ?? null;

  if (
    leadingVisibleParts.length === 0 &&
    trailingVisibleParts.length === 0 &&
    firstWaveSegment === null
  ) {
    return null;
  }

  const initialPoint: Coordinate =
    leadingVisibleParts.length > 0
      ? [leadingVisibleParts[0].x1, leadingVisibleParts[0].y1]
      : trailingVisibleParts.length > 0
        ? [trailingVisibleParts[0].x1, trailingVisibleParts[0].y1]
      : [firstWaveSegment!.x1, firstWaveSegment!.y1];
  const lines: string[] = [`;POST_PROCESSED_LAYER_START layer ${layer.index}`];
  const cursor: CursorState = { x: initialPoint[0], y: initialPoint[1] };

  beginRelativeExtrusionBlock(lines, firstSegment.extrusionMode);

  for (const part of leadingVisibleParts) {
    emitTravelMove(
      lines,
      cursor,
      [part.x1, part.y1],
      settings.travelFeedrate,
      settings.retractionDistance
    );
    emitPrintMove(
      lines,
      cursor,
      [part.x2, part.y2],
      part.feedrate,
      settings.beadArea,
      settings.filamentDiameter
    );
  }

  lines.push(`;WAVE_OVERHANG_REPLACEMENT_START layer ${plan.layerIndex}`);
  emitWavefrontPathBlock(lines, cursor, plan, settings);
  lines.push(`;WAVE_OVERHANG_REPLACEMENT_END layer ${plan.layerIndex}`);

  for (const part of trailingVisibleParts) {
    emitTravelMove(
      lines,
      cursor,
      [part.x1, part.y1],
      settings.travelFeedrate,
      settings.retractionDistance
    );
    emitPrintMove(
      lines,
      cursor,
      [part.x2, part.y2],
      part.feedrate,
      settings.beadArea,
      settings.filamentDiameter
    );
  }

  endRelativeExtrusionBlock(lines, firstSegment.extrusionMode, lastSegment.extrusionPositionEnd);
  lines.push(`;POST_PROCESSED_LAYER_END layer ${layer.index}`);

  return {
    startLineNumber,
    endLineNumber,
    lines
  };
}

export function buildPostProcessedGcode(
  data: AnalyzedGcode,
  wavePathPlans: Record<number, WavePathPlan>,
  options: ExportOptions = {}
) {
  const printFeedrate = options.printFeedrate ?? EXPORT_PRINT_FEEDRATE;
  const travelFeedrate = options.travelFeedrate ?? EXPORT_TRAVEL_FEEDRATE;
  const beadArea = options.beadArea ?? DEFAULT_GCODE_EXPORT_SETTINGS.beadArea;
  const filamentDiameter =
    options.filamentDiameter ?? DEFAULT_GCODE_EXPORT_SETTINGS.filamentDiameter;
  const retractionDistance =
    options.retractionDistance ?? DEFAULT_GCODE_EXPORT_SETTINGS.retractionDistance;
  const layerIndexes = replacementLayerIndexes(data, wavePathPlans);

  if (beadArea <= EXTRUSION_EPSILON) {
    throw new Error('A_bead must be greater than 0 to generate extrusion commands.');
  }

  if (filamentDiameter <= EXTRUSION_EPSILON) {
    throw new Error('d_nozzle must be greater than 0 to generate extrusion commands.');
  }

  if (retractionDistance < 0) {
    throw new Error('Retraction distance cannot be negative.');
  }

  if (layerIndexes.length === 0) {
    throw new Error('Generate at least one wave path plan before exporting output G-code.');
  }

  const motionSettings: ReplacementMotionSettings = {
    printFeedrate,
    travelFeedrate,
    beadArea,
    filamentDiameter,
    retractionDistance
  };
  const replacements = layerIndexes
    .map((layerIndex) =>
      buildLayerReplacement(
        data,
        data.layers[layerIndex],
        wavePathPlans[layerIndex],
        motionSettings
      )
    )
    .filter((replacement): replacement is LineBlockReplacement => replacement !== null)
    .sort((left, right) => left.startLineNumber - right.startLineNumber);

  const outputLines: string[] = [];
  let lineIndex = 0;
  let replacementIndex = 0;

  while (lineIndex < data.sourceLines.length) {
    const lineNumber = lineIndex + 1;
    const replacement = replacements[replacementIndex];

    if (replacement && lineNumber === replacement.startLineNumber) {
      appendLines(outputLines, replacement.lines);
      lineIndex = replacement.endLineNumber;
      replacementIndex += 1;
    } else {
      outputLines.push(data.sourceLines[lineIndex]);
    }

    lineIndex += 1;
  }

  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === '') {
    outputLines.pop();
  }

  return {
    content: outputLines.join('\n'),
    fileName: defaultOutputFileName(data.fileName),
    modifiedLayerIndexes: layerIndexes
  };
}

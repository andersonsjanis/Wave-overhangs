import { createBoundsFromSegments, segmentLength } from './geometry';
import type {
  Bounds,
  LayerData,
  ParseOptions,
  PositioningMode,
  ParsedGcode,
  ToolpathSegment
} from '../types/gcode';

interface MachineState {
  x: number | null;
  y: number | null;
  z: number | null;
  e: number;
  feedrate: number | null;
  xyzMode: PositioningMode;
  extrusionMode: PositioningMode;
}

interface ParsedCommand {
  command: string;
  params: Record<string, number>;
}

const MOVE_COMMANDS = new Set(['G0', 'G1']);
const XYZ_KEYS = ['X', 'Y', 'Z'] as const;
const EPSILON = 1e-7;
const WORD_PATTERN = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+(?!\.))?)/g;

function parseCommand(line: string): ParsedCommand | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  const params: Record<string, number> = {};
  let command: string | null = null;

  for (const match of trimmed.matchAll(WORD_PATTERN)) {
    const key = match[1].toUpperCase();
    const value = Number.parseFloat(match[2]);

    if (!Number.isFinite(value)) {
      continue;
    }

    if (command === null && (key === 'G' || key === 'M' || key === 'T')) {
      command = `${key}${Math.trunc(value)}`;
      continue;
    }

    params[key] = value;
  }

  if (command === null) {
    return null;
  }

  return { command, params };
}

function stripInlineComment(line: string): string {
  const semicolonIndex = line.indexOf(';');
  return semicolonIndex >= 0 ? line.slice(0, semicolonIndex) : line;
}

function createLayer(index: number, z: number): LayerData {
  return {
    index,
    z,
    extrusionSegments: [],
    travelSegments: [],
    bounds: null
  };
}

function updateLayerBounds(layer: LayerData) {
  layer.bounds = createBoundsFromSegments([
    ...layer.extrusionSegments,
    ...layer.travelSegments
  ]);
}

function resolveAxis(
  current: number | null,
  rawValue: number | undefined,
  mode: PositioningMode
) {
  if (rawValue === undefined) {
    return current;
  }

  return mode === 'absolute' || current === null ? rawValue : current + rawValue;
}

export function parseGcode(content: string, options: ParseOptions = {}): ParsedGcode {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const warnings: string[] = [];
  const layers: LayerData[] = [];
  const extrusionSegments: ToolpathSegment[] = [];
  const travelSegments: ToolpathSegment[] = [];
  const layerByRoundedZ = new Map<string, LayerData>();

  const state: MachineState = {
    x: null,
    y: null,
    z: null,
    e: 0,
    feedrate: null,
    xyzMode: 'absolute',
    extrusionMode: 'absolute'
  };

  let activeLayer: LayerData | null = null;
  let segmentCounter = 0;

  const ensureLayer = (z: number) => {
    const roundedZ = z.toFixed(5);
    const existing = layerByRoundedZ.get(roundedZ);

    if (existing) {
      activeLayer = existing;
      return existing;
    }

    const layer = createLayer(layers.length, z);
    layers.push(layer);
    layerByRoundedZ.set(roundedZ, layer);
    activeLayer = layer;
    return layer;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const cleanedLine = stripInlineComment(rawLine);
    const parsed = parseCommand(cleanedLine);

    if (!parsed) {
      continue;
    }

    const { command, params } = parsed;

    if (command === 'G90') {
      state.xyzMode = 'absolute';
      continue;
    }

    if (command === 'G91') {
      state.xyzMode = 'relative';
      continue;
    }

    if (command === 'M82') {
      state.extrusionMode = 'absolute';
      continue;
    }

    if (command === 'M83') {
      state.extrusionMode = 'relative';
      continue;
    }

    if (command === 'G92') {
      for (const axis of [...XYZ_KEYS, 'E'] as const) {
        if (params[axis] !== undefined) {
          if (axis === 'X') state.x = params[axis];
          if (axis === 'Y') state.y = params[axis];
          if (axis === 'Z') state.z = params[axis];
          if (axis === 'E') state.e = params[axis];
        }
      }
      continue;
    }

    if (!MOVE_COMMANDS.has(command)) {
      continue;
    }

    const previousX = state.x;
    const previousY = state.y;
    const previousZ = state.z;
    const nextX = resolveAxis(previousX, params.X, state.xyzMode);
    const nextY = resolveAxis(previousY, params.Y, state.xyzMode);
    const nextZ = resolveAxis(previousZ, params.Z, state.xyzMode);

    let extrusionDelta = 0;
    let nextE = state.e;

    if (params.E !== undefined) {
      if (state.extrusionMode === 'absolute') {
        nextE = params.E;
        extrusionDelta = nextE - state.e;
      } else {
        extrusionDelta = params.E;
        nextE = state.e + params.E;
      }
    }

    const nextFeedrate = params.F ?? state.feedrate;
    if (
      previousX !== null &&
      previousY !== null &&
      previousZ !== null &&
      nextX !== null &&
      nextY !== null &&
      nextZ !== null
    ) {
      const startX = previousX;
      const startY = previousY;
      const endX = nextX;
      const endY = nextY;
      const endZ = nextZ;

      const candidateSegment: ToolpathSegment = {
        id: `seg-${segmentCounter}`,
        layerIndex: -1,
        z: endZ,
        x1: startX,
        y1: startY,
        x2: endX,
        y2: endY,
        length: 0,
        extrusionDelta,
        feedrate: nextFeedrate,
        extrusionMode: state.extrusionMode,
        extrusionPositionStart: state.e,
        extrusionPositionEnd: nextE,
        isExtruding: false,
        isTravel: false,
        sourceLineNumber: index + 1
      };

      candidateSegment.length = segmentLength(candidateSegment);
      const hasXYMovement = candidateSegment.length > EPSILON;
      const isExtruding = hasXYMovement && extrusionDelta > EPSILON;
      const isTravel = hasXYMovement && !isExtruding;

      if (isExtruding) {
        const layer = ensureLayer(endZ);
        candidateSegment.layerIndex = layer.index;
        candidateSegment.isExtruding = true;
        layer.extrusionSegments.push(candidateSegment);
        extrusionSegments.push(candidateSegment);
        segmentCounter += 1;
      } else if (isTravel) {
        const layer =
          activeLayer ??
          (layers.length > 0 ? layers[layers.length - 1] : null);

        candidateSegment.layerIndex = layer?.index ?? 0;
        candidateSegment.isTravel = true;
        if (layer) {
          layer.travelSegments.push(candidateSegment);
        }
        travelSegments.push(candidateSegment);
        segmentCounter += 1;
      }
    }

    if (params.F !== undefined) {
      state.feedrate = params.F;
    }

    state.x = nextX;
    state.y = nextY;
    state.z = nextZ;
    state.e = nextE;
  }

  for (const layer of layers) {
    updateLayerBounds(layer);
  }

  if (layers.length === 0) {
    warnings.push(
      'No extrusion layers were found. The file may be empty, unsupported, or contain only travel moves.'
    );
  }

  const bounds = createBoundsFromSegments([...extrusionSegments, ...travelSegments]);

  return {
    fileName: options.fileName ?? 'uploaded.gcode',
    fileSize: options.fileSize ?? content.length,
    lineCount: lines.length,
    sourceLines: lines,
    layers,
    extrusionSegments,
    travelSegments,
    bounds: bounds as Bounds | null,
    warnings
  };
}

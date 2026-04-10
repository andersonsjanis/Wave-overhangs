export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type ViewerMode = '2d' | '3d';
export type PositioningMode = 'absolute' | 'relative';

export type Coordinate = [number, number];
export type PolygonRing = Coordinate[];
export type PolygonShape = PolygonRing[];
export type MultiPolygonShape = PolygonShape[];

export interface LinePart {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
}

export interface ToolpathSegment {
  id: string;
  layerIndex: number;
  z: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  extrusionDelta: number;
  feedrate: number | null;
  extrusionMode: PositioningMode;
  extrusionPositionStart: number;
  extrusionPositionEnd: number;
  isExtruding: boolean;
  isTravel: boolean;
  sourceLineNumber: number;
}

export interface LayerData {
  index: number;
  z: number;
  extrusionSegments: ToolpathSegment[];
  travelSegments: ToolpathSegment[];
  bounds: Bounds | null;
}

export interface ParsedGcode {
  fileName: string;
  fileSize: number;
  lineCount: number;
  sourceLines: string[];
  layers: LayerData[];
  extrusionSegments: ToolpathSegment[];
  travelSegments: ToolpathSegment[];
  bounds: Bounds | null;
  warnings: string[];
}

export interface OverhangSettings {
  extrusionWidth: number;
  samplingStep: number;
  supportDistanceThreshold: number;
  supportRatioThreshold: number;
  overhangAreaThreshold: number;
  footprintGridSize: number;
  maxFootprintGridCells: number;
}

export interface AnalyzedSegment extends ToolpathSegment {
  supportRatio: number;
  overhangRatio: number;
  isCandidateOverhang: boolean;
  normalParts: LinePart[];
  overhangParts: LinePart[];
}

export interface WaveOverhangGuide {
  seedSegments: LinePart[];
  boundarySegments: LinePart[];
}

export type WaveFidelity = 'low' | 'medium' | 'high';
export type WavePropagationModel = 'raster' | 'huygens';

export interface WavePathSettings {
  wavelength: number;
  discretizationDistance: number;
  iterationLimit: number;
  minAddedCells: number;
  fidelity: WaveFidelity;
  rasterSubdivisions?: number;
  waveBufferQuadrantSegments?: number;
  wavePropagationModel?: WavePropagationModel;
}

export interface GcodeExportSettings {
  beadArea: number;
  filamentDiameter: number;
  retractionDistance: number;
}

export interface WavefrontPath {
  iteration: number;
  segments: LinePart[];
  cellCount: number;
}

export interface WavePathPlan {
  layerIndex: number;
  seedSegments: LinePart[];
  boundarySegments: LinePart[];
  wavefronts: WavefrontPath[];
  generationMode: 'vector' | 'raster-fallback';
  settings: WavePathSettings;
}

export interface AnalyzedLayerData
  extends Omit<LayerData, 'extrusionSegments'> {
  extrusionSegments: AnalyzedSegment[];
  overhangSegmentCount: number;
  footprint: MultiPolygonShape;
  overhangRegion: MultiPolygonShape;
  overhangArea: number;
  waveGuide: WaveOverhangGuide;
}

export interface AnalyzedGcode
  extends Omit<ParsedGcode, 'layers' | 'extrusionSegments'> {
  layers: AnalyzedLayerData[];
  extrusionSegments: AnalyzedSegment[];
  settings: OverhangSettings;
}

export interface ParseOptions {
  fileName?: string;
  fileSize?: number;
}

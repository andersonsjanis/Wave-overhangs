import type {
  GcodeExportSettings,
  OverhangSettings,
  WavePathSettings
} from '../types/gcode';

export const DEFAULT_OVERHANG_SETTINGS: OverhangSettings = {
  extrusionWidth: 0.45,
  samplingStep: 0.8,
  supportDistanceThreshold: 0.35,
  supportRatioThreshold: 0.65,
  overhangAreaThreshold: 1e-9,
  footprintGridSize: 0.4,
  maxFootprintGridCells: 800_000
};

export const DEFAULT_WAVE_PATH_SETTINGS: WavePathSettings = {
  wavelength: 0.35,
  discretizationDistance: 0.35,
  iterationLimit: 80,
  minAddedCells: 1,
  fidelity: 'medium',
  rasterSubdivisions: 1,
  waveBufferQuadrantSegments: 16,
  wavePropagationModel: 'raster'
};

export const DEFAULT_GCODE_EXPORT_SETTINGS: GcodeExportSettings = {
  beadArea: 0.15,
  filamentDiameter: 1.75,
  retractionDistance: 1
};

export const VIEWER_CANVAS_PADDING = 32;

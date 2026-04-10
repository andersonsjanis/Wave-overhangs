import { describe, expect, it } from 'vitest';
import { buildPostProcessedGcode } from '../src/lib/gcodeExport';
import type {
  AnalyzedGcode,
  AnalyzedLayerData,
  AnalyzedSegment,
  GcodeExportSettings,
  LinePart,
  WavePathPlan
} from '../src/types/gcode';

const EXPORT_SETTINGS: GcodeExportSettings = {
  beadArea: 0.15,
  filamentDiameter: 1.75,
  retractionDistance: 1
};

function createLinePart(x1: number, y1: number, x2: number, y2: number): LinePart {
  return {
    x1,
    y1,
    x2,
    y2,
    length: Math.hypot(x2 - x1, y2 - y1)
  };
}

function createSegment(overrides: Partial<AnalyzedSegment>): AnalyzedSegment {
  return {
    id: 'seg-1',
    layerIndex: 0,
    z: 0.2,
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 0,
    length: 10,
    extrusionDelta: 1,
    feedrate: 1200,
    extrusionMode: 'absolute',
    extrusionPositionStart: 0,
    extrusionPositionEnd: 1,
    isExtruding: true,
    isTravel: false,
    sourceLineNumber: 4,
    supportRatio: 0.4,
    overhangRatio: 0.6,
    isCandidateOverhang: true,
    normalParts: [createLinePart(0, 0, 4, 0)],
    overhangParts: [createLinePart(4, 0, 10, 0)],
    ...overrides
  };
}

describe('buildPostProcessedGcode', () => {
  it('replaces candidate overhang lines with supported remnants and ordered wavefront paths', () => {
    const modifiedSegment = createSegment({});
    const untouchedSegment = createSegment({
      id: 'seg-2',
      x1: 10,
      y1: 0,
      x2: 20,
      y2: 0,
      length: 10,
      extrusionDelta: 1,
      extrusionPositionStart: 1,
      extrusionPositionEnd: 2,
      sourceLineNumber: 5,
      supportRatio: 1,
      overhangRatio: 0,
      isCandidateOverhang: false,
      normalParts: [createLinePart(10, 0, 20, 0)],
      overhangParts: []
    });
    const layer: AnalyzedLayerData = {
      index: 0,
      z: 0.2,
      extrusionSegments: [modifiedSegment, untouchedSegment],
      travelSegments: [],
      bounds: { minX: 0, minY: 0, maxX: 20, maxY: 2 },
      overhangSegmentCount: 1,
      footprint: [],
      overhangRegion: [],
      overhangArea: 6,
      waveGuide: {
        seedSegments: [],
        boundarySegments: []
      }
    };
    const data: AnalyzedGcode = {
      fileName: 'example.gcode',
      fileSize: 100,
      lineCount: 5,
      sourceLines: [
        'G90',
        'G1 Z0.2',
        'G1 X0 Y0 F9000',
        'G1 X10 Y0 E1',
        'G1 X20 Y0 E2'
      ],
      layers: [layer],
      extrusionSegments: [modifiedSegment, untouchedSegment],
      travelSegments: [],
      bounds: { minX: 0, minY: 0, maxX: 20, maxY: 2 },
      warnings: [],
      settings: {
        extrusionWidth: 0.45,
        samplingStep: 1,
        supportDistanceThreshold: 0.35,
        supportRatioThreshold: 0.65,
        overhangAreaThreshold: 0,
        footprintGridSize: 0.4,
        maxFootprintGridCells: 800_000
      }
    };
    const wavePathPlan: WavePathPlan = {
      layerIndex: 0,
      seedSegments: [createLinePart(4, 0, 4, 1)],
      boundarySegments: [],
      wavefronts: [
        {
          iteration: 1,
          segments: [createLinePart(4, 1, 8, 1)],
          cellCount: 1
        },
        {
          iteration: 2,
          segments: [createLinePart(5, 2, 9, 2)],
          cellCount: 1
        }
      ],
      generationMode: 'vector',
      settings: {
        wavelength: 0.7,
        discretizationDistance: 0.35,
        iterationLimit: 80,
        minAddedCells: 1,
        fidelity: 'medium'
      }
    };

    const output = buildPostProcessedGcode(data, { 0: wavePathPlan }, EXPORT_SETTINGS);

    expect(output.fileName).toBe('example-post-processed.gcode');
    expect(output.content).not.toContain('G1 X10 Y0 E1');
    expect(output.content).toContain('M83');
    expect(output.content).toContain('G1 F1200 X4 Y0 E0.24945');
    expect(output.content).toContain(';WAVE_OVERHANG_REPLACEMENT_START layer 0');
    expect(output.content).not.toContain('G0 F2400 X10 Y0\n;WAVE_OVERHANG_REPLACEMENT_START layer 0');
    expect(output.content).toContain('G1 F120 X4 Y1 E0.06236');
    expect(output.content).toContain('G1 F120 X8 Y1 E0.24945');
    expect(output.content).toContain('G1 E-1\nG0 F2400 X9 Y2\nG1 E1');
    expect(output.content).toContain('G1 F120 X5 Y2 E0.24945');
    expect(output.content).toContain('G0 F2400 X10 Y0');
    expect(output.content).toContain('G1 F1200 X20 Y0 E0.62363');
    expect(output.content).toContain('M82\nG92 E2');
    expect(output.content).not.toContain('G1 X20 Y0 E2');

    const firstWaveIndex = output.content.indexOf('G1 F120 X8 Y1 E0.24945');
    const secondWaveIndex = output.content.indexOf('G1 F120 X5 Y2 E0.24945');
    const seedIndex = output.content.indexOf('G1 F120 X4 Y1 E0.06236');
    expect(seedIndex).toBeGreaterThan(-1);
    expect(firstWaveIndex).toBeGreaterThan(seedIndex);
    expect(firstWaveIndex).toBeGreaterThan(-1);
    expect(secondWaveIndex).toBeGreaterThan(firstWaveIndex);
  });

  it('keeps relative-extrusion files in relative mode while adding travel retractions', () => {
    const modifiedSegment = createSegment({
      extrusionMode: 'relative',
      extrusionPositionStart: 0,
      extrusionPositionEnd: 1
    });
    const layer: AnalyzedLayerData = {
      index: 0,
      z: 0.2,
      extrusionSegments: [modifiedSegment],
      travelSegments: [],
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 2 },
      overhangSegmentCount: 1,
      footprint: [],
      overhangRegion: [],
      overhangArea: 6,
      waveGuide: {
        seedSegments: [],
        boundarySegments: []
      }
    };
    const data: AnalyzedGcode = {
      fileName: 'relative.gcode',
      fileSize: 100,
      lineCount: 4,
      sourceLines: ['G90', 'M83', 'G1 X0 Y0 F9000', 'G1 X10 Y0 E1'],
      layers: [layer],
      extrusionSegments: [modifiedSegment],
      travelSegments: [],
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 2 },
      warnings: [],
      settings: {
        extrusionWidth: 0.45,
        samplingStep: 1,
        supportDistanceThreshold: 0.35,
        supportRatioThreshold: 0.65,
        overhangAreaThreshold: 0,
        footprintGridSize: 0.4,
        maxFootprintGridCells: 800_000
      }
    };
    const wavePathPlan: WavePathPlan = {
      layerIndex: 0,
      seedSegments: [],
      boundarySegments: [],
      wavefronts: [
        {
          iteration: 1,
          segments: [createLinePart(4, 1, 8, 1)],
          cellCount: 1
        }
      ],
      generationMode: 'vector',
      settings: {
        wavelength: 0.7,
        discretizationDistance: 0.35,
        iterationLimit: 80,
        minAddedCells: 1,
        fidelity: 'medium'
      }
    };

    const output = buildPostProcessedGcode(data, { 0: wavePathPlan }, EXPORT_SETTINGS);

    expect(output.content).not.toContain('M82');
    expect(output.content).not.toContain('G92 E');
  });

  it('throws when no generated wave-path plans are available', () => {
    const layer: AnalyzedLayerData = {
      index: 0,
      z: 0.2,
      extrusionSegments: [],
      travelSegments: [],
      bounds: null,
      overhangSegmentCount: 0,
      footprint: [],
      overhangRegion: [],
      overhangArea: 0,
      waveGuide: {
        seedSegments: [],
        boundarySegments: []
      }
    };
    const data: AnalyzedGcode = {
      fileName: 'example.gcode',
      fileSize: 10,
      lineCount: 1,
      sourceLines: ['G90'],
      layers: [layer],
      extrusionSegments: [],
      travelSegments: [],
      bounds: null,
      warnings: [],
      settings: {
        extrusionWidth: 0.45,
        samplingStep: 1,
        supportDistanceThreshold: 0.35,
        supportRatioThreshold: 0.65,
        overhangAreaThreshold: 0,
        footprintGridSize: 0.4,
        maxFootprintGridCells: 800_000
      }
    };

    expect(() => buildPostProcessedGcode(data, {}, EXPORT_SETTINGS)).toThrow(
      'Generate at least one wave path plan before exporting output G-code.'
    );
  });
});

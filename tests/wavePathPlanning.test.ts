import { describe, expect, it } from 'vitest';
import { distancePointToSegment } from '../src/lib/geometry';
import { parseGcode } from '../src/lib/gcodeParser';
import { analyzeOverhangs } from '../src/lib/overhangDetection';
import { generateWavePathPlan } from '../src/lib/wavePathPlanning';
import type { AnalyzedLayerData, Coordinate, LinePart, MultiPolygonShape } from '../src/types/gcode';

function line(x1: number, y1: number, x2: number, y2: number): LinePart {
  return { x1, y1, x2, y2, length: Math.hypot(x2 - x1, y2 - y1) };
}

function minimumMidpointDistance(segment: LinePart, emitters: LinePart[]) {
  const midpoint = {
    x: (segment.x1 + segment.x2) / 2,
    y: (segment.y1 + segment.y2) / 2
  };

  return emitters.reduce(
    (minimum, emitter) => Math.min(minimum, distancePointToSegment(midpoint, emitter)),
    Number.POSITIVE_INFINITY
  );
}

function minimumSegmentLength(segments: LinePart[]) {
  return segments.reduce(
    (minimum, segment) => Math.min(minimum, segment.length),
    Number.POSITIVE_INFINITY
  );
}

function uniqueRoundedValues(values: number[]) {
  return new Set(values.map((value) => value.toFixed(6))).size;
}

function rectangularCellRegion(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  cellSize: number
): MultiPolygonShape {
  const region: MultiPolygonShape = [];

  for (let y = minY; y < maxY; y += cellSize) {
    for (let x = minX; x < maxX; x += cellSize) {
      const x1 = x;
      const y1 = y;
      const x2 = x + cellSize;
      const y2 = y + cellSize;
      const ring: Coordinate[] = [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
        [x1, y1]
      ];

      region.push([[
        ...ring
      ]]);
    }
  }

  return region;
}

describe('generateWavePathPlan', () => {
  it('generates wavefronts from an identified seed into an overhang region', () => {
    const gcode = `
      G90
      M82
      G92 E0
      G1 Z0.2
      G1 X0 Y0
      G1 X10 Y0 E1
      G1 X10 Y10 E2
      G1 X0 Y10 E3
      G1 X0 Y0 E4
      G1 Z0.4
      G1 X0 Y0
      G1 X10 Y0 E5
      G1 X10 Y10 E6
      G1 X0 Y10 E7
      G1 X0 Y0 E8
      G1 Z0.6
      G1 X5 Y0
      G1 X15 Y0 E9
      G1 X15 Y10 E10
      G1 X5 Y10 E11
      G1 X5 Y0 E12
    `;

    const parsed = parseGcode(gcode);
    const analyzed = analyzeOverhangs(parsed, {
      extrusionWidth: 0.45,
      samplingStep: 1,
      supportDistanceThreshold: 0.25,
      supportRatioThreshold: 0.75,
      overhangAreaThreshold: 1e-9,
      footprintGridSize: 0.5,
      maxFootprintGridCells: 800_000
    });
    const plan = generateWavePathPlan(analyzed.layers[2], {
      wavelength: 1,
      discretizationDistance: 0.5,
      iterationLimit: 20,
      minAddedCells: 1,
      fidelity: 'low'
    });

    expect(plan.seedSegments.length).toBeGreaterThan(0);
    expect(plan.boundarySegments.length).toBeGreaterThan(0);
    expect(plan.generationMode).toBe('raster-fallback');
    expect(plan.wavefronts.length).toBeGreaterThan(0);
    expect(plan.wavefronts[0].segments.length).toBeGreaterThan(0);
  });

  it('grows successive raster wavefront bands across the overhang region', () => {
    const seedSegments = [line(0, 0, 0, 6)];
    const layer = {
      index: 0,
      z: 0.2,
      extrusionSegments: [],
      travelSegments: [],
      bounds: null,
      overhangSegmentCount: 0,
      footprint: [],
      overhangArea: 36,
      overhangRegion: rectangularCellRegion(0, 0, 6, 6, 1),
      waveGuide: {
        seedSegments,
        boundarySegments: [
          line(0, 0, 6, 0),
          line(6, 0, 6, 6),
          line(6, 6, 0, 6),
          line(0, 6, 0, 0)
        ]
      }
    } as AnalyzedLayerData;

    const plan = generateWavePathPlan(layer, {
      wavelength: 1,
      discretizationDistance: 0.25,
      iterationLimit: 8,
      minAddedCells: 1,
      fidelity: 'low'
    });

    expect(plan.wavefronts.length).toBeGreaterThan(0);
    expect(plan.wavefronts.every((wavefront) => wavefront.cellCount > 0)).toBe(true);
    expect(plan.wavefronts.every((wavefront) => wavefront.segments.length > 0)).toBe(true);
    expect(
      plan.wavefronts.every((wavefront) =>
        wavefront.segments.every(
          (segment) => Math.abs(segment.x1 - segment.x2) < 1e-6 || Math.abs(segment.y1 - segment.y2) < 1e-6
        )
      )
    ).toBe(true);
  });

  it('uses the raster planner when raster is selected', () => {
    const seedSegments = [line(0, 0, 0, 6)];
    const layer = {
      index: 0,
      z: 0.2,
      extrusionSegments: [],
      travelSegments: [],
      bounds: null,
      overhangSegmentCount: 0,
      footprint: [],
      overhangArea: 36,
      overhangRegion: rectangularCellRegion(0, 0, 6, 6, 1),
      waveGuide: {
        seedSegments,
        boundarySegments: [
          line(0, 0, 6, 0),
          line(6, 0, 6, 6),
          line(6, 6, 0, 6),
          line(0, 6, 0, 0)
        ]
      }
    } as AnalyzedLayerData;

    const plan = generateWavePathPlan(layer, {
      wavelength: 1,
      discretizationDistance: 0.5,
      iterationLimit: 8,
      minAddedCells: 1,
      fidelity: 'low',
      wavePropagationModel: 'raster'
    });

    expect(plan.generationMode).toBe('raster-fallback');
    expect(plan.wavefronts.length).toBeGreaterThan(0);
    expect(plan.wavefronts[0].segments.length).toBeGreaterThan(0);
  });

  it('supports a finer raster grid for smoother curved raster wavefronts', () => {
    const seedSegments = [line(0, 2.5, 0, 3.5)];
    const layer = {
      index: 0,
      z: 0.2,
      extrusionSegments: [],
      travelSegments: [],
      bounds: null,
      overhangSegmentCount: 0,
      footprint: [],
      overhangArea: 36,
      overhangRegion: rectangularCellRegion(0, 0, 6, 6, 1),
      waveGuide: {
        seedSegments,
        boundarySegments: [
          line(0, 0, 6, 0),
          line(6, 0, 6, 6),
          line(6, 6, 0, 6),
          line(0, 6, 0, 0)
        ]
      }
    } as AnalyzedLayerData;

    const coarsePlan = generateWavePathPlan(layer, {
      wavelength: 1.25,
      discretizationDistance: 0.2,
      iterationLimit: 1,
      minAddedCells: 1,
      fidelity: 'low',
      wavePropagationModel: 'raster',
      rasterSubdivisions: 1
    });
    const finePlan = generateWavePathPlan(layer, {
      wavelength: 1.25,
      discretizationDistance: 0.2,
      iterationLimit: 1,
      minAddedCells: 1,
      fidelity: 'low',
      wavePropagationModel: 'raster',
      rasterSubdivisions: 4
    });

    expect(coarsePlan.generationMode).toBe('raster-fallback');
    expect(finePlan.generationMode).toBe('raster-fallback');
    expect(coarsePlan.wavefronts.length).toBeGreaterThan(0);
    expect(finePlan.wavefronts.length).toBeGreaterThan(0);

    const coarseSegments = coarsePlan.wavefronts[0].segments;
    const fineSegments = finePlan.wavefronts[0].segments;
    const coarseYLevels = uniqueRoundedValues(
      coarseSegments.flatMap((segment) => [segment.y1, segment.y2])
    );
    const fineYLevels = uniqueRoundedValues(
      fineSegments.flatMap((segment) => [segment.y1, segment.y2])
    );

    expect(fineSegments.length).toBeGreaterThan(coarseSegments.length);
    expect(minimumSegmentLength(fineSegments)).toBeLessThan(minimumSegmentLength(coarseSegments));
    expect(fineYLevels).toBeGreaterThan(coarseYLevels);
  });

  it('uses the huygens planner when the propagation model is selected', () => {
    const seedSegments = [line(0, 0, 0, 6)];
    const layer = {
      index: 0,
      z: 0.2,
      extrusionSegments: [],
      travelSegments: [],
      bounds: null,
      overhangSegmentCount: 0,
      footprint: [],
      overhangArea: 36,
      overhangRegion: [[
        [
          [0, 0],
          [6, 0],
          [6, 6],
          [0, 6],
          [0, 0]
        ]
      ]],
      waveGuide: {
        seedSegments,
        boundarySegments: [
          line(0, 0, 6, 0),
          line(6, 0, 6, 6),
          line(6, 6, 0, 6),
          line(0, 6, 0, 0)
        ]
      }
    } as AnalyzedLayerData;

    const plan = generateWavePathPlan(layer, {
      wavelength: 1,
      discretizationDistance: 0.25,
      iterationLimit: 8,
      minAddedCells: 1,
      fidelity: 'low',
      wavePropagationModel: 'huygens'
    });

    expect(plan.generationMode).toBe('vector');
    expect(plan.wavefronts.length).toBeGreaterThan(0);
    expect(plan.wavefronts[0].segments.length).toBeGreaterThan(0);
    const farthestX = Math.max(
      ...plan.wavefronts.flatMap((wavefront) =>
        wavefront.segments.flatMap((segment) => [segment.x1, segment.x2])
      )
    );
    expect(farthestX).toBeGreaterThan(5.6);
    expect(
      plan.wavefronts.every((wavefront) =>
        wavefront.segments.every(
          (segment) => minimumMidpointDistance(segment, seedSegments) > 0.2
        )
      )
    ).toBe(true);
  });
});

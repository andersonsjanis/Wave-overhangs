import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/lib/gcodeParser';
import { analyzeOverhangs } from '../src/lib/overhangDetection';

describe('analyzeOverhangs', () => {
  it('flags segments with poor support from the previous layer', () => {
    const gcode = `
      G90
      M82
      G92 E0
      G1 Z0.2
      G1 X0 Y0
      G1 X10 Y0 E1
      G1 Z0.4
      G1 X0 Y0
      G1 X10 Y0 E2
      G1 Z0.6
      G1 X8 Y0
      G1 X18 Y0 E3
    `;

    const parsed = parseGcode(gcode);
    const analyzed = analyzeOverhangs(parsed, {
      extrusionWidth: 0.45,
      samplingStep: 1,
      supportDistanceThreshold: 0.25,
      supportRatioThreshold: 0.75,
      overhangAreaThreshold: 1e-9,
      footprintGridSize: 0.25,
      maxFootprintGridCells: 800_000
    });

    expect(analyzed.layers).toHaveLength(3);
    expect(analyzed.layers[0].overhangSegmentCount).toBe(0);
    expect(analyzed.layers[1].overhangSegmentCount).toBe(0);
    expect(analyzed.layers[2].overhangSegmentCount).toBe(1);
    expect(analyzed.layers[2].overhangArea).toBeGreaterThan(0);
    expect(analyzed.layers[2].waveGuide.seedSegments.length).toBeGreaterThan(0);
    expect(analyzed.layers[2].waveGuide.boundarySegments.length).toBeGreaterThan(0);
    expect(analyzed.layers[2].extrusionSegments[0].supportRatio).toBeLessThan(0.75);
  });
});

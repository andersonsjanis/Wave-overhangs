import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/lib/gcodeParser';

describe('parseGcode', () => {
  it('groups extrusion moves into layers with absolute extrusion mode', () => {
    const gcode = `
      G90
      M82
      G92 E0
      G1 Z0.2 F1200
      G1 X0 Y0 F9000
      G1 X10 Y0 E1
      G1 X10 Y10 E2
      G1 Z0.4
      G1 X0 Y10 F9000
      G1 X10 Y10 E3
    `;

    const parsed = parseGcode(gcode, { fileName: 'test.gcode', fileSize: gcode.length });

    expect(parsed.layers).toHaveLength(2);
    expect(parsed.layers[0].extrusionSegments).toHaveLength(2);
    expect(parsed.layers[1].extrusionSegments).toHaveLength(1);
    expect(parsed.extrusionSegments[0].extrusionDelta).toBeCloseTo(1);
    expect(parsed.travelSegments.length).toBeGreaterThan(0);
  });

  it('supports relative extrusion mode', () => {
    const gcode = `
      G90
      M83
      G1 Z0.2
      G1 X0 Y0
      G1 X5 Y0 E0.4
      G1 X10 Y0 E0.4
    `;

    const parsed = parseGcode(gcode);

    expect(parsed.layers).toHaveLength(1);
    expect(parsed.layers[0].extrusionSegments).toHaveLength(2);
    expect(parsed.layers[0].extrusionSegments[1].extrusionDelta).toBeCloseTo(0.4);
  });

  it('parses compact slicer words without whitespace between parameters', () => {
    const gcode = `
      G90
      M82
      G92 E0
      G1Z0.2F1200
      G1X0Y0F9000
      G1X10.0Y0.0E1.0
      G1X10.0Y10.0E2.0
    `;

    const parsed = parseGcode(gcode);

    expect(parsed.layers).toHaveLength(1);
    expect(parsed.layers[0].extrusionSegments).toHaveLength(2);
    expect(parsed.layers[0].extrusionSegments[1].x2).toBeCloseTo(10);
    expect(parsed.layers[0].extrusionSegments[1].y2).toBeCloseTo(10);
  });
});

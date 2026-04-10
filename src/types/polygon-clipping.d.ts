import type { MultiPolygonShape, PolygonShape } from './gcode';

declare module 'polygon-clipping' {
  type Geometry = PolygonShape | MultiPolygonShape;

  interface PolygonClipping {
    union(...geometries: Geometry[]): MultiPolygonShape;
    intersection(...geometries: Geometry[]): MultiPolygonShape;
    difference(subjectGeometry: Geometry, ...clipGeometries: Geometry[]): MultiPolygonShape;
    xor(...geometries: Geometry[]): MultiPolygonShape;
  }

  const polygonClipping: PolygonClipping;
  export default polygonClipping;
}

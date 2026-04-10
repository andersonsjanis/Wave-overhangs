import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react';
import { VIEWER_CANVAS_PADDING } from '../lib/config';
import { mergeBounds } from '../lib/geometry';
import { getPreviewZScale } from '../lib/viewerScaling';
import type {
  AnalyzedGcode,
  AnalyzedLayerData,
  Coordinate,
  MultiPolygonShape,
  WavePathPlan
} from '../types/gcode';

interface Stack3DCanvasProps {
  data: AnalyzedGcode | null;
  currentLayer: AnalyzedLayerData | null;
  selectedLayerIndex: number;
  onLayerSelect: (layerIndex: number) => void;
  layerAlpha: number;
  resolvedLayerIndexes: ReadonlySet<number>;
  showPreviousLayer: boolean;
  showTravelMoves: boolean;
  showWaveGuide: boolean;
  wavePathPlan: WavePathPlan | null;
  persistentWavePathPlans: Record<number, WavePathPlan>;
  resetToken: number;
}

interface CanvasSize {
  width: number;
  height: number;
}

interface OrbitViewState {
  zoom: number;
  panX: number;
  panY: number;
  rotationX: number;
  rotationZ: number;
}

interface ModelPoint3D {
  x: number;
  y: number;
  z: number;
}

interface ProjectedPoint3D {
  x: number;
  y: number;
  depth: number;
}

interface RenderSegment3D {
  start: ModelPoint3D;
  end: ModelPoint3D;
  color: string;
  width: number;
  alpha: number;
  dashed?: boolean;
}

interface RenderPolygon3D {
  rings: ModelPoint3D[][];
  fill: string;
  stroke: string;
  fillAlpha: number;
  strokeAlpha: number;
  strokeWidth: number;
}

interface OverhangCallout3D {
  layerIndex: number;
  anchor: ModelPoint3D;
}

const INITIAL_ORBIT_VIEW: OrbitViewState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  rotationX: 0.68,
  rotationZ: -Math.PI / 4
};

const WAVEFRONT_RENDER_STYLES = {
  latest: { color: '#d72670', width: 2.2, alpha: 0.98 },
  history: { color: '#0b8ed9', width: 1.9, alpha: 0.9 }
} as const;

const PERSISTENT_WAVE_RENDER_STYLE = {
  color: '#0b8ed9',
  width: 1.9,
  alpha: 0.94
} as const;

function wavefrontRenderStyle(index: number, total: number) {
  if (index === total - 1) {
    return WAVEFRONT_RENDER_STYLES.latest;
  }

  return WAVEFRONT_RENDER_STYLES.history;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function projectPoint(
  point: ModelPoint3D,
  rotationX: number,
  rotationZ: number
): ProjectedPoint3D {
  const cosZ = Math.cos(rotationZ);
  const sinZ = Math.sin(rotationZ);
  const xAfterZ = point.x * cosZ - point.y * sinZ;
  const yAfterZ = point.x * sinZ + point.y * cosZ;

  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const yAfterX = yAfterZ * cosX - point.z * sinX;
  const zAfterX = yAfterZ * sinX + point.z * cosX;

  return {
    x: xAfterZ,
    y: yAfterX,
    depth: zAfterX
  };
}

function averageCoordinate(points: Coordinate[]) {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }

  return {
    x: sumX / points.length,
    y: sumY / points.length
  };
}

function findCalloutCoordinate(geometry: MultiPolygonShape) {
  let bestRing: Coordinate[] | null = null;

  for (const polygon of geometry) {
    const outerRing = polygon[0];
    if (!outerRing || outerRing.length < 3) {
      continue;
    }

    if (!bestRing || outerRing.length > bestRing.length) {
      bestRing = outerRing;
    }
  }

  return averageCoordinate(bestRing ?? []);
}

function sampleSegments<T>(segments: T[], maxSegments = 220) {
  if (segments.length <= maxSegments) {
    return segments;
  }

  const sampled: T[] = [];
  const stride = segments.length / maxSegments;

  for (let index = 0; index < maxSegments; index += 1) {
    sampled.push(segments[Math.min(segments.length - 1, Math.floor(index * stride))]);
  }

  return sampled;
}

export function Stack3DCanvas({
  data,
  currentLayer,
  selectedLayerIndex,
  onLayerSelect,
  layerAlpha,
  resolvedLayerIndexes,
  showPreviousLayer,
  showTravelMoves,
  showWaveGuide,
  wavePathPlan,
  persistentWavePathPlans,
  resetToken
}: Stack3DCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef({ startX: 0, startY: 0, active: false, isPanning: false });
  const pointerInsideCanvasRef = useRef(false);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 800, height: 600 });
  const [view, setView] = useState<OrbitViewState>(INITIAL_ORBIT_VIEW);

  useEffect(() => {
    setView(INITIAL_ORBIT_VIEW);
  }, [data, resetToken]);

  useLayoutEffect(() => {
    const element = containerRef.current;

    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setCanvasSize({
        width: Math.max(320, Math.round(entry.contentRect.width)),
        height: Math.max(320, Math.round(entry.contentRect.height))
      });
    });

    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  const modelInfo = useMemo(() => {
    if (!data || data.layers.length === 0) {
      return null;
    }

    const bounds = data.bounds ?? mergeBounds(data.layers.map((layer) => layer.bounds));
    if (!bounds) {
      return null;
    }

    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const layer of data.layers) {
      minZ = Math.min(minZ, layer.z);
      maxZ = Math.max(maxZ, layer.z);
    }

    const xySpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const zSpan = Math.max(maxZ - minZ, 0.01);

    return {
      bounds,
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerY: (bounds.minY + bounds.maxY) / 2,
      centerZ: (minZ + maxZ) / 2,
      minZ,
      maxZ,
      zScale: getPreviewZScale(xySpan, zSpan)
    };
  }, [data]);

  const modelRadius = useMemo(() => {
    if (!modelInfo) {
      return 1;
    }

    const xValues = [modelInfo.bounds.minX, modelInfo.bounds.maxX];
    const yValues = [modelInfo.bounds.minY, modelInfo.bounds.maxY];
    const zValues = [modelInfo.minZ, modelInfo.maxZ];
    let radius = 1;

    for (const x of xValues) {
      for (const y of yValues) {
        for (const z of zValues) {
          const dx = x - modelInfo.centerX;
          const dy = y - modelInfo.centerY;
          const dz = (z - modelInfo.centerZ) * modelInfo.zScale;
          radius = Math.max(radius, Math.hypot(dx, dy, dz));
        }
      }
    }

    return radius;
  }, [modelInfo]);

  const scene = useMemo(() => {
    if (!data || !modelInfo) {
      return {
        points: [] as ModelPoint3D[],
        segments: [] as RenderSegment3D[],
        polygons: [] as RenderPolygon3D[],
        callouts: [] as OverhangCallout3D[]
      };
    }

    const points: ModelPoint3D[] = [];
    const segments: RenderSegment3D[] = [];
    const polygons: RenderPolygon3D[] = [];
    const callouts: OverhangCallout3D[] = [];
    const toModelPoint = (x: number, y: number, z: number): ModelPoint3D => ({
      x: x - modelInfo.centerX,
      y: y - modelInfo.centerY,
      z: (modelInfo.centerZ - z) * modelInfo.zScale
    });

    const addSegments = (
      parts: Array<{ x1: number; y1: number; x2: number; y2: number }>,
      z: number,
      options: { color: string; width: number; alpha: number; dashed?: boolean }
    ) => {
      for (const part of parts) {
        const start = toModelPoint(part.x1, part.y1, z);
        const end = toModelPoint(part.x2, part.y2, z);
        points.push(start, end);
        segments.push({ start, end, ...options });
      }
    };

    const addPolygonHighlight = (layer: AnalyzedLayerData) => {
      if (
        resolvedLayerIndexes.has(layer.index) ||
        layer.overhangArea <= 0 ||
        layer.overhangRegion.length === 0
      ) {
        return;
      }

      const isSelected = layer.index === selectedLayerIndex;
      const calloutCoordinate = findCalloutCoordinate(layer.overhangRegion);
      const rings = layer.overhangRegion.flatMap((polygon) =>
        polygon
          .filter((ring) => ring.length >= 3)
          .map((ring) => ring.map(([x, y]) => toModelPoint(x, y, layer.z)))
      );

      if (rings.length === 0) {
        return;
      }

      for (const ring of rings) {
        points.push(...ring);
      }

      polygons.push({
        rings,
        fill: isSelected ? '#f87171' : '#fca5a5',
        stroke: isSelected ? '#b91c1c' : '#dc2626',
        fillAlpha: isSelected ? 0.34 : 0.26,
        strokeAlpha: isSelected ? 0.98 : 0.9,
        strokeWidth: isSelected ? 2.4 : 1.8
      });

      callouts.push({
        layerIndex: layer.index,
        anchor: toModelPoint(calloutCoordinate.x, calloutCoordinate.y, layer.z)
      });
    };

    for (const layer of data.layers) {
      const isSelected = layer.index === selectedLayerIndex;
      const isPrevious = layer.index === selectedLayerIndex - 1;
      const isResolved = resolvedLayerIndexes.has(layer.index);
      const persistentWavePathPlan = persistentWavePathPlans[layer.index] ?? null;
      const hasPersistentWavePath = Boolean(
        persistentWavePathPlan?.wavefronts.length
      );
      const hasActiveWavePathPlan =
        isSelected && Boolean(wavePathPlan?.wavefronts.length);
      const hideOriginalOverhangPaths =
        isSelected &&
        (showWaveGuide || hasActiveWavePathPlan || hasPersistentWavePath);

      addPolygonHighlight(layer);

      if (isSelected) {
        addSegments(
          hideOriginalOverhangPaths || !isResolved
            ? layer.extrusionSegments.flatMap((segment) => segment.normalParts)
            : layer.extrusionSegments,
          layer.z,
          { color: '#176b87', width: 2.4, alpha: 1 }
        );

        if (!hideOriginalOverhangPaths && !isResolved) {
          addSegments(
            layer.extrusionSegments.flatMap((segment) => segment.overhangParts),
            layer.z,
            { color: '#dc2626', width: 3, alpha: 0.96 }
          );
        }

        if (showTravelMoves) {
          addSegments(layer.travelSegments, layer.z, {
            color: '#8fa3ad',
            width: 1.1,
            alpha: 0.72,
            dashed: true
          });
        }
      } else {
        addSegments(
          sampleSegments(
            hasPersistentWavePath
              ? layer.extrusionSegments.flatMap((segment) => segment.normalParts)
              : layer.extrusionSegments
          ),
          layer.z,
          {
          color: isPrevious && showPreviousLayer ? '#7ea0b3' : '#7f919b',
          width: isPrevious && showPreviousLayer ? 1.45 : 1.05,
          alpha: isPrevious && showPreviousLayer ? Math.min(1, layerAlpha + 0.33) : layerAlpha
          }
        );
      }

      if (hasPersistentWavePath && (!isSelected || !hasActiveWavePathPlan)) {
        persistentWavePathPlan.wavefronts.forEach((wavefront) => {
          addSegments(wavefront.segments, layer.z, PERSISTENT_WAVE_RENDER_STYLE);
        });
      }
    }

    if (currentLayer && showWaveGuide) {
      addSegments(currentLayer.waveGuide.boundarySegments, currentLayer.z, {
        color: '#f2a541',
        width: 4.4,
        alpha: 0.96
      });
      addSegments(currentLayer.waveGuide.seedSegments, currentLayer.z, {
        color: '#2ca58d',
        width: 4.8,
        alpha: 0.96
      });
    }

    if (currentLayer && wavePathPlan) {
      wavePathPlan.wavefronts.forEach((wavefront, index) => {
        const style = wavefrontRenderStyle(index, wavePathPlan.wavefronts.length);
        addSegments(wavefront.segments, currentLayer.z, {
          color: style.color,
          width: style.width,
          alpha: style.alpha
        });
      });
    }

    return { points, segments, polygons, callouts };
  }, [
    currentLayer,
    data,
    modelInfo,
    selectedLayerIndex,
    showPreviousLayer,
    showTravelMoves,
    showWaveGuide,
    wavePathPlan,
    persistentWavePathPlans,
    layerAlpha,
    resolvedLayerIndexes
  ]);

  const projectedCallouts = useMemo(() => {
    if (!data || !modelInfo || scene.callouts.length === 0) {
      return [];
    }

    const project = (point: ModelPoint3D) => projectPoint(point, view.rotationX, view.rotationZ);
    const scale =
      (Math.min(canvasSize.width, canvasSize.height) - VIEWER_CANVAS_PADDING * 2) /
      (modelRadius * 2) *
      view.zoom;

    return scene.callouts.map((callout) => {
      const projectedAnchor = project(callout.anchor);
      return {
        layerIndex: callout.layerIndex,
        left: projectedAnchor.x * scale + canvasSize.width / 2 + view.panX,
        top: canvasSize.height / 2 - projectedAnchor.y * scale + view.panY - 18,
        depth: projectedAnchor.depth
      };
    });
  }, [canvasSize.height, canvasSize.width, data, modelInfo, modelRadius, scene.callouts, view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, canvasSize.width);
    const height = Math.max(1, canvasSize.height);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#fffaf2');
    gradient.addColorStop(1, '#eef4f7');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    if (!data || !modelInfo || scene.points.length === 0 || scene.segments.length === 0) {
      context.fillStyle = '#41515b';
      context.font = '600 18px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
      context.fillText('Upload a G-code file to render the 3D stack.', 28, 44);
      context.font = '14px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
      context.fillText(
        'The 3D mode shows all extrusion layers at once while keeping the selected layer highlighted.',
        28,
        70
      );
      return;
    }

    const resolvedModelInfo = modelInfo;
    const project = (point: ModelPoint3D) => projectPoint(point, view.rotationX, view.rotationZ);
    const projectedPoints = scene.points.map(project);
    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = Number.NEGATIVE_INFINITY;

    for (const point of projectedPoints) {
      minDepth = Math.min(minDepth, point.depth);
      maxDepth = Math.max(maxDepth, point.depth);
    }

    const scale =
      (Math.min(width, height) - VIEWER_CANVAS_PADDING * 2) / (modelRadius * 2) * view.zoom;
    const depthRange = Math.max(maxDepth - minDepth, 0.0001);
    const toScreen = (point: ProjectedPoint3D) => ({
      x: point.x * scale + width / 2 + view.panX,
      y: height / 2 - point.y * scale + view.panY
    });

    const floor = [
      { x: resolvedModelInfo.bounds.minX, y: resolvedModelInfo.bounds.minY },
      { x: resolvedModelInfo.bounds.maxX, y: resolvedModelInfo.bounds.minY },
      { x: resolvedModelInfo.bounds.maxX, y: resolvedModelInfo.bounds.maxY },
      { x: resolvedModelInfo.bounds.minX, y: resolvedModelInfo.bounds.maxY }
    ]
      .map((corner) =>
        project(
          toModelPoint(corner.x, corner.y, resolvedModelInfo.minZ)
        )
      )
      .map(toScreen);

    context.save();
    context.fillStyle = 'rgba(24, 49, 61, 0.05)';
    context.strokeStyle = 'rgba(24, 49, 61, 0.12)';
    context.lineWidth = 1;
    context.beginPath();
    floor.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();

    const sortedPolygons = scene.polygons
      .map((polygon) => {
        const projectedRings = polygon.rings.map((ring) => ring.map(project));
        const depthValues = projectedRings.flat().map((point) => point.depth);
        const averageDepth =
          depthValues.reduce((sum, value) => sum + value, 0) /
          Math.max(depthValues.length, 1);

        return {
          ...polygon,
          projectedRings,
          averageDepth
        };
      })
      .sort((left, right) => left.averageDepth - right.averageDepth);

    for (const polygon of sortedPolygons) {
      context.save();
      context.fillStyle = polygon.fill;
      context.strokeStyle = polygon.stroke;
      context.globalAlpha = polygon.fillAlpha;
      context.lineWidth = polygon.strokeWidth;
      context.beginPath();

      for (const ring of polygon.projectedRings) {
        ring.forEach((point, index) => {
          const screenPoint = toScreen(point);
          if (index === 0) {
            context.moveTo(screenPoint.x, screenPoint.y);
          } else {
            context.lineTo(screenPoint.x, screenPoint.y);
          }
        });
        context.closePath();
      }

      context.fill('evenodd');
      context.globalAlpha = polygon.strokeAlpha;
      context.stroke();
      context.restore();
    }

    const sortedSegments = scene.segments
      .map((segment) => {
        const start = project(segment.start);
        const end = project(segment.end);
        return {
          ...segment,
          projectedStart: start,
          projectedEnd: end,
          averageDepth: (start.depth + end.depth) / 2
        };
      })
      .sort((left, right) => left.averageDepth - right.averageDepth);

    for (const segment of sortedSegments) {
      const start = toScreen(segment.projectedStart);
      const end = toScreen(segment.projectedEnd);
      const depthFactor = (segment.averageDepth - minDepth) / depthRange;

      context.save();
      context.strokeStyle = segment.color;
      context.globalAlpha = segment.alpha * (0.62 + depthFactor * 0.38);
      context.lineWidth = segment.width * (0.82 + depthFactor * 0.3);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      if (segment.dashed) {
        context.setLineDash([6, 6]);
      }
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
      context.restore();
    }

    context.save();
    context.fillStyle = '#17313d';
    context.font = '600 13px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
    context.fillText(
      `3D stack view - selected layer ${selectedLayerIndex} at Z ${currentLayer?.z.toFixed(3) ?? '0.000'} mm`,
      20,
      28
    );
    context.fillStyle = '#54646d';
    context.font = '12px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
    context.fillText('Drag to pan, Shift+drag to orbit, wheel to zoom.', 20, 46);
    context.restore();

    function toModelPoint(x: number, y: number, z: number): ModelPoint3D {
      return {
        x: x - resolvedModelInfo.centerX,
        y: y - resolvedModelInfo.centerY,
        z: (resolvedModelInfo.centerZ - z) * resolvedModelInfo.zScale
      };
    }
  }, [canvasSize, currentLayer, data, modelInfo, modelRadius, scene, selectedLayerIndex, view]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      active: true,
      isPanning: !event.shiftKey
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.active) {
      return;
    }

    const deltaX = event.clientX - dragRef.current.startX;
    const deltaY = event.clientY - dragRef.current.startY;
    dragRef.current.startX = event.clientX;
    dragRef.current.startY = event.clientY;

    if (dragRef.current.isPanning) {
      setView((current) => ({
        ...current,
        panX: current.panX + deltaX,
        panY: current.panY + deltaY
      }));
      return;
    }

    setView((current) => ({
      ...current,
      rotationZ: current.rotationZ + deltaX * 0.01,
      rotationX: clamp(current.rotationX - deltaY * 0.01, -1.25, 1.25)
    }));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!pointerInsideCanvasRef.current) {
      return;
    }

    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    setView((current) => ({
      ...current,
      zoom: clamp(current.zoom * factor, 0.35, 8)
    }));
  };

  return (
    <div className="viewer-shell" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="viewer-canvas"
        onPointerEnter={() => {
          pointerInsideCanvasRef.current = true;
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={(event) => {
          pointerInsideCanvasRef.current = false;
          handlePointerUp(event);
        }}
        onWheel={handleWheel}
      />
      <div className="viewer-callouts">
        {projectedCallouts.map((callout) => (
          <button
            key={callout.layerIndex}
            type="button"
            className={`viewer-callout ${
              callout.layerIndex === selectedLayerIndex ? 'is-active' : ''
            }`}
            style={{
              left: `${callout.left}px`,
              top: `${callout.top}px`,
              zIndex: Math.max(1, Math.round(callout.depth * 1000) + 1000)
            }}
            onClick={() => onLayerSelect(callout.layerIndex)}
          >
            Layer {callout.layerIndex}
          </button>
        ))}
      </div>
    </div>
  );
}

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
import { expandBounds, mergeBounds } from '../lib/geometry';
import { splitSegmentsIntoConnectedPolylines } from '../lib/polyline';
import type {
  AnalyzedLayerData,
  Coordinate,
  LinePart,
  MultiPolygonShape,
  WavePathPlan
} from '../types/gcode';

interface LayerCanvasProps {
  currentLayer: AnalyzedLayerData | null;
  previousLayer: AnalyzedLayerData | null;
  showPreviousLayer: boolean;
  showTravelMoves: boolean;
  showPoints: boolean;
  showWaveGuide: boolean;
  wavePathPlan: WavePathPlan | null;
  resetToken: number;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface CanvasSize {
  width: number;
  height: number;
}

const INITIAL_VIEW: ViewState = {
  zoom: 1,
  panX: 0,
  panY: 0
};

const WAVEFRONT_RENDER_STYLES = {
  latest: { color: '#d72670', width: 2.2, alpha: 0.98 },
  previous: { color: '#0b8ed9', width: 1.9, alpha: 0.9 },
  older: { color: '#708090', width: 1.5, alpha: 0.52 }
} as const;

function wavefrontRenderStyle(index: number, total: number) {
  if (index === total - 1) {
    return WAVEFRONT_RENDER_STYLES.latest;
  }

  if (index === total - 2) {
    return WAVEFRONT_RENDER_STYLES.previous;
  }

  return WAVEFRONT_RENDER_STYLES.older;
}

export function LayerCanvas({
  currentLayer,
  previousLayer,
  showPreviousLayer,
  showTravelMoves,
  showPoints,
  showWaveGuide,
  wavePathPlan,
  resetToken
}: LayerCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef({ startX: 0, startY: 0, active: false });
  const pointerInsideCanvasRef = useRef(false);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 800, height: 600 });
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);

  useEffect(() => {
    setView(INITIAL_VIEW);
  }, [currentLayer?.index, resetToken]);

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

  const drawingBounds = useMemo(() => {
    const bounds = mergeBounds([
      currentLayer?.bounds ?? null,
      showPreviousLayer ? previousLayer?.bounds ?? null : null
    ]);

    return bounds ? expandBounds(bounds, 1) : null;
  }, [currentLayer?.bounds, previousLayer?.bounds, showPreviousLayer]);

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

    if (!currentLayer || !drawingBounds) {
      context.fillStyle = '#41515b';
      context.font = '600 18px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
      context.fillText('Upload a G-code file to render a layer.', 28, 44);
      context.font = '14px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
      context.fillText(
        'The canvas will fit the current geometry automatically and keeps file contents local to the browser.',
        28,
        70
      );
      return;
    }

    const boundsWidth = Math.max(drawingBounds.maxX - drawingBounds.minX, 1);
    const boundsHeight = Math.max(drawingBounds.maxY - drawingBounds.minY, 1);
    const fitScale = Math.min(
      (width - VIEWER_CANVAS_PADDING * 2) / boundsWidth,
      (height - VIEWER_CANVAS_PADDING * 2) / boundsHeight
    );
    const scale = Math.max(0.01, fitScale * view.zoom);
    const centerX = (drawingBounds.minX + drawingBounds.maxX) / 2;
    const centerY = (drawingBounds.minY + drawingBounds.maxY) / 2;

    const worldToScreen = (x: number, y: number) => ({
      x: (x - centerX) * scale + width / 2 + view.panX,
      y: height / 2 - (y - centerY) * scale + view.panY
    });

    const drawSegments = (
      segments: Array<{ x1: number; y1: number; x2: number; y2: number }>,
      options: { color: string; width: number; alpha?: number; dashed?: boolean }
    ) => {
      context.save();
      context.strokeStyle = options.color;
      context.lineWidth = options.width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.globalAlpha = options.alpha ?? 1;
      if (options.dashed) {
        context.setLineDash([6, 6]);
      }

      for (const segment of segments) {
        const start = worldToScreen(segment.x1, segment.y1);
        const end = worldToScreen(segment.x2, segment.y2);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }

      context.restore();
    };

    const drawRoundedPolyline = (
      points: Coordinate[],
      options: { color: string; width: number; alpha?: number }
    ) => {
      if (points.length < 2) {
        return;
      }

      context.save();
      context.strokeStyle = options.color;
      context.lineWidth = options.width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.globalAlpha = options.alpha ?? 1;
      context.beginPath();

      const firstPoint = worldToScreen(points[0][0], points[0][1]);
      context.moveTo(firstPoint.x, firstPoint.y);

      if (points.length === 2) {
        const lastPoint = worldToScreen(points[1][0], points[1][1]);
        context.lineTo(lastPoint.x, lastPoint.y);
      } else {
        for (let index = 1; index < points.length - 1; index += 1) {
          const currentPoint = worldToScreen(points[index][0], points[index][1]);
          const nextMidpoint = worldToScreen(
            (points[index][0] + points[index + 1][0]) / 2,
            (points[index][1] + points[index + 1][1]) / 2
          );
          context.quadraticCurveTo(
            currentPoint.x,
            currentPoint.y,
            nextMidpoint.x,
            nextMidpoint.y
          );
        }

        const lastPoint = worldToScreen(
          points[points.length - 1][0],
          points[points.length - 1][1]
        );
        context.lineTo(lastPoint.x, lastPoint.y);
      }

      context.stroke();
      context.restore();
    };

    const drawSmoothedWaveSegments = (
      segments: LinePart[],
      options: { color: string; width: number; alpha?: number }
    ) => {
      const polylines = splitSegmentsIntoConnectedPolylines(segments);

      if (polylines.length === 0) {
        drawSegments(segments, options);
        return;
      }

      for (const polyline of polylines) {
        drawRoundedPolyline(polyline, options);
      }
    };

    const drawPolygons = (
      geometry: MultiPolygonShape,
      options: { color: string; alpha: number }
    ) => {
      if (geometry.length === 0) {
        return;
      }

      context.save();
      context.fillStyle = options.color;
      context.globalAlpha = options.alpha;

      for (const polygon of geometry) {
        if (polygon.length === 0) {
          continue;
        }

        context.beginPath();
        for (const ring of polygon) {
          if (ring.length < 3) {
            continue;
          }

          for (const [index, coordinate] of ring.entries()) {
            const point = worldToScreen(coordinate[0], coordinate[1]);
            if (index === 0) {
              context.moveTo(point.x, point.y);
            } else {
              context.lineTo(point.x, point.y);
            }
          }
          context.closePath();
        }
        context.fill('evenodd');
      }

      context.restore();
    };

    const drawPoints = (
      segments: Array<{ x1: number; y1: number; x2: number; y2: number }>,
      options: { color: string; radius: number; alpha?: number }
    ) => {
      const seen = new Set<string>();

      context.save();
      context.fillStyle = options.color;
      context.globalAlpha = options.alpha ?? 1;

      const drawPoint = (x: number, y: number) => {
        const key = `${x.toFixed(4)},${y.toFixed(4)}`;
        if (seen.has(key)) {
          return;
        }

        seen.add(key);
        const point = worldToScreen(x, y);
        context.beginPath();
        context.arc(point.x, point.y, options.radius, 0, Math.PI * 2);
        context.fill();
      };

      for (const segment of segments) {
        drawPoint(segment.x1, segment.y1);
        drawPoint(segment.x2, segment.y2);
      }

      context.restore();
    };

    if (showTravelMoves) {
      drawSegments(currentLayer.travelSegments, {
        color: '#8fa3ad',
        width: 1,
        alpha: 0.75,
        dashed: true
      });
    }

    drawPolygons(currentLayer.overhangRegion, {
      color: '#d8572a',
      alpha: 0.14
    });

    if (showPreviousLayer && previousLayer) {
      drawSegments(previousLayer.extrusionSegments, {
        color: '#7ea0b3',
        width: 2,
        alpha: 0.35
      });
    }

    drawSegments(
      currentLayer.extrusionSegments.flatMap((segment) => segment.normalParts),
      {
        color: '#176b87',
        width: 2.25
      }
    );

    if (!wavePathPlan) {
      drawSegments(
        currentLayer.extrusionSegments.flatMap((segment) => segment.overhangParts),
        {
          color: '#d8572a',
          width: 2.8
        }
      );
    }

    if (showWaveGuide) {
      drawSegments(currentLayer.waveGuide.boundarySegments, {
        color: '#f2a541',
        width: 4.4
      });
      drawSegments(currentLayer.waveGuide.seedSegments, {
        color: '#2ca58d',
        width: 5
      });
    }

    if (wavePathPlan) {
      wavePathPlan.wavefronts.forEach((wavefront, index) => {
        const style = wavefrontRenderStyle(index, wavePathPlan.wavefronts.length);
        drawSegments(wavefront.segments, {
          color: style.color,
          width: style.width,
          alpha: style.alpha
        });
      });
    }

    if (showPoints && !showWaveGuide && !wavePathPlan) {
      drawPoints(currentLayer.extrusionSegments, {
        color: '#0f4f66',
        radius: 2.8
      });

      drawPoints(
        currentLayer.extrusionSegments.filter((segment) => segment.isCandidateOverhang),
        {
          color: '#b8441e',
          radius: 3.2
        }
      );

      if (showTravelMoves) {
        drawPoints(currentLayer.travelSegments, {
          color: '#7f939c',
          radius: 2.2,
          alpha: 0.8
        });
      }
    }

    context.save();
    context.fillStyle = '#17313d';
    context.font = '600 13px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
    context.fillText(`Layer ${currentLayer.index} - Z ${currentLayer.z.toFixed(3)} mm`, 20, 28);
    context.fillStyle = '#54646d';
    context.font = '12px "IBM Plex Sans", Aptos, "Segoe UI", sans-serif';
    context.fillText('Wheel to zoom, drag to pan.', 20, 46);
    context.restore();
  }, [
    canvasSize,
    currentLayer,
    drawingBounds,
    previousLayer,
    showPoints,
    showPreviousLayer,
    showTravelMoves,
    showWaveGuide,
    wavePathPlan,
    view
  ]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      active: true
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

    setView((current) => ({
      ...current,
      panX: current.panX + deltaX,
      panY: current.panY + deltaY
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
      zoom: Math.min(12, Math.max(0.4, current.zoom * factor))
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
    </div>
  );
}

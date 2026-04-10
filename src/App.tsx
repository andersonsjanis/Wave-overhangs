import { useRef, useState } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { LayerCanvas } from './components/LayerCanvas';
import { Stack3DCanvas } from './components/Stack3DCanvas';
import {
  DEFAULT_GCODE_EXPORT_SETTINGS,
  DEFAULT_WAVE_PATH_SETTINGS
} from './lib/config';
import { buildPostProcessedGcode } from './lib/gcodeExport';
import { analyzeOverhangs } from './lib/overhangDetection';
import { parseGcode } from './lib/gcodeParser';
import {
  generateWavePathPlanProgressively
} from './lib/wavePathPlanning';
import type {
  AnalyzedGcode,
  GcodeExportSettings,
  ViewerMode,
  WavePathPlan,
  WavePathSettings
} from './types/gcode';

const DEMO_GCODE_URL = `${import.meta.env.BASE_URL}demo/sample-overhang.gcode`;

interface ExportStatusMessage {
  tone: 'default' | 'warning';
  text: string;
}

export default function App() {
  const [data, setData] = useState<AnalyzedGcode | null>(null);
  const [viewMode, setViewMode] = useState<ViewerMode>('3d');
  const [selectedLayerIndex, setSelectedLayerIndex] = useState(0);
  const [showPreviousLayer, setShowPreviousLayer] = useState(true);
  const [showTravelMoves, setShowTravelMoves] = useState(false);
  const [showPoints, setShowPoints] = useState(true);
  const [alwaysShowWavePaths, setAlwaysShowWavePaths] = useState(false);
  const [layerAlpha, setLayerAlpha] = useState(0.17);
  const [waveGuideLayerIndex, setWaveGuideLayerIndex] = useState<number | null>(null);
  const [wavePathPlans, setWavePathPlans] = useState<Record<number, WavePathPlan>>({});
  const [wavePathSettings, setWavePathSettings] = useState<WavePathSettings>(
    DEFAULT_WAVE_PATH_SETTINGS
  );
  const [gcodeExportSettings, setGcodeExportSettings] = useState<GcodeExportSettings>(
    DEFAULT_GCODE_EXPORT_SETTINGS
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isGeneratingWavePaths, setIsGeneratingWavePaths] = useState(false);
  const [exportMessage, setExportMessage] = useState<ExportStatusMessage | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const waveGenerationRunIdRef = useRef(0);

  const handleParsedContent = (
    content: string,
    metadata: { fileName: string; fileSize: number }
  ) => {
    const parsed = parseGcode(content, metadata);
    const analyzed = analyzeOverhangs(parsed);

    if (analyzed.layers.length === 0) {
      throw new Error(
        'No printable extrusion layers were detected. Try a sliced FDM toolpath with G0/G1 movement and E extrusion values.'
      );
    }

    setData(analyzed);
    setSelectedLayerIndex(0);
    setWaveGuideLayerIndex(null);
    setWavePathPlans({});
    setResetToken((value) => value + 1);
    setErrorMessage(null);
    setExportMessage(null);
  };

  const handleFileSelected = async (file: File) => {
    try {
      setIsBusy(true);
      const content = await file.text();
      handleParsedContent(content, {
        fileName: file.name,
        fileSize: file.size
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The selected file could not be parsed.';
      setErrorMessage(message);
      setExportMessage(null);
      setData(null);
    } finally {
      setIsBusy(false);
    }
  };

  const handleLoadDemo = async () => {
    try {
      if (
        data &&
        !window.confirm(
          'Replace the currently loaded file with the bundled demo sample?'
        )
      ) {
        return;
      }

      setIsBusy(true);
      const response = await fetch(DEMO_GCODE_URL);
      if (!response.ok) {
        throw new Error('The bundled demo file could not be loaded.');
      }

      const content = await response.text();
      handleParsedContent(content, {
        fileName: 'sample-overhang.gcode',
        fileSize: content.length
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The demo file could not be loaded.';
      setErrorMessage(message);
      setExportMessage(null);
      setData(null);
    } finally {
      setIsBusy(false);
    }
  };

  const maxLayerIndex = data ? data.layers.length - 1 : 0;
  const currentLayer = data?.layers[selectedLayerIndex] ?? null;
  const previousLayer =
    data && selectedLayerIndex > 0 ? data.layers[selectedLayerIndex - 1] : null;
  const currentWavePathPlan = wavePathPlans[selectedLayerIndex] ?? null;
  const generatedWavePlanCount = Object.values(wavePathPlans).filter(
    (plan) => plan.wavefronts.length > 0
  ).length;
  const resolvedLayerIndexes = new Set(
    Object.values(wavePathPlans)
      .filter((plan) => plan.wavefronts.length > 0)
      .map((plan) => plan.layerIndex)
  );
  const currentLayerHasResolvedWavePath = resolvedLayerIndexes.has(selectedLayerIndex);

  const handleGenerateWaveGuide = (layerIndex: number) => {
    setWaveGuideLayerIndex(layerIndex);
  };

  const handleConfirmWaveGuide = async () => {
    if (!currentLayer) {
      return;
    }

    const runId = waveGenerationRunIdRef.current + 1;
    waveGenerationRunIdRef.current = runId;

    try {
      setIsGeneratingWavePaths(true);
      setWaveGuideLayerIndex(currentLayer.index);
      setErrorMessage(null);
      setExportMessage(null);
      setWavePathPlans((currentPlans) => ({
        ...currentPlans,
        [currentLayer.index]: {
          layerIndex: currentLayer.index,
          seedSegments: currentLayer.waveGuide.seedSegments,
          boundarySegments: currentLayer.waveGuide.boundarySegments,
          wavefronts: [],
          generationMode:
            wavePathSettings.wavePropagationModel === 'huygens'
              ? ('vector' as const)
              : ('raster-fallback' as const),
          settings: wavePathSettings
        }
      }));

      const nextPlan = await generateWavePathPlanProgressively(
        currentLayer,
        wavePathSettings,
        (partialPlan) => {
          if (waveGenerationRunIdRef.current !== runId) {
            return;
          }

          setWavePathPlans((currentPlans) => ({
            ...currentPlans,
            [currentLayer.index]: partialPlan
          }));
        }
      );

      if (waveGenerationRunIdRef.current !== runId) {
        return;
      }

      setWavePathPlans((currentPlans) => ({
        ...currentPlans,
        [currentLayer.index]: nextPlan
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Wave path generation failed for this layer.';
      setErrorMessage(
        `Wave path generation failed for this layer. ${message}`
      );
    } finally {
      if (waveGenerationRunIdRef.current === runId) {
        setIsGeneratingWavePaths(false);
      }
    }
  };

  const handleGenerateOutputGcode = async () => {
    if (!data) {
      return;
    }

    try {
      setIsExporting(true);
      const output = buildPostProcessedGcode(data, wavePathPlans, gcodeExportSettings);
      const blob = new Blob([output.content], { type: 'text/plain;charset=utf-8' });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = output.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);

      let savedPathSuffix = '';

      try {
        const response = await fetch(
          new URL('api/save-generated-gcode', window.location.href).toString(),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              fileName: output.fileName,
              content: output.content
            })
          }
        );

        if (response.ok) {
          const saved = (await response.json()) as { savedPath?: string };
          if (saved.savedPath) {
            savedPathSuffix = ` Saved a copy to ${saved.savedPath}.`;
          }
        }
      } catch {
        // Static builds do not have a writable server endpoint, so download-only
        // export remains the default behavior.
      }

      setExportMessage({
        tone: 'default',
        text: `Downloaded ${output.fileName} with wave-path replacements for ${output.modifiedLayerIndexes.length} layer(s).${savedPathSuffix}`
      });
      setErrorMessage(null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The output G-code could not be generated.';
      setExportMessage({
        tone: 'warning',
        text: message
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="app-shell">
      <ControlPanel
        data={data}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        selectedLayerIndex={selectedLayerIndex}
        onLayerChange={(layerIndex) =>
          setSelectedLayerIndex(Math.min(Math.max(layerIndex, 0), maxLayerIndex))
        }
        onFileSelected={handleFileSelected}
        onLoadDemo={handleLoadDemo}
        showPreviousLayer={showPreviousLayer}
        onShowPreviousLayerChange={setShowPreviousLayer}
        showTravelMoves={showTravelMoves}
        onShowTravelMovesChange={setShowTravelMoves}
        showPoints={showPoints}
        onShowPointsChange={setShowPoints}
        alwaysShowWavePaths={alwaysShowWavePaths}
        onAlwaysShowWavePathsChange={setAlwaysShowWavePaths}
        layerAlpha={layerAlpha}
        onLayerAlphaChange={setLayerAlpha}
        waveGuideLayerIndex={waveGuideLayerIndex}
        hasWavePathPlan={Boolean(currentWavePathPlan)}
        wavePathCount={currentWavePathPlan?.wavefronts.length ?? 0}
        waveGenerationMode={currentWavePathPlan?.generationMode ?? null}
        waveWavelength={wavePathSettings.wavelength}
        onWaveWavelengthChange={(wavelength) =>
          setWavePathSettings((current) => ({
            ...current,
            wavelength
          }))
        }
        waveIterationLimit={wavePathSettings.iterationLimit}
        onWaveIterationLimitChange={(iterationLimit) =>
          setWavePathSettings((current) => ({
            ...current,
            iterationLimit
          }))
        }
        waveAlgorithm={wavePathSettings.wavePropagationModel ?? 'raster'}
        onWaveAlgorithmChange={(wavePropagationModel) =>
          setWavePathSettings((current) => ({
            ...current,
            wavePropagationModel
          }))
        }
        rasterResolution={wavePathSettings.rasterSubdivisions ?? 1}
        onRasterResolutionChange={(rasterSubdivisions) =>
          setWavePathSettings((current) => ({
            ...current,
            rasterSubdivisions: Math.min(64, Math.max(1, Math.round(rasterSubdivisions)))
          }))
        }
        wavefrontResolution={wavePathSettings.waveBufferQuadrantSegments ?? 16}
        onWavefrontResolutionChange={(waveBufferQuadrantSegments) =>
          setWavePathSettings((current) => ({
            ...current,
            waveBufferQuadrantSegments
          }))
        }
        beadArea={gcodeExportSettings.beadArea}
        onBeadAreaChange={(beadArea) =>
          setGcodeExportSettings((current) => ({
            ...current,
            beadArea
          }))
        }
        filamentDiameter={gcodeExportSettings.filamentDiameter}
        onFilamentDiameterChange={(filamentDiameter) =>
          setGcodeExportSettings((current) => ({
            ...current,
            filamentDiameter
          }))
        }
        retractionDistance={gcodeExportSettings.retractionDistance}
        onRetractionDistanceChange={(retractionDistance) =>
          setGcodeExportSettings((current) => ({
            ...current,
            retractionDistance
          }))
        }
        onGenerateWaveGuide={handleGenerateWaveGuide}
        onConfirmWaveGuide={handleConfirmWaveGuide}
        onHideWaveGuide={() => {
          waveGenerationRunIdRef.current += 1;
          setIsGeneratingWavePaths(false);
          setWaveGuideLayerIndex(null);
        }}
        onGenerateOutputGcode={handleGenerateOutputGcode}
        onResetView={() => setResetToken((value) => value + 1)}
        errorMessage={errorMessage}
        exportMessage={exportMessage}
        canGenerateOutputGcode={generatedWavePlanCount > 0}
        isBusy={isBusy}
        isExporting={isExporting}
        isGeneratingWavePaths={isGeneratingWavePaths}
      />

      <main className="viewer-panel">
        {viewMode === '2d' ? (
          <LayerCanvas
            currentLayer={currentLayer}
            previousLayer={previousLayer}
            showPreviousLayer={showPreviousLayer}
            showTravelMoves={showTravelMoves}
            showPoints={showPoints}
            hasResolvedWavePath={currentLayerHasResolvedWavePath}
            showWaveGuide={waveGuideLayerIndex === selectedLayerIndex}
            wavePathPlan={
              waveGuideLayerIndex === selectedLayerIndex ? currentWavePathPlan : null
            }
            persistentWavePathPlan={
              alwaysShowWavePaths ? currentWavePathPlan : null
            }
            resetToken={resetToken}
          />
        ) : (
          <Stack3DCanvas
            data={data}
            currentLayer={currentLayer}
            selectedLayerIndex={selectedLayerIndex}
            onLayerSelect={(layerIndex) =>
              setSelectedLayerIndex(Math.min(Math.max(layerIndex, 0), maxLayerIndex))
            }
            layerAlpha={layerAlpha}
            resolvedLayerIndexes={resolvedLayerIndexes}
            showPreviousLayer={showPreviousLayer}
            showTravelMoves={showTravelMoves}
            showWaveGuide={waveGuideLayerIndex === selectedLayerIndex}
            wavePathPlan={
              waveGuideLayerIndex === selectedLayerIndex ? currentWavePathPlan : null
            }
            persistentWavePathPlans={alwaysShowWavePaths ? wavePathPlans : {}}
            resetToken={resetToken}
          />
        )}
      </main>
    </div>
  );
}

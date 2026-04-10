import { formatBytes, formatNumber } from '../lib/format';
import type {
  AnalyzedGcode,
  ViewerMode,
  WavePropagationModel
} from '../types/gcode';
import { FileDropZone } from './FileDropZone';
import { StatCard } from './StatCard';

interface ControlPanelProps {
  data: AnalyzedGcode | null;
  viewMode: ViewerMode;
  onViewModeChange: (mode: ViewerMode) => void;
  selectedLayerIndex: number;
  onLayerChange: (layerIndex: number) => void;
  onFileSelected: (file: File) => void;
  onLoadDemo: () => void;
  showPreviousLayer: boolean;
  onShowPreviousLayerChange: (value: boolean) => void;
  showTravelMoves: boolean;
  onShowTravelMovesChange: (value: boolean) => void;
  showPoints: boolean;
  onShowPointsChange: (value: boolean) => void;
  alwaysShowWavePaths: boolean;
  onAlwaysShowWavePathsChange: (value: boolean) => void;
  layerAlpha: number;
  onLayerAlphaChange: (value: number) => void;
  waveGuideLayerIndex: number | null;
  hasWavePathPlan: boolean;
  wavePathCount: number;
  waveGenerationMode: 'vector' | 'raster-fallback' | null;
  waveWavelength: number;
  onWaveWavelengthChange: (value: number) => void;
  waveIterationLimit: number;
  onWaveIterationLimitChange: (value: number) => void;
  waveAlgorithm: WavePropagationModel;
  onWaveAlgorithmChange: (value: WavePropagationModel) => void;
  rasterResolution: number;
  onRasterResolutionChange: (value: number) => void;
  wavefrontResolution: number;
  onWavefrontResolutionChange: (value: number) => void;
  beadArea: number;
  onBeadAreaChange: (value: number) => void;
  filamentDiameter: number;
  onFilamentDiameterChange: (value: number) => void;
  retractionDistance: number;
  onRetractionDistanceChange: (value: number) => void;
  onGenerateWaveGuide: (layerIndex: number) => void;
  onConfirmWaveGuide: () => void;
  onHideWaveGuide: () => void;
  onGenerateOutputGcode: () => void;
  onResetView: () => void;
  errorMessage: string | null;
  exportMessage: { tone: 'default' | 'warning'; text: string } | null;
  canGenerateOutputGcode: boolean;
  isBusy?: boolean;
  isExporting?: boolean;
  isGeneratingWavePaths?: boolean;
}

export function ControlPanel({
  data,
  viewMode,
  onViewModeChange,
  selectedLayerIndex,
  onLayerChange,
  onFileSelected,
  onLoadDemo,
  showPreviousLayer,
  onShowPreviousLayerChange,
  showTravelMoves,
  onShowTravelMovesChange,
  showPoints,
  onShowPointsChange,
  alwaysShowWavePaths,
  onAlwaysShowWavePathsChange,
  layerAlpha,
  onLayerAlphaChange,
  waveGuideLayerIndex,
  hasWavePathPlan,
  wavePathCount,
  waveGenerationMode,
  waveWavelength,
  onWaveWavelengthChange,
  waveIterationLimit,
  onWaveIterationLimitChange,
  waveAlgorithm,
  onWaveAlgorithmChange,
  rasterResolution,
  onRasterResolutionChange,
  wavefrontResolution,
  onWavefrontResolutionChange,
  beadArea,
  onBeadAreaChange,
  filamentDiameter,
  onFilamentDiameterChange,
  retractionDistance,
  onRetractionDistanceChange,
  onGenerateWaveGuide,
  onConfirmWaveGuide,
  onHideWaveGuide,
  onGenerateOutputGcode,
  onResetView,
  errorMessage,
  exportMessage,
  canGenerateOutputGcode,
  isBusy = false,
  isExporting = false,
  isGeneratingWavePaths = false
}: ControlPanelProps) {
  const currentLayer = data?.layers[selectedLayerIndex] ?? null;
  const isWaveGuideActive = waveGuideLayerIndex === selectedLayerIndex;

  return (
    <aside className="panel">
      <header className="panel__header">
        <p className="eyebrow">Browser-only MVP</p>
        <h1>Wave overhang post-processor</h1>
        <p className="panel__subtitle">
          Upload a sliced FDM `.gcode` file, inspect layers, and highlight
          segments that look under-supported relative to the previous layer.
        </p>
        <p className="small-note panel__disclaimer">
          Based on the <em>Wave Overhangs</em> strategy, as described by J. A.
          Andersons et al. in the manuscript{' '}
          <em>"Wave-inspired path-planning for support-free horizontal overhangs in FDM"</em>,
          {' '}currently under review for Additive Manufacturing Letters.
        </p>
      </header>

      <section className="panel__section">
        <FileDropZone
          onFileSelected={onFileSelected}
          onLoadDemo={onLoadDemo}
          hasLoadedData={Boolean(data)}
          isBusy={isBusy}
        />
      </section>

      {errorMessage ? (
        <section className="panel__section">
          <div className="message message--error">{errorMessage}</div>
        </section>
      ) : null}

      {data ? (
        <>
          <section className="panel__section">
            <h2>File</h2>
            <dl className="meta-list">
              <div>
                <dt>Name</dt>
                <dd>{data.fileName}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(data.fileSize)}</dd>
              </div>
              <div>
                <dt>Layers</dt>
                <dd>{data.layers.length}</dd>
              </div>
              <div>
                <dt>Extrusion segments</dt>
                <dd>{data.extrusionSegments.length}</dd>
              </div>
            </dl>
            {data.warnings.length > 0 ? (
              <div className="message message--warning">
                {data.warnings[0]}
              </div>
            ) : null}
          </section>

          <section className="panel__section">
            <div className="section-heading">
              <h2>Layer</h2>
              <button type="button" className="button button--ghost" onClick={onResetView}>
                Reset view
              </button>
            </div>
            <div className="control">
              <span>Viewer mode</span>
              <div className="segmented-control" role="tablist" aria-label="Viewer mode">
                <button
                  type="button"
                  className={`segmented-control__button ${
                    viewMode === '2d' ? 'is-active' : ''
                  }`}
                  onClick={() => onViewModeChange('2d')}
                  aria-pressed={viewMode === '2d'}
                >
                  2D layer
                </button>
                <button
                  type="button"
                  className={`segmented-control__button ${
                    viewMode === '3d' ? 'is-active' : ''
                  }`}
                  onClick={() => onViewModeChange('3d')}
                  aria-pressed={viewMode === '3d'}
                >
                  3D stack
                </button>
              </div>
            </div>
            <label className="control">
              <span>Layer index</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, data.layers.length - 1)}
                value={selectedLayerIndex}
                onChange={(event) => onLayerChange(Number(event.target.value))}
              />
            </label>
            <label className="control">
              <span>Numeric selector</span>
              <input
                type="number"
                min={0}
                max={Math.max(0, data.layers.length - 1)}
                value={selectedLayerIndex}
                onChange={(event) => {
                  const nextIndex = Number(event.target.value);
                  if (Number.isFinite(nextIndex)) {
                    onLayerChange(
                      Math.min(Math.max(nextIndex, 0), data.layers.length - 1)
                    );
                  }
                }}
              />
            </label>
            {currentLayer ? (
              <p className="layer-caption">
                {viewMode === '2d'
                  ? `Layer ${currentLayer.index} at Z ${formatNumber(currentLayer.z, 3)} mm`
                  : `Selected highlight: layer ${currentLayer.index} at Z ${formatNumber(
                      currentLayer.z,
                      3
                    )} mm while the full stack stays visible`}
              </p>
            ) : null}
          </section>

          {currentLayer ? (
            <section className="panel__section">
              <h2>Current layer stats</h2>
              <div className="stats-grid">
                <StatCard
                  label="Extrusion segments"
                  value={currentLayer.extrusionSegments.length}
                />
                <StatCard
                  label="Candidate overhangs"
                  value={currentLayer.overhangSegmentCount}
                  emphasis={currentLayer.overhangSegmentCount > 0 ? 'alert' : 'default'}
                />
                <StatCard
                  label="Overhang area"
                  value={`${formatNumber(currentLayer.overhangArea, 2)} mm2`}
                  emphasis={currentLayer.overhangArea > 0 ? 'alert' : 'default'}
                />
                <StatCard
                  label="Travel moves"
                  value={currentLayer.travelSegments.length}
                />
              </div>
            </section>
          ) : null}

          {currentLayer && currentLayer.overhangArea > 0 ? (
            <section className="panel__section wave-card">
              <div>
                <p className="eyebrow">Wave overhang planning</p>
                <h2>Generate wave paths for this overhang?</h2>
              </div>
              <p className="small-note">
                First step: identify the supported seed edge and the exposed
                overhang boundary, then show them in different colors.
              </p>
              <label className="control">
                <span>Wavelength (mm)</span>
                <input
                  type="number"
                  min={0.05}
                  max={10}
                  step={0.05}
                  value={waveWavelength}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      onWaveWavelengthChange(Math.min(10, Math.max(0.05, value)));
                    }
                  }}
                />
              </label>
              <p className="small-note">
                This sets the spacing/propagation distance between generated wavefronts.
                Smaller values create denser wave paths.
              </p>
              {waveAlgorithm === 'raster' ? (
                <>
                  <label className="control">
                    <span>Raster resolution ({rasterResolution}x)</span>
                    <input
                      type="number"
                      min={1}
                      max={64}
                      step={1}
                      value={rasterResolution}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          onRasterResolutionChange(
                            Math.min(64, Math.max(1, Math.round(value)))
                          );
                        }
                      }}
                    />
                  </label>
                  <p className="small-note">
                    Each detected overhang cell is subdivided into a finer raster grid before
                    wavefront propagation. Higher values preserve more curved detail, but the
                    work grows roughly with the square of this number.
                  </p>
                </>
              ) : null}
              {waveAlgorithm === 'huygens' ? (
                <>
                  <label className="control">
                    <span>Wavefront resolution ({wavefrontResolution})</span>
                    <input
                      type="range"
                      min={2}
                      max={24}
                      step={1}
                      value={wavefrontResolution}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          onWavefrontResolutionChange(
                            Math.min(24, Math.max(2, Math.round(value)))
                          );
                        }
                      }}
                    />
                  </label>
                  <p className="small-note">
                    Lower values generate rougher wavefronts but reduce processing time.
                    Higher values create smoother buffered fronts.
                  </p>
                </>
              ) : null}
              <label className="control">
                <span>Wave iteration limit</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={waveIterationLimit}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      onWaveIterationLimitChange(Math.min(1000, Math.max(1, Math.round(value))));
                    }
                  }}
                />
              </label>
              <p className="small-note">
                Increase this if the far boundary is not reached yet. Higher values
                generate more wavefronts and can take longer.
              </p>
              {isWaveGuideActive ? (
                <>
                  <div className="legend">
                    <span className="legend__item">
                      <span className="legend__swatch legend__swatch--seed" />
                      Seed: overlaps previous layer
                    </span>
                    <span className="legend__item">
                      <span className="legend__swatch legend__swatch--boundary" />
                      Boundary: overhang perimeter
                    </span>
                    {hasWavePathPlan ? (
                      <>
                        <span className="legend__item">
                          <span className="legend__swatch legend__swatch--wave-latest" />
                          Latest wavefront: W_i
                        </span>
                        <span className="legend__item">
                          <span className="legend__swatch legend__swatch--wave-history" />
                          Earlier wavefronts: W_(i-1), W_(i-2), ...
                        </span>
                      </>
                    ) : null}
                  </div>
                  {hasWavePathPlan ? (
                    <>
                      <div className="message">
                      {isGeneratingWavePaths
                          ? `Generating wave path preview... ${wavePathCount} wavefronts generated so far.`
                          : `Wave path preview generated with ${wavePathCount} wavefronts.`}
                        {' '}
                        Original overhanging paths are hidden while this preview is active.
                      </div>
                      {waveGenerationMode === 'raster-fallback' ? (
                        <div className="message message--warning">
                          Raster wave planning is active for this layer. Because it works on a
                          grid, corners and curved fronts can still look a bit jagged. Increase
                          raster resolution if you want the raster preview to track curves more
                          closely.
                        </div>
                      ) : null}
                      <div className="drop-zone__actions">
                        <button
                          type="button"
                          className="button button--primary"
                          onClick={onConfirmWaveGuide}
                          disabled={isGeneratingWavePaths}
                        >
                          {isGeneratingWavePaths
                            ? 'Generating wave paths...'
                            : 'Regenerate with current settings'}
                        </button>
                        <button type="button" className="button" onClick={onHideWaveGuide}>
                          Hide wave preview
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="message">
                        Are the seed and boundary correctly identified?
                      </div>
                      <div className="drop-zone__actions">
                        <button
                          type="button"
                          className="button button--primary"
                          onClick={onConfirmWaveGuide}
                          disabled={isGeneratingWavePaths}
                        >
                          {isGeneratingWavePaths
                            ? 'Generating wave paths...'
                            : 'Yes, generate wave paths'}
                        </button>
                        <button type="button" className="button" onClick={onHideWaveGuide}>
                          No, hide guide
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => onGenerateWaveGuide(currentLayer.index)}
                >
                  Generate wave paths for this overhang
                </button>
              )}
            </section>
          ) : null}

          <section className="panel__section">
            <h2>Heuristic notes</h2>
            <p className="small-note">
              Support is estimated only from the immediately previous layer using
              a rasterized outer-footprint comparison. The tunable constants live in
              <code>src/lib/config.ts</code>.
            </p>
          </section>

          <section className="panel__section">
            <h2>Output G-code</h2>
            <p className="small-note">
              Generate a post-processed file that keeps the original G-code and
              replaces detected overhang paths with the current wave-path plans.
            </p>
            <details className="parameter-disclosure">
              <summary>User parameters</summary>
              <div className="parameter-disclosure__content">
                <p className="small-note">
                  Choose how new wavefronts are propagated when previews are generated
                  and later exported into the output G-code.
                </p>
                <label className="control">
                  <span>Algorithm</span>
                  <select
                    value={waveAlgorithm}
                    onChange={(event) =>
                      onWaveAlgorithmChange(event.target.value as WavePropagationModel)
                    }
                  >
                    <option value="raster">raster</option>
                    <option value="huygens">huygens</option>
                  </select>
                </label>
                <p className="small-note">
                  Raster grows wavefronts on the overhang grid. Huygens buffers the
                  current seed by one wavelength, clips it to the overhang boundary,
                  removes the backward-facing curve, and keeps propagating every
                  remaining forward branch.
                </p>
                <label className="control">
                  <span>A_bead (mm2)</span>
                  <input
                    type="number"
                    min={0.001}
                    max={100}
                    step={0.001}
                    value={beadArea}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        onBeadAreaChange(Math.min(100, Math.max(0.001, value)));
                      }
                    }}
                  />
                </label>
                <label className="control">
                  <span>d_nozzle (mm)</span>
                  <input
                    type="number"
                    min={0.001}
                    max={10}
                    step={0.001}
                    value={filamentDiameter}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        onFilamentDiameterChange(Math.min(10, Math.max(0.001, value)));
                      }
                    }}
                  />
                </label>
                <label className="control">
                  <span>Retraction distance (mm)</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step={0.1}
                    value={retractionDistance}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        onRetractionDistanceChange(Math.min(20, Math.max(0, value)));
                      }
                    }}
                  />
                </label>
                <p className="small-note">
                  Print-move extrusion uses E = A_bead * l / (pi * (d_nozzle / 2)^2).
                  Each travel move is wrapped by retraction and unretraction.
                </p>
              </div>
            </details>
            <details className="parameter-disclosure">
              <summary>Visual settings</summary>
              <div className="parameter-disclosure__content">
                <p className="small-note">
                  Adjust what the viewer emphasizes in the 2D layer view and the 3D stack.
                </p>
                <label className="control">
                  <span>Layer alpha ({Math.round(layerAlpha * 100)}%)</span>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.01}
                    value={layerAlpha}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        onLayerAlphaChange(Math.min(1, Math.max(0.05, value)));
                      }
                    }}
                  />
                </label>
                <p className="small-note">
                  This controls the opacity of non-selected layers in the 3D stack view.
                </p>
                <div className="checkbox-list">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showPreviousLayer}
                      onChange={(event) => onShowPreviousLayerChange(event.target.checked)}
                    />
                    <span>Show previous layer ghost</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showTravelMoves}
                      onChange={(event) => onShowTravelMovesChange(event.target.checked)}
                    />
                    <span>Show travel moves</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showPoints}
                      onChange={(event) => onShowPointsChange(event.target.checked)}
                    />
                    <span>Show points</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={alwaysShowWavePaths}
                      onChange={(event) =>
                        onAlwaysShowWavePathsChange(event.target.checked)
                      }
                    />
                    <span>Always show wave paths</span>
                  </label>
                </div>
                <p className="small-note">
                  Keep generated wave paths visible in blue even after switching to a
                  different layer so the full part preview shows every resolved wave plan.
                </p>
              </div>
            </details>
            <button
              type="button"
              className="button button--primary"
              onClick={onGenerateOutputGcode}
              disabled={!canGenerateOutputGcode || isExporting}
            >
              {isExporting ? 'Generating output G-code...' : 'Generate the output G-code'}
            </button>
            {canGenerateOutputGcode ? (
              <p className="small-note">
                The export uses every layer that already has a generated wave-path preview.
              </p>
            ) : (
              <div className="message">
                Generate at least one wave-path preview before exporting.
              </div>
            )}
            {exportMessage ? (
              <div
                className={`message${
                  exportMessage.tone === 'warning' ? ' message--warning' : ''
                }`}
              >
                {exportMessage.text}
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <section className="panel__section">
          <div className="message">
            Upload a file or load the bundled demo to start exploring layers.
          </div>
        </section>
      )}
    </aside>
  );
}

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

interface FileDropZoneProps {
  onFileSelected: (file: File) => void;
  onLoadDemo: () => void;
  hasLoadedData?: boolean;
  isBusy?: boolean;
}

export function FileDropZone({
  onFileSelected,
  onLoadDemo,
  hasLoadedData = false,
  isBusy = false
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showDemoTip, setShowDemoTip] = useState(true);

  useEffect(() => {
    if (hasLoadedData) {
      setShowDemoTip(false);
    }
  }, [hasLoadedData]);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) {
      onFileSelected(file);
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <div
      className={`drop-zone${isDragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget === event.target) {
          setIsDragging(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={handleDrop}
    >
      <p className="drop-zone__title">Drop a `.gcode` file here</p>
      <p className="drop-zone__hint">
        The file stays in your browser. Nothing is uploaded anywhere.
      </p>
      {hasLoadedData ? (
        <p className="drop-zone__hint">
          Loading the demo will replace the currently displayed toolpath.
        </p>
      ) : null}
      <div className="drop-zone__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            setShowDemoTip(false);
            inputRef.current?.click();
          }}
          disabled={isBusy}
        >
          Choose file
        </button>
        <div className="drop-zone__demo-wrapper">
          {showDemoTip ? (
            <div className="demo-tip" role="note" aria-live="polite">
              <span>Try the demo sample first time</span>
              <button
                type="button"
                className="demo-tip__dismiss"
                aria-label="Dismiss demo sample tip"
                onClick={() => setShowDemoTip(false)}
              >
                x
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="button"
            onClick={() => {
              setShowDemoTip(false);
              onLoadDemo();
            }}
            disabled={isBusy}
          >
            {hasLoadedData ? 'Replace with demo sample' : 'Load demo sample'}
          </button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".gcode,.txt"
        hidden
        onChange={handleInputChange}
      />
    </div>
  );
}

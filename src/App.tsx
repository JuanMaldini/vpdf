import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type JSZip from "jszip";
import { detectFile, type DetectedFileType } from "./lib/fileType";
import "./App.css";

// Each viewer drags in a heavy, format-specific dependency (ts-pdf + pdf.js,
// pptx-preview + echarts, cfb). Loading them on demand keeps the initial
// bundle to the shell, so opening a PDF never costs the PPTX renderer and
// vice versa.
const PdfViewer = lazy(() => import("./viewers/PdfViewer"));
const PptxViewer = lazy(() => import("./viewers/PptxViewer"));
const OdpViewer = lazy(() => import("./viewers/OdpViewer"));
const LegacyPptViewer = lazy(() => import("./viewers/LegacyPptViewer"));

type ViewerKind = Extract<DetectedFileType, "pdf" | "pptx" | "odp" | "ppt-legacy">;

/** Everything a viewer needs, read from disk exactly once. Keeping the kind
 * and its payload in a single object makes the "viewer selected but no file"
 * state unrepresentable. */
interface ViewerSource {
  kind: ViewerKind;
  name: string;
  buffer: ArrayBuffer;
  zip?: JSZip;
}

const UNSUPPORTED_MESSAGE =
  "Formato no soportado. Se aceptan PDF, PPTX, PPT y ODP.";

const FILE_ACCEPT = [
  "application/pdf",
  ".pdf",
  ".pptx",
  ".ppt",
  ".odp",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
].join(",");

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<ViewerSource | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleViewerError = useCallback((message: string) => {
    setError(message);
    setSource(null);
  }, []);

  const openFile = useCallback(async (file: File) => {
    setError(null);
    setIsLoading(true);
    try {
      const detected = await detectFile(file);
      if (detected.kind === "unsupported" || !detected.buffer) {
        setError(UNSUPPORTED_MESSAGE);
        setSource(null);
        return;
      }
      setSource({
        kind: detected.kind,
        name: file.name,
        buffer: detected.buffer,
        zip: detected.zip,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? `No se pudo leer el archivo: ${err.message}`
          : "No se pudo leer el archivo.",
      );
      setSource(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Drag-and-drop is bound to the window rather than the dropzone element,
  // because the default browser action on a dropped file is to *navigate
  // away* to it, losing the app — and that has to be suppressed everywhere,
  // including over an open document where the dropzone no longer exists.
  //
  // Dropping only opens a file on the home screen. Once a document is
  // loaded, drops are swallowed (no overlay, no replace); "Abrir otro" is
  // the deliberate way to switch files.
  const dropEnabled = source === null;

  useEffect(() => {
    let dragDepth = 0;

    const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!dropEnabled || !carriesFiles(e)) return;
      dragDepth++;
      setIsDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = dropEnabled ? "copy" : "none";
    };
    const onDragLeave = () => {
      if (!dropEnabled) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth = 0;
      setIsDragging(false);
      if (!dropEnabled) return;
      const file = e.dataTransfer?.files?.[0];
      if (file) void openFile(file);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [openFile, dropEnabled]);

  useEffect(() => {
    if (!source) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSource(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [source]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void openFile(file);
    // Cleared so picking the same file twice in a row still fires onChange.
    e.target.value = "";
  };

  const pickFile = () => fileInputRef.current?.click();

  return (
    <div className="app">
      <Suspense fallback={<div className="status-overlay">Cargando visor…</div>}>
        {source?.kind === "pdf" && (
          <PdfViewer buffer={source.buffer} onError={handleViewerError} />
        )}
        {source?.kind === "pptx" && source.zip && (
          <PptxViewer
            buffer={source.buffer}
            zip={source.zip}
            onError={handleViewerError}
          />
        )}
        {source?.kind === "odp" && source.zip && (
          <OdpViewer zip={source.zip} onError={handleViewerError} />
        )}
        {source?.kind === "ppt-legacy" && (
          <LegacyPptViewer buffer={source.buffer} onError={handleViewerError} />
        )}
      </Suspense>

      {/* The whole panel is the control: no separate "choose a file" button,
          so the home screen is just the one large drop target. Clicking
          anywhere on it opens the (visually hidden) native file picker. */}
      <button
        type="button"
        className={`dropzone${source ? " hidden" : ""}${isDragging ? " dragging" : ""}`}
        onClick={pickFile}
      >
        <span className="dropzone-label">DROP FILE HERE</span>
        <span className="dropzone-hint">PDF · PPTX · PPT · ODP</span>
        {error && <span className="dropzone-error">{error}</span>}
      </button>

      {isLoading && <div className="status-overlay">Leyendo archivo…</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept={FILE_ACCEPT}
        onChange={handleFileInputChange}
        className="visually-hidden"
      />
    </div>
  );
}

export default App;

import { useEffect, useRef, useState } from "react";
import { TsPdfViewer } from "ts-pdf";
import "./App.css";

let containerInstanceCounter = 0;

function App() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<TsPdfViewer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hasFile, setHasFile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // ts-pdf looks up its container via document.querySelector(containerSelector)
    // and attaches a shadow root that destroy() can't fully tear down, so each
    // mount needs a brand-new DOM node with a never-reused id (relevant under
    // StrictMode's mount/unmount/mount cycle in development).
    const containerId = `pdf-viewer-container-${++containerInstanceCounter}`;
    const container = document.createElement("div");
    container.id = containerId;
    container.className = "pdf-container";
    wrapper.appendChild(container);

    const viewer = new TsPdfViewer({
      containerSelector: `#${containerId}`,
      workerSource: `${import.meta.env.BASE_URL}pdf.worker.min.mjs`,
      fileButtons: [],
      disabledModes: ["annotation", "comparison"],
    });
    viewerRef.current = viewer;

    return () => {
      viewer.destroy();
      wrapper.removeChild(container);
      viewerRef.current = null;
    };
  }, []);

  const openFile = async (file: File) => {
    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setError("El archivo seleccionado no es un PDF.");
      return;
    }

    try {
      setError(null);
      await viewerRef.current?.openPdfAsync(file);
      setHasFile(true);
    } catch {
      setError("No se pudo abrir el PDF.");
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void openFile(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void openFile(file);
    e.target.value = "";
  };

  return (
    <div className="app">
      <div ref={wrapperRef} className="pdf-container" />

      <div
        className={`dropzone${hasFile ? " hidden" : ""}${isDragging ? " dragging" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="dropzone-label">DROP PDF HERE</div>
        <button
          type="button"
          className="dropzone-button"
          onClick={() => fileInputRef.current?.click()}
        >
          Seleccionar archivo
        </button>
        {error && <div className="dropzone-error">{error}</div>}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={handleFileInputChange}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}

export default App;

import { useEffect, useRef, useState } from "react";
import { TsPdfViewer } from "ts-pdf";
import "./PdfViewer.css";

interface PdfViewerProps {
  buffer: ArrayBuffer;
  onError: (message: string) => void;
}

interface AnnotationNote {
  author: string;
  text: string;
}

let containerInstanceCounter = 0;

function PdfViewer({ buffer, onError }: PdfViewerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<AnnotationNote | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let cancelled = false;

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
      // Clicking an annotation (native PDF-viewer behavior) fires a "select"
      // event with that annotation's author/note text; clicking empty space
      // or another annotation fires it again, so this toggles automatically.
      annotChangeCallback: (detail) => {
        if (detail.type !== "select") return;
        const annotation = detail.annotations[0];
        if (annotation?.textContent) {
          setNote({
            author: annotation.author || "Anotación",
            text: annotation.textContent,
          });
        } else {
          setNote(null);
        }
      },
    });

    // ts-pdf sets pointer-events:none on every annotation icon unless the
    // (editing) "annotation" mode is active, which we deliberately disable
    // above to block creating/editing annotations. That also blocks reading
    // them, so we re-enable hit-testing on just the icons here, without
    // touching the mode (the editing toolbar/buttons stay fully disabled).
    const style = document.createElement("style");
    style.textContent = `
      .annotation-controls, .annotation-controls * {
        pointer-events: auto !important;
      }
      .annotation-controls {
        cursor: pointer;
      }
    `;
    container.shadowRoot?.appendChild(style);

    // Wrapped in a Blob rather than handed over as a Uint8Array: pdf.js
    // transfers the bytes it is given to its worker, detaching the buffer.
    // The effect re-runs against that same buffer under StrictMode, and a
    // detached one would throw on the second pass.
    viewer.openPdfAsync(new Blob([buffer], { type: "application/pdf" })).catch(() => {
      if (!cancelled) onError("No se pudo abrir el PDF.");
    });

    return () => {
      cancelled = true;
      viewer.destroy();
      wrapper.removeChild(container);
    };
  }, [buffer, onError]);

  return (
    <>
      <div ref={wrapperRef} className="pdf-container" />
      {note && (
        <div className="note-card">
          <button
            type="button"
            className="note-card-close"
            onClick={() => setNote(null)}
            aria-label="Cerrar nota"
          >
            ×
          </button>
          <div className="note-card-author">{note.author}</div>
          <div className="note-card-text">{note.text}</div>
        </div>
      )}
    </>
  );
}

export default PdfViewer;

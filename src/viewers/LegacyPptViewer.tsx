import { useEffect, useState } from "react";
import { extractLegacyPptText, readPowerPointStream } from "../lib/legacyPpt";
import "./LegacyPptViewer.css";

interface LegacyPptViewerProps {
  file: File;
  onError: (message: string) => void;
}

interface Extracted {
  slides: string[][];
  unassigned: string[];
}

function LegacyPptViewer({ file, onError }: LegacyPptViewerProps) {
  const [result, setResult] = useState<Extracted | null>(null);

  useEffect(() => {
    let cancelled = false;
    file
      .arrayBuffer()
      .then((buffer) => {
        const pptStream = readPowerPointStream(buffer);
        return extractLegacyPptText(pptStream);
      })
      .then((extracted) => {
        if (!cancelled) setResult(extracted);
      })
      .catch((err) => {
        if (!cancelled) {
          onError(
            err instanceof Error
              ? `No se pudo leer el .ppt: ${err.message}`
              : "No se pudo leer el .ppt.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file, onError]);

  if (!result) {
    return (
      <div className="legacy-ppt-viewer legacy-ppt-viewer-loading">
        Leyendo .ppt…
      </div>
    );
  }

  const slidesWithText = result.slides.filter((s) => s.length > 0);
  const hasNothing = slidesWithText.length === 0 && result.unassigned.length === 0;

  return (
    <div className="legacy-ppt-viewer">
      <div className="legacy-ppt-banner">
        Formato .ppt legado (PowerPoint 97-2003, contenedor binario OLE): solo
        se pudo extraer texto de forma best-effort. Im&aacute;genes, formas,
        tablas y el dise&ntilde;o original no est&aacute;n disponibles en este
        formato.
      </div>

      {hasNothing && (
        <div className="legacy-ppt-empty">
          No se pudo extraer texto legible de este archivo.
        </div>
      )}

      {slidesWithText.map((lines, i) => (
        <div key={i} className="legacy-ppt-slide">
          <div className="legacy-ppt-slide-header">Diapositiva {i + 1}</div>
          <div className="legacy-ppt-slide-body">
            {lines.map((line, j) => (
              <p key={j}>{line}</p>
            ))}
          </div>
        </div>
      ))}

      {result.unassigned.length > 0 && (
        <div className="legacy-ppt-slide legacy-ppt-slide-unassigned">
          <div className="legacy-ppt-slide-header">
            Texto adicional (sin diapositiva asignada)
          </div>
          <div className="legacy-ppt-slide-body">
            {result.unassigned.map((line, j) => (
              <p key={j}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default LegacyPptViewer;

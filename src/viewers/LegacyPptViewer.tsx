import { useEffect, useMemo } from "react";
import {
  extractLegacyPptText,
  readPowerPointStream,
  type LegacyPptResult,
} from "../lib/legacyPpt";
import "./LegacyPptViewer.css";

interface LegacyPptViewerProps {
  buffer: ArrayBuffer;
  onError: (message: string) => void;
}

type Parsed =
  | { ok: true; value: LegacyPptResult }
  | { ok: false; message: string };

function LegacyPptViewer({ buffer, onError }: LegacyPptViewerProps) {
  // The whole extraction is synchronous CPU work on a buffer we already hold,
  // so it is derived during render rather than round-tripped through state.
  const parsed = useMemo<Parsed>(() => {
    try {
      return { ok: true, value: extractLegacyPptText(readPowerPointStream(buffer)) };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? `No se pudo leer el .ppt: ${err.message}`
            : "No se pudo leer el .ppt.",
      };
    }
  }, [buffer]);

  useEffect(() => {
    if (!parsed.ok) onError(parsed.message);
  }, [parsed, onError]);

  if (!parsed.ok) return null;

  const result = parsed.value;
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

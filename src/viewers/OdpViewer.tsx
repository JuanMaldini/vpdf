import { useEffect, useState } from "react";
import { parseOdp, releaseOdpImageUrls, type ParsedOdp, type SlideElement } from "../lib/odf";
import "./OdpViewer.css";

interface OdpViewerProps {
  file: File;
  onError: (message: string) => void;
}

function SlideElementView({ element }: { element: SlideElement }) {
  switch (element.kind) {
    case "text":
      return (
        <div className="odp-element odp-element-text">
          {element.lines.map((line, i) => (
            <p key={i}>{line || " "}</p>
          ))}
        </div>
      );
    case "image":
      return element.src ? (
        <div className="odp-element odp-element-image">
          <img src={element.src} alt="" loading="lazy" />
        </div>
      ) : null;
    case "table":
      return (
        <div className="odp-element odp-element-table">
          <table>
            <tbody>
              {element.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "shape":
      return (
        <div className="odp-element odp-element-shape">
          <div className="odp-element-shape-label">{element.shapeType}</div>
          {element.lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      );
  }
}

function OdpViewer({ file, onError }: OdpViewerProps) {
  const [parsed, setParsed] = useState<ParsedOdp | null>(null);

  useEffect(() => {
    let cancelled = false;
    let result: ParsedOdp | null = null;

    parseOdp(file)
      .then((p) => {
        if (cancelled) {
          releaseOdpImageUrls(p);
          return;
        }
        result = p;
        setParsed(p);
      })
      .catch((err) => {
        onError(
          err instanceof Error
            ? `No se pudo leer el ODP: ${err.message}`
            : "No se pudo leer el ODP.",
        );
      });

    return () => {
      cancelled = true;
      if (result) releaseOdpImageUrls(result);
    };
  }, [file, onError]);

  if (!parsed) {
    return <div className="odp-viewer odp-viewer-loading">Leyendo diapositivas…</div>;
  }

  return (
    <div className="odp-viewer">
      <div className="odp-viewer-banner">
        Vista de solo lectura extraída del .odp: texto, imágenes, tablas y
        formas de cada diapositiva, en orden. El diseño original no se
        reproduce de forma exacta.
      </div>
      {parsed.slides.map((slide) => (
        <div key={slide.index} className="odp-slide">
          <div className="odp-slide-header">
            Diapositiva {slide.index + 1}
            {slide.name ? ` — ${slide.name}` : ""}
          </div>
          <div className="odp-slide-body">
            {slide.elements.length === 0 ? (
              <div className="odp-slide-empty">Sin contenido detectado.</div>
            ) : (
              slide.elements.map((element, i) => (
                <SlideElementView key={i} element={element} />
              ))
            )}
          </div>
          {slide.notes.length > 0 && (
            <div className="odp-slide-notes">
              <div className="odp-slide-notes-title">Notas del orador</div>
              {slide.notes.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default OdpViewer;

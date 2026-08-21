import { Fragment, useEffect, useState } from "react";
import { parseOdp, releaseOdpImageUrls, type Geometry, type ParsedOdp, type SlideElement } from "../lib/odf";
import "./OdpViewer.css";

interface OdpViewerProps {
  file: File;
  onError: (message: string) => void;
}

/** Percentages of the slide's own page size, so the element lands in the
 * same relative spot regardless of how big the slide canvas is rendered. */
function geometryStyle(geometry: Geometry | undefined, pageWidthCm: number, pageHeightCm: number) {
  if (!geometry) return undefined;
  return {
    position: "absolute" as const,
    left: `${(geometry.x / pageWidthCm) * 100}%`,
    top: `${(geometry.y / pageHeightCm) * 100}%`,
    width: `${(geometry.width / pageWidthCm) * 100}%`,
    height: `${(geometry.height / pageHeightCm) * 100}%`,
  };
}

function SlideElementView({
  element,
  pageWidthCm,
  pageHeightCm,
}: {
  element: SlideElement;
  pageWidthCm: number;
  pageHeightCm: number;
}) {
  const style = geometryStyle(element.geometry, pageWidthCm, pageHeightCm);

  switch (element.kind) {
    case "text":
    case "shape":
      if (element.lines.length === 0) return null;
      return (
        <div className="odp-element" style={style}>
          {element.lines.map((line, i) => (
            <p key={i}>{line || " "}</p>
          ))}
        </div>
      );
    case "image":
      return element.src ? (
        <div className="odp-element" style={style}>
          <img src={element.src} alt="" loading="lazy" />
        </div>
      ) : null;
    case "table":
      return (
        <div className="odp-element" style={style}>
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
      {parsed.slides.map((slide) => (
        <Fragment key={slide.index}>
          <div
            className="odp-slide"
            style={{ aspectRatio: `${slide.pageWidthCm} / ${slide.pageHeightCm}` }}
          >
            {slide.elements.map((element, i) => (
              <SlideElementView
                key={i}
                element={element}
                pageWidthCm={slide.pageWidthCm}
                pageHeightCm={slide.pageHeightCm}
              />
            ))}
          </div>
          {slide.notes.length > 0 && (
            <div className="odp-notes">
              {slide.notes.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

export default OdpViewer;

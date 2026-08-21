import { Fragment, useEffect, useState, type CSSProperties } from "react";
import type JSZip from "jszip";
import {
  parseOdp,
  releaseOdpImageUrls,
  type Geometry,
  type GraphicStyle,
  type ParsedOdp,
  type RichParagraph,
  type SlideElement,
  type TextStyle,
} from "../lib/odf";
import { CM_PER_PT } from "../lib/odfXml";
import "./OdpViewer.css";

interface OdpViewerProps {
  zip: JSZip;
  onError: (message: string) => void;
}

/** ODF sizes are absolute (cm/pt) but the slide is drawn at whatever width
 * fits the window, so every length is converted to `cqw` — a percentage of
 * the slide container's width. One conversion point means text, padding and
 * borders all stay in proportion at any zoom, and replaces the previous
 * fixed `font-size: 1.1cqw` guess that ignored the document entirely. */
function cmToCqw(cm: number, pageWidthCm: number): string {
  return `${((cm / pageWidthCm) * 100).toFixed(4)}cqw`;
}

function ptToCqw(pt: number, pageWidthCm: number): string {
  return cmToCqw(pt * CM_PER_PT, pageWidthCm);
}

/** Impress's default body size; used when nothing in the style chain
 * declares one, so text is never left at the browser's 16px default. */
const DEFAULT_FONT_SIZE_PT = 18;

function spanStyle(style: TextStyle, pageWidthCm: number): CSSProperties {
  const decorations = [
    style.underline ? "underline" : "",
    style.strike ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    color: style.color,
    fontFamily: style.fontFamily
      ? `${JSON.stringify(style.fontFamily)}, sans-serif`
      : undefined,
    fontSize:
      style.fontSizePt !== undefined
        ? ptToCqw(style.fontSizePt, pageWidthCm)
        : undefined,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: decorations || undefined,
  };
}

function paragraphStyle(
  paragraph: RichParagraph,
  pageWidthCm: number,
): CSSProperties {
  // The line box is driven by the largest run the paragraph actually
  // contains, not by the paragraph style's nominal size. ODF routinely
  // declares an 18pt paragraph whose only span is 12pt; taking the nominal
  // size would reserve a 0.79cm line inside a 0.76cm shape and push the
  // text out of its box.
  const largestSpanPt = paragraph.spans.reduce<number | undefined>(
    (max, span) =>
      span.style.fontSizePt !== undefined && (max === undefined || span.style.fontSizePt > max)
        ? span.style.fontSizePt
        : max,
    undefined,
  );

  return {
    fontSize:
      largestSpanPt !== undefined ? ptToCqw(largestSpanPt, pageWidthCm) : undefined,
    textAlign: paragraph.style.textAlign,
    marginTop:
      paragraph.style.marginTopCm !== undefined
        ? cmToCqw(paragraph.style.marginTopCm, pageWidthCm)
        : undefined,
    marginBottom:
      paragraph.style.marginBottomCm !== undefined
        ? cmToCqw(paragraph.style.marginBottomCm, pageWidthCm)
        : undefined,
    lineHeight: paragraph.style.lineHeight,
    paddingLeft:
      paragraph.level > 0
        ? cmToCqw(paragraph.level * 0.6, pageWidthCm)
        : undefined,
  };
}

const VERTICAL_ALIGN_TO_JUSTIFY = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
} as const;

/** Percentages of the slide's own page size, so the element lands in the
 * same relative spot regardless of how big the slide canvas is rendered. */
function elementStyle(
  geometry: Geometry | undefined,
  graphic: GraphicStyle | undefined,
  pageWidthCm: number,
  pageHeightCm: number,
): CSSProperties {
  const style: CSSProperties = {};

  if (geometry) {
    style.position = "absolute";
    style.left = `${(geometry.x / pageWidthCm) * 100}%`;
    style.top = `${(geometry.y / pageHeightCm) * 100}%`;
    style.width = `${(geometry.width / pageWidthCm) * 100}%`;
    style.height = `${(geometry.height / pageHeightCm) * 100}%`;
  }

  // Base size for any run whose style chain declares none. It belongs here
  // rather than on .odp-slide: a container query unit used on the container
  // itself can't resolve against that container (it would be circular), so
  // cqw there silently fell back to the viewport and came out double size.
  style.fontSize = ptToCqw(DEFAULT_FONT_SIZE_PT, pageWidthCm);

  if (!graphic) return style;

  style.background = graphic.fillColor;
  if (graphic.strokeColor) {
    style.border = `${cmToCqw(graphic.strokeWidthCm ?? 0.026, pageWidthCm)} solid ${graphic.strokeColor}`;
    style.boxSizing = "border-box";
  }
  style.justifyContent = graphic.verticalAlign
    ? VERTICAL_ALIGN_TO_JUSTIFY[graphic.verticalAlign]
    : undefined;
  if (graphic.horizontalAlign) {
    style.textAlign = graphic.horizontalAlign;
  }

  // Impress treats fo:padding as a hint and drops it when the shape is too
  // small to honour it; the box size wins. Applying it unconditionally
  // collapsed the content area of small shapes — the numbered callout boxes
  // in a review deck are ~0.8-1.0cm wide with 0.25cm of declared padding per
  // side, which left too little room for a two-digit number and wrapped it
  // onto a second line. These shapes were auto-sized by the producing app
  // against its own font metrics; with a substitute font the text needs more
  // room, so padding is only honoured when it costs under a third of the box.
  const fits = (a = 0, b = 0, extent?: number) =>
    extent === undefined || a + b < extent / 3;

  if (fits(graphic.paddingLeftCm, graphic.paddingRightCm, geometry?.width)) {
    if (graphic.paddingLeftCm !== undefined) {
      style.paddingLeft = cmToCqw(graphic.paddingLeftCm, pageWidthCm);
    }
    if (graphic.paddingRightCm !== undefined) {
      style.paddingRight = cmToCqw(graphic.paddingRightCm, pageWidthCm);
    }
  }
  if (fits(graphic.paddingTopCm, graphic.paddingBottomCm, geometry?.height)) {
    if (graphic.paddingTopCm !== undefined) {
      style.paddingTop = cmToCqw(graphic.paddingTopCm, pageWidthCm);
    }
    if (graphic.paddingBottomCm !== undefined) {
      style.paddingBottom = cmToCqw(graphic.paddingBottomCm, pageWidthCm);
    }
  }
  return style;
}

function Paragraphs({
  paragraphs,
  pageWidthCm,
}: {
  paragraphs: RichParagraph[];
  pageWidthCm: number;
}) {
  return (
    <>
      {paragraphs.map((paragraph, i) => (
        <p key={i} style={paragraphStyle(paragraph, pageWidthCm)}>
          {paragraph.bullet && (
            <span className="odp-bullet">{paragraph.bullet} </span>
          )}
          {paragraph.spans.length === 0
            ? " "
            : paragraph.spans.map((span, j) => (
                <span key={j} style={spanStyle(span.style, pageWidthCm)}>
                  {span.text}
                </span>
              ))}
        </p>
      ))}
    </>
  );
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
  switch (element.kind) {
    case "line":
      // Drawn in an SVG spanning the whole slide with a viewBox in page
      // centimetres, so the endpoints go in as-is and any angle is exact.
      return (
        <svg
          className="odp-line"
          viewBox={`0 0 ${pageWidthCm} ${pageHeightCm}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1={element.x1}
            y1={element.y1}
            x2={element.x2}
            y2={element.y2}
            stroke={element.graphic.strokeColor ?? "#000000"}
            // In viewBox centimetres. The SVG's box has the slide's exact
            // aspect ratio, so preserveAspectRatio="none" scales uniformly
            // and the stroke stays proportional at any rendered size.
            strokeWidth={element.graphic.strokeWidthCm ?? 0.026}
          />
        </svg>
      );
    case "text":
    case "shape": {
      const style = elementStyle(
        element.geometry,
        element.graphic,
        pageWidthCm,
        pageHeightCm,
      );
      // A shape with no text is still drawn: its fill and stroke are what
      // the slide is showing (arrows, rules, callout boxes).
      return (
        <div className="odp-element" style={style}>
          <Paragraphs paragraphs={element.paragraphs} pageWidthCm={pageWidthCm} />
        </div>
      );
    }
    case "image":
      return element.src ? (
        <div
          className="odp-element"
          style={elementStyle(element.geometry, undefined, pageWidthCm, pageHeightCm)}
        >
          <img src={element.src} alt="" loading="lazy" />
        </div>
      ) : null;
    case "table":
      return (
        <div
          className="odp-element"
          style={elementStyle(
            element.geometry,
            element.graphic,
            pageWidthCm,
            pageHeightCm,
          )}
        >
          <table>
            <tbody>
              {element.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <Paragraphs paragraphs={cell} pageWidthCm={pageWidthCm} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function OdpViewer({ zip, onError }: OdpViewerProps) {
  const [parsed, setParsed] = useState<ParsedOdp | null>(null);

  useEffect(() => {
    let cancelled = false;
    let result: ParsedOdp | null = null;

    parseOdp(zip)
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
  }, [zip, onError]);

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
              <Paragraphs paragraphs={slide.notes} pageWidthCm={slide.pageWidthCm} />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

export default OdpViewer;

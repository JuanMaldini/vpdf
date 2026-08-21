import type JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import {
  attrsOf,
  childrenOf,
  findDirect,
  findAllDeep,
  parseLengthCm,
  tagOf,
  type PNode,
} from "./odfXml";
import {
  buildStyleIndex,
  parsePageLayouts,
  type GraphicStyle,
  type ParagraphStyle,
  type StyleIndex,
  type TextStyle,
} from "./odfStyles";

export type { GraphicStyle, ParagraphStyle, TextStyle } from "./odfStyles";

export interface Geometry {
  /** All in cm, in the slide's own page coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A run of characters sharing one character style. */
export interface RichSpan {
  text: string;
  style: TextStyle;
}

export interface RichParagraph {
  spans: RichSpan[];
  style: ParagraphStyle;
  /** Bullet prefix and nesting level for text:list items. */
  bullet?: string;
  level: number;
}

export interface TextElement {
  kind: "text";
  paragraphs: RichParagraph[];
  geometry?: Geometry;
  graphic: GraphicStyle;
}

export interface ImageElement {
  kind: "image";
  /** Package-relative path, when the image lives as its own zip entry. */
  href?: string;
  /** Inline base64 payload, when the image is embedded in the XML instead. */
  binaryData?: string;
  /** Object URL, resolved by parseOdp; revoke via releaseOdpImageUrls. */
  src?: string;
  geometry?: Geometry;
}

export interface TableElement {
  kind: "table";
  rows: RichParagraph[][][];
  geometry?: Geometry;
  graphic: GraphicStyle;
}

export interface ShapeElement {
  kind: "shape";
  paragraphs: RichParagraph[];
  geometry?: Geometry;
  graphic: GraphicStyle;
}

/** draw:line and draw:connector position themselves with endpoints rather
 * than a box, so they get their own element type instead of being forced
 * into a Geometry they don't have. All values in cm, page coordinates. */
export interface LineElement {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  graphic: GraphicStyle;
}

export type SlideElement =
  | TextElement
  | ImageElement
  | TableElement
  | ShapeElement
  | LineElement;

export interface ParsedSlide {
  index: number;
  name?: string;
  pageWidthCm: number;
  pageHeightCm: number;
  elements: SlideElement[];
  notes: RichParagraph[];
}

const DRAWABLE_SHAPE_TAGS = new Set([
  "draw:custom-shape",
  "draw:rect",
  "draw:ellipse",
  "draw:circle",
  "draw:line",
  "draw:polygon",
  "draw:polyline",
  "draw:connector",
  "draw:path",
]);

// Fallback to the standard 16:9 Impress page size if a slide's master-page
// can't be resolved (better than an arbitrary/undersized canvas).
const DEFAULT_PAGE_WIDTH_CM = 33.867;
const DEFAULT_PAGE_HEIGHT_CM = 19.05;

/** Flattens a paragraph's inline content into styled spans, in document
 * order. Nested text:span elements each narrow the style further, so the
 * caller's style is threaded down and merged rather than replaced. */
function collectSpans(
  nodes: PNode[],
  styles: StyleIndex,
  inherited: TextStyle,
  out: RichSpan[] = [],
): RichSpan[] {
  const push = (text: string, style: TextStyle) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Merge adjacent runs that resolved to the same formatting, so a
    // paragraph split across a dozen identical spans stays one DOM node.
    if (last && last.style === style) last.text += text;
    else out.push({ text, style });
  };

  for (const node of nodes) {
    if ("#text" in node) {
      push(String(node["#text"]), inherited);
      continue;
    }
    const tag = tagOf(node);
    if (!tag) continue;

    if (tag === "text:line-break") {
      push("\n", inherited);
    } else if (tag === "text:tab") {
      push("\t", inherited);
    } else if (tag === "text:s") {
      const count = Number(attrsOf(node)["@_text:c"] ?? 1);
      push(" ".repeat(Math.max(1, count)), inherited);
    } else if (tag === "text:span") {
      const own = styles.text(attrsOf(node)["@_text:style-name"]);
      collectSpans(childrenOf(node), styles, { ...inherited, ...own }, out);
    } else {
      collectSpans(childrenOf(node), styles, inherited, out);
    }
  }
  return out;
}

interface ParagraphContext {
  /** Style applied to paragraphs that declare none of their own, from the
   * frame's draw:text-style-name. */
  defaultParagraphStyle?: string;
  level: number;
  bullet?: string;
}

function paragraphsToRich(
  nodes: PNode[],
  styles: StyleIndex,
  context: ParagraphContext,
): RichParagraph[] {
  const paragraphs: RichParagraph[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);

    if (tag === "text:p" || tag === "text:h") {
      const styleName =
        attrsOf(node)["@_text:style-name"] ?? context.defaultParagraphStyle;
      paragraphs.push({
        spans: collectSpans(childrenOf(node), styles, styles.text(styleName)),
        style: styles.paragraph(styleName),
        bullet: context.bullet,
        level: context.level,
      });
    } else if (tag === "text:list") {
      for (const item of findDirect(childrenOf(node), "text:list-item")) {
        paragraphs.push(
          ...paragraphsToRich(childrenOf(item), styles, {
            ...context,
            level: context.level + 1,
            bullet: "•",
          }),
        );
      }
    }
  }
  return paragraphs;
}

function hasText(paragraphs: RichParagraph[]): boolean {
  return paragraphs.some((p) => p.spans.some((s) => s.text.trim().length > 0));
}

function extractGeometry(attrs: Record<string, string>): Geometry | undefined {
  const x = parseLengthCm(attrs["@_svg:x"]);
  const y = parseLengthCm(attrs["@_svg:y"]);
  const width = parseLengthCm(attrs["@_svg:width"]);
  const height = parseLengthCm(attrs["@_svg:height"]);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function extractTable(
  tableNode: PNode,
  styles: StyleIndex,
  graphic: GraphicStyle,
  geometry?: Geometry,
): TableElement {
  const rows: RichParagraph[][][] = [];
  for (const row of findDirect(childrenOf(tableNode), "table:table-row")) {
    const cells: RichParagraph[][] = [];
    for (const cell of findDirect(childrenOf(row), "table:table-cell")) {
      cells.push(paragraphsToRich(childrenOf(cell), styles, { level: 0 }));
    }
    rows.push(cells);
  }
  return { kind: "table", rows, geometry, graphic };
}

/** Extracts whatever a draw:frame (or a bare shape) actually contains, so
 * nothing inside it is silently dropped. Position/size and the resolved
 * fill/border/font styling are both carried through, so the slide's
 * composition and its look are preserved. */
function extractDrawableElement(node: PNode, styles: StyleIndex): SlideElement | null {
  const tag = tagOf(node);
  if (!tag) return null;
  const attrs = attrsOf(node);
  const children = childrenOf(node);
  const geometry = extractGeometry(attrs);
  const graphic = styles.graphic(
    attrs["@_draw:style-name"] ?? attrs["@_presentation:style-name"],
  );
  const context: ParagraphContext = {
    defaultParagraphStyle: attrs["@_draw:text-style-name"],
    level: 0,
  };

  if (tag === "draw:line" || tag === "draw:connector") {
    const x1 = parseLengthCm(attrs["@_svg:x1"]);
    const y1 = parseLengthCm(attrs["@_svg:y1"]);
    const x2 = parseLengthCm(attrs["@_svg:x2"]);
    const y2 = parseLengthCm(attrs["@_svg:y2"]);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      return { kind: "line", x1, y1, x2, y2, graphic };
    }
    return null;
  }

  // Everything below is positioned by its box. Without one there is nothing
  // sensible to place, and emitting it anyway made it a full-width block in
  // normal flow that sat across the middle of the slide.
  if (!geometry) return null;

  const image = findDirect(children, "draw:image")[0];
  if (image) {
    const href = attrsOf(image)["@_xlink:href"];
    if (href) return { kind: "image", href, geometry };
    // An image with no xlink:href carries its bytes inline as base64 instead
    // (LibreOffice writes this form for freshly pasted, not-yet-saved images).
    const binary = findDirect(childrenOf(image), "office:binary-data")[0];
    const binaryData = binary
      ? collectSpans(childrenOf(binary), styles, {})
          .map((s) => s.text)
          .join("")
          .trim()
      : "";
    return binaryData ? { kind: "image", binaryData, geometry } : null;
  }

  const table = findDirect(children, "table:table")[0];
  if (table) return extractTable(table, styles, graphic, geometry);

  const textBox = findDirect(children, "draw:text-box")[0];
  const textContainer = textBox ? childrenOf(textBox) : children;
  const paragraphs = paragraphsToRich(textContainer, styles, context);

  if (tag === "draw:frame") {
    return hasText(paragraphs)
      ? { kind: "text", paragraphs, geometry, graphic }
      : null;
  }

  // A bare shape is kept even with no text: its fill/stroke is the content.
  return { kind: "shape", paragraphs, geometry, graphic };
}

function extractSlideElements(pageChildren: PNode[], styles: StyleIndex): SlideElement[] {
  const elements: SlideElement[] = [];
  for (const child of pageChildren) {
    const tag = tagOf(child);
    if (!tag) continue;

    if (tag === "presentation:notes") continue;

    if (tag === "draw:g") {
      // ODF keeps child shapes in absolute page coordinates even inside a
      // group, so flattening the group (rather than reproducing its
      // transform) still preserves each child's on-slide position.
      elements.push(...extractSlideElements(childrenOf(child), styles));
      continue;
    }

    if (tag === "table:table") {
      const attrs = attrsOf(child);
      elements.push(
        extractTable(
          child,
          styles,
          styles.graphic(attrs["@_draw:style-name"]),
          extractGeometry(attrs),
        ),
      );
      continue;
    }

    if (tag === "draw:frame" || DRAWABLE_SHAPE_TAGS.has(tag)) {
      const el = extractDrawableElement(child, styles);
      if (el) elements.push(el);
    }
  }
  return elements;
}

function extractNotes(pageChildren: PNode[], styles: StyleIndex): RichParagraph[] {
  const notesNode = findDirect(pageChildren, "presentation:notes")[0];
  if (!notesNode) return [];
  const paragraphs: RichParagraph[] = [];
  for (const frame of findAllDeep(childrenOf(notesNode), "draw:frame")) {
    const el = extractDrawableElement(frame, styles);
    if (el?.kind === "text") paragraphs.push(...el.paragraphs);
  }
  return paragraphs.filter((p) => p.spans.some((s) => s.text.trim().length > 0));
}

export interface ParsedOdp {
  slides: ParsedSlide[];
}

/** xlink:href values are package-relative URIs, so they can be percent-encoded
 * and/or "./"-prefixed while the zip entry name is neither. Trying the
 * plausible spellings is cheaper (and more forgiving of the several producing
 * apps) than assuming one canonical form. */
function findImageEntry(zip: JSZip, href: string) {
  const candidates = [href, href.replace(/^\.\//, "")];
  try {
    const decoded = decodeURIComponent(href);
    candidates.push(decoded, decoded.replace(/^\.\//, ""));
  } catch {
    // Malformed percent-escapes: the raw spellings above are all we have.
  }
  for (const candidate of candidates) {
    const entry = zip.file(candidate);
    if (entry) return entry;
  }
  return null;
}

/** Resolves every image reference to an object URL, in parallel — an
 * image-heavy deck holds dozens of entries and inflating them one awaited
 * blob at a time dominates the total parse time. */
async function resolveImages(zip: JSZip, slides: ParsedSlide[]) {
  const images = slides
    .flatMap((slide) => slide.elements)
    .filter((el): el is ImageElement => el.kind === "image");

  await Promise.all(
    images.map(async (element) => {
      if (element.binaryData) {
        const response = await fetch(`data:;base64,${element.binaryData}`);
        element.src = URL.createObjectURL(await response.blob());
        return;
      }
      const entry = element.href ? findImageEntry(zip, element.href) : null;
      if (entry) element.src = URL.createObjectURL(await entry.async("blob"));
    }),
  );
}

export async function parseOdp(zip: JSZip): Promise<ParsedOdp> {
  const contentXml = await zip.file("content.xml")?.async("string");
  if (!contentXml) {
    throw new Error("El archivo .odp no contiene content.xml");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
  });
  const root = parser.parse(contentXml) as PNode[];

  const stylesXml = await zip.file("styles.xml")?.async("string");
  const stylesRoot = stylesXml ? (parser.parse(stylesXml) as PNode[]) : [];

  const styles = buildStyleIndex(root, stylesRoot);
  const pageLayoutByMasterPage = parsePageLayouts(stylesRoot);

  const pages = findAllDeep(root, "draw:page");
  const slides: ParsedSlide[] = pages.map((page, index) => {
    const children = childrenOf(page);
    const masterPageName = attrsOf(page)["@_draw:master-page-name"];
    const layout = masterPageName ? pageLayoutByMasterPage.get(masterPageName) : undefined;
    return {
      index,
      name: attrsOf(page)["@_draw:name"],
      pageWidthCm: layout?.widthCm ?? DEFAULT_PAGE_WIDTH_CM,
      pageHeightCm: layout?.heightCm ?? DEFAULT_PAGE_HEIGHT_CM,
      elements: extractSlideElements(children, styles),
      notes: extractNotes(children, styles),
    };
  });

  const parsed: ParsedOdp = { slides };
  try {
    // Revoking these object URLs is the caller's responsibility on success
    // (see releaseOdpImageUrls); on failure we must not leak the ones that
    // were already created before the error.
    await resolveImages(zip, slides);
  } catch (err) {
    releaseOdpImageUrls(parsed);
    throw err;
  }

  return parsed;
}

export function releaseOdpImageUrls(parsed: ParsedOdp) {
  for (const slide of parsed.slides) {
    for (const element of slide.elements) {
      if (element.kind === "image" && element.src) {
        URL.revokeObjectURL(element.src);
      }
    }
  }
}

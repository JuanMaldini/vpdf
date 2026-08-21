import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

// fast-xml-parser's preserveOrder output: each node is an object with a
// single tag-name key (its children array) plus an optional ":@" key
// holding that tag's attributes. Using preserveOrder (instead of the
// default collapsed object tree) keeps text runs, line breaks and nested
// shapes in document order, which paragraph/table extraction needs.
type PNode = Record<string, unknown>;

export interface Geometry {
  /** All in cm, in the slide's own page coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextElement {
  kind: "text";
  lines: string[];
  geometry?: Geometry;
}

export interface ImageElement {
  kind: "image";
  href: string;
  src?: string;
  geometry?: Geometry;
}

export interface TableElement {
  kind: "table";
  rows: string[][];
  geometry?: Geometry;
}

export interface ShapeElement {
  kind: "shape";
  lines: string[];
  geometry?: Geometry;
}

export type SlideElement = TextElement | ImageElement | TableElement | ShapeElement;

export interface ParsedSlide {
  index: number;
  name?: string;
  pageWidthCm: number;
  pageHeightCm: number;
  elements: SlideElement[];
  notes: string[];
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

function tagOf(node: PNode): string | undefined {
  return Object.keys(node).find((k) => k !== ":@");
}

function childrenOf(node: PNode): PNode[] {
  // "#text" nodes hold a raw string value (not a children array) under
  // that key, so they must be excluded before indexing into the tag key.
  if ("#text" in node) return [];
  const t = tagOf(node);
  return t ? ((node[t] as PNode[]) ?? []) : [];
}

function attrsOf(node: PNode): Record<string, string> {
  return (node[":@"] as Record<string, string>) ?? {};
}

function findDirect(nodes: PNode[], tag: string): PNode[] {
  return nodes.filter((n) => tagOf(n) === tag);
}

function findAllDeep(nodes: PNode[], tag: string): PNode[] {
  const out: PNode[] = [];
  for (const n of nodes) {
    const t = tagOf(n);
    if (t === tag) out.push(n);
    if (t) out.push(...findAllDeep(childrenOf(n), tag));
  }
  return out;
}

function collectText(nodes: PNode[]): string {
  let out = "";
  for (const n of nodes) {
    if ("#text" in n) {
      out += String(n["#text"]);
      continue;
    }
    const t = tagOf(n);
    if (!t) continue;
    if (t === "text:line-break") {
      out += "\n";
    } else if (t === "text:tab") {
      out += "\t";
    } else if (t === "text:s") {
      const count = Number(attrsOf(n)["@_text:c"] ?? 1);
      out += " ".repeat(Math.max(1, count));
    } else {
      out += collectText(childrenOf(n));
    }
  }
  return out;
}

function paragraphsToLines(nodes: PNode[], indent = ""): string[] {
  const lines: string[] = [];
  for (const n of nodes) {
    const t = tagOf(n);
    if (t === "text:p") {
      lines.push(indent + collectText(childrenOf(n)));
    } else if (t === "text:list") {
      for (const item of findDirect(childrenOf(n), "text:list-item")) {
        lines.push(...paragraphsToLines(childrenOf(item), `${indent}• `));
      }
    }
  }
  return lines;
}

/** ODF length attributes (svg:x, svg:width, ...) carry a unit suffix;
 * normalizing everything to cm lets element and page geometry be compared
 * directly regardless of which unit the producing app used. */
function parseLengthCm(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?$/);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  switch (match[2]) {
    case "mm":
      return num / 10;
    case "in":
      return num * 2.54;
    case "pt":
      return (num / 72) * 2.54;
    case "pc":
      return (num / 6) * 2.54;
    case "px":
      return (num / 96) * 2.54;
    default:
      return num;
  }
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

function extractTable(tableNode: PNode, geometry?: Geometry): TableElement {
  const rows: string[][] = [];
  for (const row of findDirect(childrenOf(tableNode), "table:table-row")) {
    const cells: string[] = [];
    for (const cell of findDirect(childrenOf(row), "table:table-cell")) {
      cells.push(paragraphsToLines(childrenOf(cell)).join("\n"));
    }
    rows.push(cells);
  }
  return { kind: "table", rows, geometry };
}

/** Extracts whatever a draw:frame (or a bare shape) actually contains, so
 * nothing inside it is silently dropped even though fill/border/font
 * styling isn't reproduced. Position/size (from the frame or shape's own
 * svg:x/y/width/height) IS carried through, so the overall composition of
 * the slide is preserved. */
function extractDrawableElement(node: PNode): SlideElement | null {
  const tag = tagOf(node);
  if (!tag) return null;
  const children = childrenOf(node);
  const geometry = extractGeometry(attrsOf(node));

  const image = findDirect(children, "draw:image")[0];
  if (image) {
    const href = attrsOf(image)["@_xlink:href"];
    return href ? { kind: "image", href, geometry } : null;
  }

  const table = findDirect(children, "table:table")[0];
  if (table) return extractTable(table, geometry);

  const textBox = findDirect(children, "draw:text-box")[0];
  const textContainer = textBox ? childrenOf(textBox) : children;
  const lines = paragraphsToLines(textContainer);

  if (tag === "draw:frame") {
    return lines.length ? { kind: "text", lines, geometry } : null;
  }

  return { kind: "shape", lines, geometry };
}

function extractSlideElements(pageChildren: PNode[]): SlideElement[] {
  const elements: SlideElement[] = [];
  for (const child of pageChildren) {
    const tag = tagOf(child);
    if (!tag) continue;

    if (tag === "presentation:notes") continue;

    if (tag === "draw:g") {
      // ODF keeps child shapes in absolute page coordinates even inside a
      // group, so flattening the group (rather than reproducing its
      // transform) still preserves each child's on-slide position.
      elements.push(...extractSlideElements(childrenOf(child)));
      continue;
    }

    if (tag === "table:table") {
      elements.push(extractTable(child, extractGeometry(attrsOf(child))));
      continue;
    }

    if (tag === "draw:frame" || DRAWABLE_SHAPE_TAGS.has(tag)) {
      const el = extractDrawableElement(child);
      if (el) elements.push(el);
    }
  }
  return elements;
}

function extractNotes(pageChildren: PNode[]): string[] {
  const notesNode = findDirect(pageChildren, "presentation:notes")[0];
  if (!notesNode) return [];
  const lines: string[] = [];
  for (const frame of findAllDeep(childrenOf(notesNode), "draw:frame")) {
    const el = extractDrawableElement(frame);
    if (el?.kind === "text") lines.push(...el.lines);
  }
  return lines.filter((l) => l.trim().length > 0);
}

interface PageLayout {
  widthCm: number;
  heightCm: number;
}

/** Resolves each master-page's actual on-screen size (styles.xml commonly
 * defines a leftover print-oriented page-layout alongside the real
 * presentation one — the master-page → page-layout-name chain is what
 * actually governs a given slide, not just "the first page-layout"). */
function parsePageLayouts(stylesXml: string, parser: XMLParser): Map<string, PageLayout> {
  const root = parser.parse(stylesXml) as PNode[];
  const layoutsByName = new Map<string, PageLayout>();
  for (const layout of findAllDeep(root, "style:page-layout")) {
    const name = attrsOf(layout)["@_style:name"];
    const props = findDirect(childrenOf(layout), "style:page-layout-properties")[0];
    if (!name || !props) continue;
    const widthCm = parseLengthCm(attrsOf(props)["@_fo:page-width"]);
    const heightCm = parseLengthCm(attrsOf(props)["@_fo:page-height"]);
    if (widthCm && heightCm) layoutsByName.set(name, { widthCm, heightCm });
  }

  const pageLayoutByMasterPage = new Map<string, PageLayout>();
  for (const masterPage of findAllDeep(root, "style:master-page")) {
    const masterName = attrsOf(masterPage)["@_style:name"];
    const layoutName = attrsOf(masterPage)["@_style:page-layout-name"];
    const layout = layoutName ? layoutsByName.get(layoutName) : undefined;
    if (masterName && layout) pageLayoutByMasterPage.set(masterName, layout);
  }
  return pageLayoutByMasterPage;
}

export interface ParsedOdp {
  slides: ParsedSlide[];
}

export async function parseOdp(file: File): Promise<ParsedOdp> {
  const zip = await JSZip.loadAsync(file);
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
  const pageLayoutByMasterPage = stylesXml
    ? parsePageLayouts(stylesXml, parser)
    : new Map<string, PageLayout>();

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
      elements: extractSlideElements(children),
      notes: extractNotes(children),
    };
  });

  // Resolve every image reference to a usable object URL. Revoking these is
  // the caller's responsibility (see releaseOdpImageUrls).
  for (const slide of slides) {
    for (const element of slide.elements) {
      if (element.kind === "image") {
        const entry = zip.file(element.href);
        if (entry) {
          const blob = await entry.async("blob");
          element.src = URL.createObjectURL(blob);
        }
      }
    }
  }

  return { slides };
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

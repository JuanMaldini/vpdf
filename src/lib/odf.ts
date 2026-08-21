import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

// fast-xml-parser's preserveOrder output: each node is an object with a
// single tag-name key (its children array) plus an optional ":@" key
// holding that tag's attributes. Using preserveOrder (instead of the
// default collapsed object tree) keeps text runs, line breaks and nested
// shapes in document order, which plain paragraph/table extraction needs.
type PNode = Record<string, unknown>;

const SHAPE_LABELS: Record<string, string> = {
  "draw:custom-shape": "Forma",
  "draw:rect": "Rectángulo",
  "draw:ellipse": "Elipse",
  "draw:circle": "Círculo",
  "draw:line": "Línea",
  "draw:polygon": "Polígono",
  "draw:polyline": "Polilínea",
  "draw:connector": "Conector",
  "draw:path": "Trazo",
};

export interface TextElement {
  kind: "text";
  lines: string[];
}

export interface ImageElement {
  kind: "image";
  href: string;
  src?: string;
}

export interface TableElement {
  kind: "table";
  rows: string[][];
}

export interface ShapeElement {
  kind: "shape";
  shapeType: string;
  lines: string[];
}

export type SlideElement = TextElement | ImageElement | TableElement | ShapeElement;

export interface ParsedSlide {
  index: number;
  name?: string;
  elements: SlideElement[];
  notes: string[];
}

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

function extractTable(tableNode: PNode): TableElement {
  const rows: string[][] = [];
  for (const row of findDirect(childrenOf(tableNode), "table:table-row")) {
    const cells: string[] = [];
    for (const cell of findDirect(childrenOf(row), "table:table-cell")) {
      cells.push(paragraphsToLines(childrenOf(cell)).join("\n"));
    }
    rows.push(cells);
  }
  return { kind: "table", rows };
}

/** Extracts whatever a draw:frame (or a bare shape) actually contains, so
 * nothing inside it is silently dropped even when the layout can't be
 * reproduced pixel-for-pixel. */
function extractDrawableElement(node: PNode): SlideElement | null {
  const tag = tagOf(node);
  if (!tag) return null;
  const children = childrenOf(node);

  const image = findDirect(children, "draw:image")[0];
  if (image) {
    const href = attrsOf(image)["@_xlink:href"];
    return href ? { kind: "image", href } : null;
  }

  const table = findDirect(children, "table:table")[0];
  if (table) return extractTable(table);

  const textBox = findDirect(children, "draw:text-box")[0];
  const textContainer = textBox ? childrenOf(textBox) : children;
  const lines = paragraphsToLines(textContainer);

  if (tag === "draw:frame") {
    return lines.length ? { kind: "text", lines } : null;
  }

  const shapeType = SHAPE_LABELS[tag] ?? tag;
  return { kind: "shape", shapeType, lines };
}

function extractSlideElements(pageChildren: PNode[]): SlideElement[] {
  const elements: SlideElement[] = [];
  for (const child of pageChildren) {
    const tag = tagOf(child);
    if (!tag) continue;

    if (tag === "presentation:notes") continue;

    if (tag === "draw:g") {
      elements.push(...extractSlideElements(childrenOf(child)));
      continue;
    }

    if (tag === "table:table") {
      elements.push(extractTable(child));
      continue;
    }

    if (tag === "draw:frame" || tag in SHAPE_LABELS) {
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

  const pages = findAllDeep(root, "draw:page");
  const slides: ParsedSlide[] = pages.map((page, index) => {
    const children = childrenOf(page);
    return {
      index,
      name: attrsOf(page)["@_draw:name"],
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

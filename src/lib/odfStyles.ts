import {
  attrsOf,
  childrenOf,
  findAllDeep,
  findDirect,
  parseLengthCm,
  tagOf,
  type PNode,
} from "./odfXml";

/** Character-level formatting, from a `text` (T*) or inherited style. */
export interface TextStyle {
  color?: string;
  fontFamily?: string;
  /** Kept in points: the viewer converts to a container-relative unit so the
   * text scales with however large the slide is actually drawn. */
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** Block-level formatting, from a `paragraph` (P*) style. */
export interface ParagraphStyle {
  textAlign?: "left" | "right" | "center" | "justify";
  marginTopCm?: number;
  marginBottomCm?: number;
  lineHeight?: number;
}

/** Frame/shape box formatting, from a `graphic` or `presentation` style. */
export interface GraphicStyle {
  /** Undefined means draw:fill="none" — the box is transparent. */
  fillColor?: string;
  strokeColor?: string;
  strokeWidthCm?: number;
  verticalAlign?: "top" | "middle" | "bottom";
  /** draw:textarea-horizontal-align — the box's default text alignment,
   * which an individual paragraph's fo:text-align can still override. */
  horizontalAlign?: "left" | "right" | "center" | "justify";
  paddingTopCm?: number;
  paddingRightCm?: number;
  paddingBottomCm?: number;
  paddingLeftCm?: number;
}

interface RawStyle {
  parent?: string;
  /** Merged attributes of every style:*-properties child, by ODF name. */
  props: Record<string, string>;
}

/** Styles are looked up per family, because ODF only guarantees a style name
 * is unique within its family (a `graphic` "text" and a `text` "text" are
 * different styles, and both occur in real documents). */
type Family = "graphic" | "presentation" | "paragraph" | "text";

export interface StyleIndex {
  graphic: (name: string | undefined) => GraphicStyle;
  paragraph: (name: string | undefined) => ParagraphStyle;
  text: (name: string | undefined) => TextStyle;
}

const PROPERTY_TAGS = new Set([
  "style:graphic-properties",
  "style:paragraph-properties",
  "style:text-properties",
  "style:drawing-page-properties",
]);

function collectRawStyles(roots: PNode[]): Map<string, RawStyle> {
  const byKey = new Map<string, RawStyle>();
  for (const node of findAllDeep(roots, "style:style")) {
    const attrs = attrsOf(node);
    const name = attrs["@_style:name"];
    const family = attrs["@_style:family"];
    if (!name || !family) continue;

    const props: Record<string, string> = {};
    for (const child of childrenOf(node)) {
      const tag = tagOf(child);
      if (!tag || !PROPERTY_TAGS.has(tag)) continue;
      for (const [key, value] of Object.entries(attrsOf(child))) {
        // Strip fast-xml-parser's "@_" prefix so lookups read like the spec.
        props[key.slice(2)] = value;
      }
    }
    byKey.set(`${family}/${name}`, {
      parent: attrs["@_style:parent-style-name"],
      props,
    });
  }
  return byKey;
}

/** Walks the style:parent-style-name chain and flattens it, nearest wins.
 * Without this, the automatic styles that documents actually reference
 * (gr3, P1, T1 …) resolve to almost nothing: the bulk of the formatting sits
 * in the named parents defined over in styles.xml. */
function flatten(
  byKey: Map<string, RawStyle>,
  family: Family,
  name: string | undefined,
): Record<string, string> {
  const chain: RawStyle[] = [];
  const seen = new Set<string>();
  let current = name;
  while (current) {
    const key = `${family}/${current}`;
    if (seen.has(key)) break; // Malformed document with a cyclic parent chain.
    seen.add(key);
    const style = byKey.get(key);
    if (!style) break;
    chain.push(style);
    current = style.parent;
  }

  const merged: Record<string, string> = {};
  // Furthest ancestor first, so nearer definitions overwrite it.
  for (const style of chain.reverse()) Object.assign(merged, style.props);
  return merged;
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value?.endsWith("%")) return undefined;
  const num = parseFloat(value);
  return Number.isFinite(num) ? num / 100 : undefined;
}

/** ODF colors are "#rrggbb", but the attribute may also be "transparent" or
 * an unresolvable reference, which must not reach CSS as-is. */
function parseColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

function toGraphicStyle(props: Record<string, string>): GraphicStyle {
  const style: GraphicStyle = {};

  if (props["draw:fill"] === "solid") {
    style.fillColor = parseColor(props["draw:fill-color"]);
  }
  if (props["draw:stroke"] && props["draw:stroke"] !== "none") {
    style.strokeColor = parseColor(props["svg:stroke-color"]) ?? "#000000";
    // A stroke declared "solid" with width 0 still renders as a hairline in
    // Impress, so an explicit 0 must not become "no border".
    style.strokeWidthCm = parseLengthCm(props["svg:stroke-width"]) || 0.026;
  }

  const vertical = props["draw:textarea-vertical-align"];
  if (vertical === "top" || vertical === "middle" || vertical === "bottom") {
    style.verticalAlign = vertical;
  }

  switch (props["draw:textarea-horizontal-align"]) {
    case "left":
      style.horizontalAlign = "left";
      break;
    case "right":
      style.horizontalAlign = "right";
      break;
    case "center":
      style.horizontalAlign = "center";
      break;
    case "justify":
      style.horizontalAlign = "justify";
      break;
  }

  style.paddingTopCm = parseLengthCm(props["fo:padding-top"]);
  style.paddingRightCm = parseLengthCm(props["fo:padding-right"]);
  style.paddingBottomCm = parseLengthCm(props["fo:padding-bottom"]);
  style.paddingLeftCm = parseLengthCm(props["fo:padding-left"]);
  return style;
}

function toParagraphStyle(props: Record<string, string>): ParagraphStyle {
  const style: ParagraphStyle = {};

  // ODF uses the writing-direction-relative "start"/"end"; for the
  // left-to-right documents this viewer targets those map to left/right.
  switch (props["fo:text-align"]) {
    case "start":
    case "left":
      style.textAlign = "left";
      break;
    case "end":
    case "right":
      style.textAlign = "right";
      break;
    case "center":
      style.textAlign = "center";
      break;
    case "justify":
      style.textAlign = "justify";
      break;
  }

  style.marginTopCm = parseLengthCm(props["fo:margin-top"]);
  style.marginBottomCm = parseLengthCm(props["fo:margin-bottom"]);
  style.lineHeight = parsePercent(props["fo:line-height"]);
  return style;
}

function toTextStyle(props: Record<string, string>): TextStyle {
  const style: TextStyle = {};
  style.color = parseColor(props["fo:color"]);

  const family = props["fo:font-family"] ?? props["style:font-name"];
  if (family) style.fontFamily = family.replace(/^'|'$/g, "");

  const sizeCm = parseLengthCm(props["fo:font-size"]);
  if (sizeCm !== undefined) style.fontSizePt = (sizeCm / 2.54) * 72;

  const weight = props["fo:font-weight"];
  if (weight) style.bold = weight !== "normal";

  const italic = props["fo:font-style"];
  if (italic) style.italic = italic !== "normal";

  const underline = props["style:text-underline-style"];
  if (underline) style.underline = underline !== "none";

  const strike = props["style:text-line-through-style"];
  if (strike) style.strike = strike !== "none";

  return style;
}

/** Drops undefined entries so `Object.assign`-style merging of a child style
 * onto its context never blanks out an inherited value. */
function compact<T extends object>(style: T): T {
  for (const key of Object.keys(style) as (keyof T)[]) {
    if (style[key] === undefined) delete style[key];
  }
  return style;
}

/**
 * Builds one lookup over the automatic styles in content.xml and the named
 * styles in styles.xml. Both are needed: documents reference the short
 * automatic names, which inherit nearly everything from the named ones.
 */
export function buildStyleIndex(contentRoot: PNode[], stylesRoot: PNode[]): StyleIndex {
  const byKey = collectRawStyles([...stylesRoot, ...contentRoot]);

  const graphicCache = new Map<string, GraphicStyle>();
  const paragraphCache = new Map<string, ParagraphStyle>();
  const textCache = new Map<string, TextStyle>();

  return {
    graphic(name) {
      if (!name) return {};
      const hit = graphicCache.get(name);
      if (hit) return hit;
      // A shape's draw:style-name may live in either family; presentation
      // placeholders (pr*) use the same property vocabulary as graphics.
      const props = {
        ...flatten(byKey, "presentation", name),
        ...flatten(byKey, "graphic", name),
      };
      const style = compact(toGraphicStyle(props));
      graphicCache.set(name, style);
      return style;
    },
    paragraph(name) {
      if (!name) return {};
      const hit = paragraphCache.get(name);
      if (hit) return hit;
      const style = compact(toParagraphStyle(flatten(byKey, "paragraph", name)));
      paragraphCache.set(name, style);
      return style;
    },
    text(name) {
      if (!name) return {};
      const hit = textCache.get(name);
      if (hit) return hit;
      // Character formatting can also be declared on a paragraph style's
      // style:text-properties, which is where font-size usually lives.
      const props = {
        ...flatten(byKey, "paragraph", name),
        ...flatten(byKey, "text", name),
      };
      const style = compact(toTextStyle(props));
      textCache.set(name, style);
      return style;
    },
  };
}

/** The page geometry lookup lives here too, since it is the same
 * styles.xml walk. */
export interface PageLayout {
  widthCm: number;
  heightCm: number;
}

/** Resolves each master-page's actual on-screen size (styles.xml commonly
 * defines a leftover print-oriented page-layout alongside the real
 * presentation one — the master-page → page-layout-name chain is what
 * actually governs a given slide, not just "the first page-layout"). */
export function parsePageLayouts(stylesRoot: PNode[]): Map<string, PageLayout> {
  const layoutsByName = new Map<string, PageLayout>();
  for (const layout of findAllDeep(stylesRoot, "style:page-layout")) {
    const name = attrsOf(layout)["@_style:name"];
    const props = findDirect(childrenOf(layout), "style:page-layout-properties")[0];
    if (!name || !props) continue;
    const widthCm = parseLengthCm(attrsOf(props)["@_fo:page-width"]);
    const heightCm = parseLengthCm(attrsOf(props)["@_fo:page-height"]);
    if (widthCm && heightCm) layoutsByName.set(name, { widthCm, heightCm });
  }

  const pageLayoutByMasterPage = new Map<string, PageLayout>();
  for (const masterPage of findAllDeep(stylesRoot, "style:master-page")) {
    const masterName = attrsOf(masterPage)["@_style:name"];
    const layoutName = attrsOf(masterPage)["@_style:page-layout-name"];
    const layout = layoutName ? layoutsByName.get(layoutName) : undefined;
    if (masterName && layout) pageLayoutByMasterPage.set(masterName, layout);
  }
  return pageLayoutByMasterPage;
}

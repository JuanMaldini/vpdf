// fast-xml-parser's preserveOrder output: each node is an object with a
// single tag-name key (its children array) plus an optional ":@" key
// holding that tag's attributes. Using preserveOrder (instead of the
// default collapsed object tree) keeps text runs, line breaks and nested
// shapes in document order, which paragraph/table extraction needs.
export type PNode = Record<string, unknown>;

export function tagOf(node: PNode): string | undefined {
  return Object.keys(node).find((k) => k !== ":@");
}

export function childrenOf(node: PNode): PNode[] {
  // "#text" nodes hold a raw string value (not a children array) under
  // that key, so they must be excluded before indexing into the tag key.
  if ("#text" in node) return [];
  const t = tagOf(node);
  return t ? ((node[t] as PNode[]) ?? []) : [];
}

export function attrsOf(node: PNode): Record<string, string> {
  return (node[":@"] as Record<string, string>) ?? {};
}

export function findDirect(nodes: PNode[], tag: string): PNode[] {
  return nodes.filter((n) => tagOf(n) === tag);
}

export function findAllDeep(nodes: PNode[], tag: string): PNode[] {
  const out: PNode[] = [];
  for (const n of nodes) {
    const t = tagOf(n);
    if (t === tag) out.push(n);
    if (t) out.push(...findAllDeep(childrenOf(n), tag));
  }
  return out;
}

/** ODF length attributes (svg:x, svg:width, fo:font-size, ...) carry a unit
 * suffix; normalizing everything to cm lets element, page and style geometry
 * be compared directly regardless of which unit the producing app used. */
export function parseLengthCm(value: string | undefined): number | undefined {
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

export const CM_PER_PT = 2.54 / 72;

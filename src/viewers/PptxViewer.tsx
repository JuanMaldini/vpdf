import { useEffect, useRef, useState } from "react";
import { init } from "pptx-preview";
import type JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import "./PptxViewer.css";

interface PptxViewerProps {
  buffer: ArrayBuffer;
  zip: JSZip;
  onError: (message: string) => void;
}

type XmlNode = Record<string, unknown>;

/** fast-xml-parser collapses a single child into the object itself and only
 * produces an array when there are several, so every child access has to be
 * normalized before it can be iterated. */
function asArray(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as XmlNode[];
}

/** Text inside a paragraph is split across runs (a:r), auto-updating fields
 * such as slide numbers (a:fld) and explicit line breaks (a:br). Reading only
 * a:r — as the first version did — silently dropped the other two, which runs
 * whole notes together into one line. */
function paragraphText(paragraph: XmlNode): string {
  let out = "";
  for (const [tag, value] of Object.entries(paragraph)) {
    if (tag === "a:br") {
      out += "\n".repeat(asArray(value).length || 1);
      continue;
    }
    if (tag !== "a:r" && tag !== "a:fld") continue;
    for (const run of asArray(value)) {
      const text = run["a:t"];
      if (typeof text === "string") out += text;
      else if (typeof text === "number") out += String(text);
    }
  }
  return out;
}

/** Notes shapes can be nested inside group shapes (p:grpSp), which are
 * themselves nestable, so the whole subtree has to be walked. */
function collectShapes(tree: XmlNode | undefined, into: XmlNode[] = []) {
  if (!tree) return into;
  into.push(...asArray(tree["p:sp"]));
  for (const group of asArray(tree["p:grpSp"])) collectShapes(group, into);
  return into;
}

/**
 * pptx-preview renders every visual element (text, images, tables, shapes,
 * charts, SmartArt) but has no concept of speaker notes, so notes are
 * extracted separately from ppt/notesSlideN.xml and shown alongside each
 * slide to avoid silently dropping information.
 */
async function extractNotes(zip: JSZip): Promise<Map<number, string>> {
  const notesBySlide = new Map<number, string>();
  const parser = new XMLParser({ ignoreAttributes: false });

  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const relsXml = await zip
    .file("ppt/_rels/presentation.xml.rels")
    ?.async("string");
  if (!presentationXml || !relsXml) return notesBySlide;

  const presentation = parser.parse(presentationXml);
  const rels = parser.parse(relsXml);

  const relById = new Map<string, string>();
  for (const rel of asArray(rels?.Relationships?.Relationship)) {
    const id = rel["@_Id"];
    const target = rel["@_Target"];
    if (typeof id === "string" && typeof target === "string") {
      relById.set(id, target);
    }
  }

  const sldIds = asArray(
    presentation?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"],
  );

  // One slide's notes never depend on another's, so the per-slide rels +
  // notes lookups all run concurrently instead of serially awaiting each
  // inflate — the difference is very visible on a 100-slide deck.
  const entries = await Promise.all(
    sldIds.map(async (sldId, index): Promise<[number, string] | null> => {
      const rId = sldId["@_r:id"];
      const target = typeof rId === "string" ? relById.get(rId) : undefined;
      if (!target) return null;

      const slideName = target.split("/").pop();
      const slideRelsXml = await zip
        .file(`ppt/slides/_rels/${slideName}.rels`)
        ?.async("string");
      if (!slideRelsXml) return null;

      const slideRels = parser.parse(slideRelsXml);
      const notesRel = asArray(slideRels?.Relationships?.Relationship).find(
        (r) => String(r["@_Type"] ?? "").endsWith("/notesSlide"),
      );
      const notesTarget = notesRel?.["@_Target"];
      if (typeof notesTarget !== "string") return null;

      const notesXml = await zip
        .file(resolvePartPath(notesTarget))
        ?.async("string");
      if (!notesXml) return null;

      const notesDoc = parser.parse(notesXml);
      const shapes = collectShapes(
        notesDoc?.["p:notes"]?.["p:cSld"]?.["p:spTree"],
      );
      const lines: string[] = [];
      for (const shape of shapes) {
        const body = shape["p:txBody"] as XmlNode | undefined;
        for (const paragraph of asArray(body?.["a:p"])) {
          const line = paragraphText(paragraph);
          if (line.trim()) lines.push(line);
        }
      }
      const text = lines.join("\n").trim();
      return text ? [index, text] : null;
    }),
  );

  for (const entry of entries) {
    if (entry) notesBySlide.set(entry[0], entry[1]);
  }
  return notesBySlide;
}

/** Relationship targets are relative to the part that declares them
 * (ppt/slides/…), or package-absolute when they start with "/". */
function resolvePartPath(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return target.startsWith("../")
    ? `ppt/${target.slice(3)}`
    : `ppt/slides/${target}`;
}

function PptxViewer({ buffer, zip, onError }: PptxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    const wrapper = containerRef.current;
    if (!wrapper) return;
    let cancelled = false;

    // pptx-preview appends slide DOM into whatever element init() is given,
    // and destroy() doesn't fully tear that down (same caveat as ts-pdf
    // above). Under StrictMode's mount/unmount/mount cycle in development,
    // reusing wrapper directly would leave the first, undestroyed copy of
    // every slide behind when init() runs a second time. A fresh child node
    // per mount, removed wholesale on cleanup, avoids that.
    const container = document.createElement("div");
    wrapper.appendChild(container);

    const previewer = init(container, {
      width: 960,
      height: 540,
      mode: "list",
    });

    (async () => {
      try {
        // pptx-preview inflates the archive itself and only accepts raw
        // bytes, so it gets the buffer while the notes pass reuses the zip
        // App already loaded during type detection.
        await previewer.preview(buffer);
        if (cancelled) return;

        const extracted = await extractNotes(zip);
        if (!cancelled) setNotes(extracted);
      } catch (err) {
        if (!cancelled) {
          onError(
            err instanceof Error
              ? `No se pudo renderizar el PPTX: ${err.message}`
              : "No se pudo renderizar el PPTX.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      previewer.destroy();
      wrapper.removeChild(container);
    };
  }, [buffer, zip, onError]);

  // Driven by the notes map itself rather than the previewer's slide count:
  // the two are populated by separate async steps, and keying the loop off
  // the count rendered an empty "Notas del orador" panel whenever notes
  // arrived while the count was still 0.
  const noteEntries = Array.from(notes.entries()).sort((a, b) => a[0] - b[0]);

  return (
    <div className="pptx-viewer">
      <div ref={containerRef} className="pptx-viewer-slides" />
      {noteEntries.length > 0 && (
        <div className="pptx-viewer-notes">
          <div className="pptx-viewer-notes-title">Notas del orador</div>
          {noteEntries.map(([index, text]) => (
            <div key={index} className="pptx-viewer-note">
              <div className="pptx-viewer-note-slide">
                Diapositiva {index + 1}
              </div>
              <div className="pptx-viewer-note-text">{text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default PptxViewer;

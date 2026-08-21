import { useEffect, useRef, useState } from "react";
import { init } from "pptx-preview";

type PPTXPreviewer = ReturnType<typeof init>;
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import "./PptxViewer.css";

interface PptxViewerProps {
  file: File;
  onError: (message: string) => void;
}

/**
 * pptx-preview renders every visual element (text, images, tables, shapes,
 * charts, SmartArt) but has no concept of speaker notes, so notes are
 * extracted separately from ppt/notesSlideN.xml and shown alongside each
 * slide to avoid silently dropping information.
 */
async function extractNotes(file: File): Promise<Map<number, string>> {
  const notesBySlide = new Map<number, string>();
  const zip = await JSZip.loadAsync(file);
  const parser = new XMLParser({ ignoreAttributes: false });

  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const relsXml = await zip
    .file("ppt/_rels/presentation.xml.rels")
    ?.async("string");
  if (!presentationXml || !relsXml) return notesBySlide;

  const presentation = parser.parse(presentationXml);
  const rels = parser.parse(relsXml);

  const relById = new Map<string, string>();
  const relEntries = [rels?.Relationships?.Relationship ?? []].flat();
  for (const rel of relEntries) {
    if (rel?.["@_Id"] && rel?.["@_Target"]) {
      relById.set(rel["@_Id"], rel["@_Target"]);
    }
  }

  const sldIdEntries = [presentation?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"] ?? []].flat();

  for (let i = 0; i < sldIdEntries.length; i++) {
    const rId = sldIdEntries[i]?.["@_r:id"];
    const target = rId ? relById.get(rId) : undefined;
    if (!target) continue;

    const slideName = target.split("/").pop();
    const slideRelsXml = await zip
      .file(`ppt/slides/_rels/${slideName}.rels`)
      ?.async("string");
    if (!slideRelsXml) continue;

    const slideRels = parser.parse(slideRelsXml);
    const slideRelEntries = [
      slideRels?.Relationships?.Relationship ?? [],
    ].flat();
    const notesRel = slideRelEntries.find((r) =>
      r?.["@_Type"]?.endsWith("/notesSlide"),
    );
    if (!notesRel) continue;

    const notesTarget = notesRel["@_Target"].replace("../", "ppt/");
    const notesXml = await zip.file(notesTarget)?.async("string");
    if (!notesXml) continue;

    const notesDoc = parser.parse(notesXml);
    const shapes = [
      notesDoc?.["p:notes"]?.["p:cSld"]?.["p:spTree"]?.["p:sp"] ?? [],
    ].flat();
    const textRuns: string[] = [];
    for (const shape of shapes) {
      const paragraphs = [shape?.["p:txBody"]?.["a:p"] ?? []].flat();
      for (const paragraph of paragraphs) {
        const runs = [paragraph?.["a:r"] ?? []].flat();
        const line = runs
          .map((run) => run?.["a:t"])
          .filter((t): t is string => typeof t === "string")
          .join("");
        if (line) textRuns.push(line);
      }
    }
    const text = textRuns.join("\n").trim();
    if (text) notesBySlide.set(i, text);
  }

  return notesBySlide;
}

function PptxViewer({ file, onError }: PptxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<PPTXPreviewer | null>(null);
  const [notes, setNotes] = useState<Map<number, string>>(new Map());
  const [slideCount, setSlideCount] = useState(0);

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
    previewerRef.current = previewer;

    (async () => {
      try {
        const buffer = await file.arrayBuffer();
        await previewer.preview(buffer);
        if (cancelled) return;
        setSlideCount(previewer.slideCount);

        const extracted = await extractNotes(file);
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
      previewerRef.current = null;
    };
  }, [file, onError]);

  const hasNotes = notes.size > 0;

  return (
    <div className="pptx-viewer">
      <div ref={containerRef} className="pptx-viewer-slides" />
      {hasNotes && (
        <div className="pptx-viewer-notes">
          <div className="pptx-viewer-notes-title">Notas del orador</div>
          {Array.from({ length: slideCount }, (_, i) => {
            const text = notes.get(i);
            if (!text) return null;
            return (
              <div key={i} className="pptx-viewer-note">
                <div className="pptx-viewer-note-slide">Diapositiva {i + 1}</div>
                <div className="pptx-viewer-note-text">{text}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PptxViewer;

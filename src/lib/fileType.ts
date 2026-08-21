import JSZip from "jszip";

export type DetectedFileType =
  | "pdf"
  | "pptx"
  | "odp"
  | "ppt-legacy"
  | "unsupported";

export interface DetectedFile {
  kind: DetectedFileType;
  /** The whole file, read exactly once. Undefined when kind is "unsupported". */
  buffer?: ArrayBuffer;
  /** Already-inflated archive for the ZIP-based formats, so the viewer that
   * consumes it doesn't have to parse the central directory a second time. */
  zip?: JSZip;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE2/CFB

function matchesMagic(bytes: Uint8Array, magic: number[]) {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * Auto-detects the real file type from its binary signature (not the
 * filename/mime, which the user or OS can get wrong or omit). PPTX and ODP
 * are both ZIP containers, so telling them apart requires peeking inside the
 * archive's entry names/mimetype rather than the outer magic bytes alone.
 *
 * The signature check runs against an 8-byte slice first so an unrecognized
 * (possibly huge) file is rejected without ever being read into memory.
 */
export async function detectFile(file: File): Promise<DetectedFile> {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());

  if (matchesMagic(header, PDF_MAGIC)) {
    return { kind: "pdf", buffer: await file.arrayBuffer() };
  }
  if (matchesMagic(header, CFB_MAGIC)) {
    return { kind: "ppt-legacy", buffer: await file.arrayBuffer() };
  }
  if (!matchesMagic(header, ZIP_MAGIC)) {
    return { kind: "unsupported" };
  }

  const buffer = await file.arrayBuffer();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { kind: "unsupported" };
  }

  const kind = await detectZipPresentationType(zip);
  return kind === "unsupported" ? { kind } : { kind, buffer, zip };
}

async function detectZipPresentationType(
  zip: JSZip,
): Promise<DetectedFileType> {
  if (zip.file("ppt/presentation.xml")) return "pptx";

  const mimetypeEntry = zip.file("mimetype");
  if (mimetypeEntry) {
    const mimetype = (await mimetypeEntry.async("string")).trim();
    if (mimetype === "application/vnd.oasis.opendocument.presentation") {
      return "odp";
    }
  }

  if (zip.file("content.xml")) return "odp";
  return "unsupported";
}

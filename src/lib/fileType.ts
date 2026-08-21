import JSZip from "jszip";

export type DetectedFileType =
  | "pdf"
  | "pptx"
  | "odp"
  | "ppt-legacy"
  | "unsupported";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE2/CFB

function matchesMagic(bytes: Uint8Array, magic: number[]) {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

async function readHeader(file: File, length: number): Promise<Uint8Array> {
  const buf = await file.slice(0, length).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Auto-detects the real file type from its binary signature (not the
 * filename/mime, which the user or OS can get wrong or omit). PPTX and ODP
 * are both ZIP containers, so telling them apart requires peeking inside the
 * archive's entry names/mimetype rather than the outer magic bytes alone.
 */
export async function detectFileType(file: File): Promise<DetectedFileType> {
  const header = await readHeader(file, 8);

  if (matchesMagic(header, PDF_MAGIC)) return "pdf";
  if (matchesMagic(header, CFB_MAGIC)) return "ppt-legacy";

  if (matchesMagic(header, ZIP_MAGIC)) {
    return detectZipPresentationType(file);
  }

  return "unsupported";
}

async function detectZipPresentationType(
  file: File,
): Promise<DetectedFileType> {
  try {
    const zip = await JSZip.loadAsync(file);
    if (zip.file("ppt/presentation.xml")) return "pptx";

    const mimetypeEntry = zip.file("mimetype");
    if (mimetypeEntry) {
      const mimetype = (await mimetypeEntry.async("string")).trim();
      if (mimetype === "application/vnd.oasis.opendocument.presentation") {
        return "odp";
      }
    }

    if (zip.file("content.xml")) return "odp";
  } catch {
    return "unsupported";
  }
  return "unsupported";
}

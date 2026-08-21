import * as CFB from "cfb";

// Legacy .ppt (PowerPoint 97-2003) is a binary OLE/CFB container, not a zip,
// and there is no maintained JS library that fully parses its record model.
// This is a deliberate best-effort extractor: it walks the flat, self-
// describing record stream (every record is [2B verInstance][2B type][4B
// len][data], and low nibble 0xF of verInstance means "container, recurse
// into it") and pulls out text atoms grouped by the RT_Slide container they
// fall under. Shapes, images, positions and formatting are not recovered.
const RT_SLIDE = 0x03ee;
const RT_TEXT_CHARS_ATOM = 0x0fa0; // UTF-16LE
const RT_TEXT_BYTES_ATOM = 0x0fa8; // 1 byte per char, extended ASCII

function decodeTextCharsAtom(buffer: ArrayBuffer, start: number, len: number): string {
  const text = new TextDecoder("utf-16le").decode(new Uint8Array(buffer, start, len));
  return text.replace(/\v/g, "\n");
}

function decodeTextBytesAtom(buffer: ArrayBuffer, start: number, len: number): string {
  const bytes = new Uint8Array(buffer, start, len);
  let text: string;
  try {
    text = new TextDecoder("windows-1252").decode(bytes);
  } catch {
    text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  }
  return text.replace(/\v/g, "\n");
}

export interface LegacyPptResult {
  /** One entry per detected slide; empty if slide boundaries couldn't be found. */
  slides: string[][];
  /** Text found outside any recognized slide container, used as a fallback. */
  unassigned: string[];
}

export function extractLegacyPptText(buffer: ArrayBuffer): LegacyPptResult {
  const view = new DataView(buffer);
  const slides: string[][] = [];
  const unassigned: string[] = [];
  let currentBucket: string[] | null = null;

  function walk(start: number, end: number) {
    let offset = start;
    while (offset + 8 <= end) {
      const verInstance = view.getUint16(offset, true);
      const type = view.getUint16(offset + 2, true);
      const len = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;

      if (len < 0 || dataStart + len > end) break;
      const isContainer = (verInstance & 0xf) === 0xf;

      if (type === RT_SLIDE) {
        const bucket: string[] = [];
        slides.push(bucket);
        const previousBucket = currentBucket;
        currentBucket = bucket;
        walk(dataStart, dataStart + len);
        currentBucket = previousBucket;
      } else if (isContainer) {
        walk(dataStart, dataStart + len);
      } else if (type === RT_TEXT_CHARS_ATOM || type === RT_TEXT_BYTES_ATOM) {
        const text =
          type === RT_TEXT_CHARS_ATOM
            ? decodeTextCharsAtom(buffer, dataStart, len)
            : decodeTextBytesAtom(buffer, dataStart, len);
        if (text.trim()) {
          (currentBucket ?? unassigned).push(text);
        }
      }

      offset = dataStart + len;
    }
  }

  walk(0, buffer.byteLength);
  return { slides, unassigned };
}

export function readPowerPointStream(fileBuffer: ArrayBuffer): ArrayBuffer {
  const container = CFB.read(new Uint8Array(fileBuffer), { type: "array" });
  const entry = CFB.find(container, "PowerPoint Document");
  if (!entry) {
    throw new Error('No se encontró el stream "PowerPoint Document" en el archivo.');
  }
  const bytes =
    entry.content instanceof Uint8Array ? entry.content : new Uint8Array(entry.content);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

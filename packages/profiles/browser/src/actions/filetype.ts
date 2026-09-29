import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";

export interface FileType {
  mime: string;
  label: string;
  // Extensions this content legitimately carries.
  extensions: string[];
}

const TEXT_BY_EXTENSION: Record<string, FileType> = {
  ".md": { mime: "text/markdown", label: "Markdown text", extensions: [".md", ".markdown"] },
  ".markdown": { mime: "text/markdown", label: "Markdown text", extensions: [".md", ".markdown"] },
  ".csv": { mime: "text/csv", label: "CSV text", extensions: [".csv"] },
  ".json": { mime: "application/json", label: "JSON text", extensions: [".json"] },
  ".html": { mime: "text/html", label: "HTML", extensions: [".html", ".htm"] },
  ".htm": { mime: "text/html", label: "HTML", extensions: [".html", ".htm"] },
};
const PLAIN_TEXT: FileType = { mime: "text/plain", label: "plain text", extensions: [".txt"] };
const UNKNOWN: FileType = {
  mime: "application/octet-stream",
  label: "binary data",
  extensions: [],
};

function head(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// From the content, not the name: a résumé renamed to .pdf is still Markdown.
export function detectType(path: string): FileType {
  const bytes = head(path, 8192);
  const ascii = bytes.subarray(0, 16).toString("latin1");
  if (ascii.startsWith("%PDF"))
    return { mime: "application/pdf", label: "PDF", extensions: [".pdf"] };
  if (bytes[0] === 0x89 && ascii.slice(1, 4) === "PNG")
    return { mime: "image/png", label: "PNG image", extensions: [".png"] };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", label: "JPEG image", extensions: [".jpg", ".jpeg"] };
  if (ascii.startsWith("GIF8"))
    return { mime: "image/gif", label: "GIF image", extensions: [".gif"] };
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP")
    return { mime: "image/webp", label: "WebP image", extensions: [".webp"] };
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    return {
      mime: "application/msword",
      label: "legacy Office document",
      extensions: [".doc", ".xls", ".ppt"],
    };
  if (ascii.startsWith("PK\u0003\u0004")) {
    const listing = bytes.toString("latin1");
    if (listing.includes("word/"))
      return {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        label: "Word document",
        extensions: [".docx"],
      };
    if (listing.includes("xl/"))
      return {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        label: "Excel workbook",
        extensions: [".xlsx"],
      };
    if (listing.includes("ppt/"))
      return {
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        label: "PowerPoint deck",
        extensions: [".pptx"],
      };
    return { mime: "application/zip", label: "ZIP archive", extensions: [".zip"] };
  }
  if (ascii.startsWith("{\\rtf"))
    return { mime: "application/rtf", label: "RTF document", extensions: [".rtf"] };
  if (bytes.includes(0)) return UNKNOWN;
  const text = bytes.toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html"))
    return TEXT_BY_EXTENSION[".html"] as FileType;
  return TEXT_BY_EXTENSION[extname(path).toLowerCase()] ?? PLAIN_TEXT;
}

function contentMismatch(path: string, type: FileType): string | undefined {
  const ext = extname(path).toLowerCase();
  if (!ext || type.extensions.length === 0 || type.extensions.includes(ext)) return undefined;
  // Any text is fine under .txt; binary content under a text name is not.
  if (ext === ".txt" && type.mime.startsWith("text/")) return undefined;
  return `named ${ext} but the content is ${type.label}`;
}

export function describeFile(path: string): string {
  const type = detectType(path);
  const size = statSync(path).size;
  const shown =
    size >= 1_048_576
      ? `${(size / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  const mismatch = contentMismatch(path, type);
  return `${type.label}, ${shown}${mismatch ? ` (${mismatch})` : ""}`;
}

// Why a file should not go into an <input accept> field (".pdf,.docx", "image/*",
// MIME types), if it should not. Sites check the name; the content must match it.
export function uploadProblem(accept: string, path: string): string | undefined {
  const type = detectType(path);
  const mismatch = contentMismatch(path, type);
  if (mismatch) return mismatch;
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  const ext = extname(path).toLowerCase();
  const accepted = tokens.some((token) => {
    if (token.startsWith(".")) return ext === token;
    if (token.endsWith("/*")) return type.mime.startsWith(token.slice(0, -1));
    return type.mime === token;
  });
  return accepted
    ? undefined
    : `the field accepts ${tokens.join(", ")}; this is ${type.label} (${ext || "no extension"})`;
}

import type { RecordedField, RecordedFile } from "./types.ts";

export type ParsedForm = {
  fields: RecordedField[];
  files: RecordedFile[];
  values: Record<string, string[]>;
};

function basenameOf(rawFilename: string): string {
  const normalized = rawFilename.replace(/\\/g, "/");
  const last = normalized.split("/").pop() ?? "";
  return last === "" ? "unnamed" : last;
}

async function describeFile(field: string, file: File): Promise<RecordedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    field,
    basename: basenameOf(file.name),
    rawFilename: file.name,
    mimeType: file.type || "application/octet-stream",
    bytes: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
}

export async function parseForm(req: Request): Promise<ParsedForm> {
  const fields: RecordedField[] = [];
  const files: RecordedFile[] = [];
  let entries: [string, unknown][] = [];
  try {
    entries = [...(await req.formData()).entries()] as [string, unknown][];
  } catch {
    return { fields, files, values: {} };
  }
  for (const [name, value] of entries) {
    if (typeof value === "string") {
      fields.push({ name, value });
      continue;
    }
    const file = value as File;
    // Empty file inputs still arrive as a zero-byte part; they are not a real upload.
    if (file.size === 0 && file.name === "") continue;
    files.push(await describeFile(name, file));
  }
  const values: Record<string, string[]> = {};
  for (const field of fields) {
    const bucket = values[field.name];
    if (bucket) bucket.push(field.value);
    else values[field.name] = [field.value];
  }
  return { fields, files, values };
}

export function first(form: ParsedForm, name: string): string {
  return form.values[name]?.[0] ?? "";
}

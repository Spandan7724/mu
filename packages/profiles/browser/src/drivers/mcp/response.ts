// Playwright MCP answers every tool call with one markdown document. Only the
// sections named here are ever read; the rest — the generated Playwright source,
// the console log link, the saved-snapshot link — is discarded before anything
// leaves the adapter, so no sidecar filesystem path can reach an outcome, an
// event or a session entry (SECURITY §11).

export interface SidecarResponse {
  url?: string | undefined;
  title?: string | undefined;
  snapshot?: string | undefined;
  // The sidecar's own words for a raised dialog or an open file chooser.
  modalState?: string | undefined;
  // `### Result` bodies, used only for tool calls whose whole answer is the result.
  result?: string | undefined;
  downloads: string[];
  // A saved-output reference the sidecar reported. Its presence is a defect
  // signal — it means the response would have carried a path — never a value the
  // adapter passes on.
  savedPaths: string[];
  raw: string;
}

const SECTION = /^### +(.+?)\s*$/;
const PAGE_URL = /^- Page URL:\s*(.*)$/;
const PAGE_TITLE = /^- Page Title:\s*(.*)$/;
// `### Snapshot` either fences the YAML inline or links a file it was written to.
const LINK = /\[[^\]]*\]\(([^)]+)\)/;
const DOWNLOAD = /Downloaded file\s+(.+?)\s+to\s+/i;

function isFence(line: string): boolean {
  return line.startsWith("```");
}

export function parseSidecarResponse(text: string): SidecarResponse {
  const lines = text.split("\n");
  const response: SidecarResponse = { downloads: [], savedPaths: [], raw: text };
  let section = "";
  const snapshot: string[] = [];
  const result: string[] = [];
  const modal: string[] = [];
  let fenced = false;

  for (const line of lines) {
    const heading = section === "Snapshot" && fenced ? null : SECTION.exec(line);
    if (heading?.[1] !== undefined) {
      section = heading[1];
      fenced = false;
      continue;
    }
    if (section === "Snapshot") {
      if (isFence(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) {
        snapshot.push(line);
        continue;
      }
      const link = LINK.exec(line);
      if (link?.[1] !== undefined) response.savedPaths.push(link[1]);
      continue;
    }
    if (section === "Page") {
      const url = PAGE_URL.exec(line);
      if (url?.[1] !== undefined) response.url = url[1].trim();
      const title = PAGE_TITLE.exec(line);
      if (title?.[1] !== undefined) response.title = title[1].trim();
      continue;
    }
    if (section === "Result") {
      if (!isFence(line)) result.push(line);
      continue;
    }
    if (section.startsWith("Modal state") || section.startsWith("New modal state")) {
      modal.push(line.replace(/^- /, "").trim());
      continue;
    }
    if (section === "Events" || section === "Downloads") {
      const download = DOWNLOAD.exec(line);
      if (download?.[1] !== undefined) response.downloads.push(download[1].trim());
      const link = LINK.exec(line);
      if (link?.[1] !== undefined) response.savedPaths.push(link[1]);
      continue;
    }
  }

  if (snapshot.length > 0) response.snapshot = snapshot.join("\n");
  const resultText = result.join("\n").trim();
  if (resultText.length > 0) response.result = resultText;
  const modalText = modal.filter(Boolean).join("; ");
  if (modalText.length > 0) response.modalState = modalText;
  return response;
}

// Tab lines look like `- 0: (current) [Title](url)`.
const TAB_LINE = /^-\s*(\d+):\s*(\(current\)\s*)?\[(.*)\]\((.*)\)\s*$/;

export interface SidecarTab {
  index: number;
  current: boolean;
  title: string;
  url: string;
}

export function parseTabList(text: string): SidecarTab[] {
  const tabs: SidecarTab[] = [];
  for (const line of text.split("\n")) {
    const match = TAB_LINE.exec(line.trim());
    if (!match) continue;
    tabs.push({
      index: Number(match[1]),
      current: match[2] !== undefined,
      title: match[3] ?? "",
      url: match[4] ?? "",
    });
  }
  return tabs;
}

export function parseJsonResult(response: SidecarResponse): unknown {
  if (response.result === undefined) return undefined;
  try {
    return JSON.parse(response.result);
  } catch {
    return undefined;
  }
}

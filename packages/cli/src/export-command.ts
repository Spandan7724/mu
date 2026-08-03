import { type Command, type SessionTree, sessionToMarkdown } from "mu";

export interface TranscriptExportCommandOptions {
  getSession: () => SessionTree;
  getSessionId: () => string;
  getModel: () => string;
  isRunning: () => boolean;
  save: (markdown: string, requestedPath: string, now: Date) => Promise<string>;
  now?: () => Date;
}

export function transcriptExportCommand(options: TranscriptExportCommandOptions): Command {
  return {
    name: "export",
    description: "Save the current chat transcript: /export [path.md]",
    run: async (ctx) => {
      if (options.isRunning()) {
        return { handled: true, message: "Cannot export during a run." };
      }
      const now = options.now?.() ?? new Date();
      const transcript = sessionToMarkdown(options.getSession(), {
        sessionId: options.getSessionId(),
        model: options.getModel(),
        exportedAt: now,
      });
      if (transcript.messageCount === 0) {
        return { handled: true, message: "Nothing to export yet." };
      }
      try {
        const path = await options.save(transcript.markdown, ctx.args, now);
        const entries = transcript.messageCount === 1 ? "entry" : "entries";
        return {
          handled: true,
          message: `Exported ${transcript.messageCount} transcript ${entries} to ${path}.`,
        };
      } catch (error) {
        return {
          handled: true,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

import { appendFile } from "node:fs/promises";

async function record(event) {
  const file = process.env.MU_PROFILE_LIFECYCLE_FILE;
  if (!file) return;
  await appendFile(file, `${process.env.MU_PROFILE_INSTANCE ?? "unknown"}:${event}\n`);
}

export default function customProfile(options = {}) {
  const presentationOnly = options.presentationOnly === true;
  return {
    name: "managed-custom-fixture",
    toolset: [],
    promptFor: () => [{ text: "Custom managed profile fixture." }],
    permissionDefaults: [],
    commands: [
      {
        name: "fixture",
        description: "Report the custom profile environment",
        run: async () => ({
          handled: true,
          message: `fixture:${process.env.MU_PROFILE_FIXTURE_VALUE ?? "missing"}`,
        }),
      },
    ],
    renderers: {
      fixture_tool: {
        render: ({ args, result }) => [
          `custom-renderer:${args?.value ?? "none"}:${result ? "done" : "running"}`,
        ],
      },
    },
    environment: () => ({ fixture: process.env.MU_PROFILE_FIXTURE_VALUE ?? "missing" }),
    scope: () => `fixture-${process.env.MU_PROFILE_SCOPE ?? "default"}`,
    runtime: {
      attach: ({ emit }) => {
        if (!presentationOnly) {
          void record("attach");
          emit({
            type: "task_started",
            taskId: `fixture-${process.env.MU_PROFILE_INSTANCE ?? "unknown"}`,
            command: "custom-profile-runtime",
            background: true,
          });
        }
      },
      resize: (cols, rows) => void record(`resize:${cols}x${rows}`),
      stop: () => void record("stop"),
      shutdown: () => record(presentationOnly ? "presentation-shutdown" : "shutdown"),
    },
  };
}

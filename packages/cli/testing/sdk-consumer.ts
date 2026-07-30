import { Agent, MemorySessionStore, tool } from "@mu-agent/mu";
import { z } from "zod";

const echo = tool({
  name: "echo",
  description: "Return the supplied text",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
});

const agent = new Agent({
  session: new MemorySessionStore(),
  tools: [echo],
});

if (!(agent instanceof Agent)) throw new Error("SDK package export did not construct Agent");

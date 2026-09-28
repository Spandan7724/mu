import type { PromptSection } from "@mu/ai";

const BASE = `You are mu, an agent that completes tasks in a real web browser through tools.`;

export function browserPrompt(_modelRef: string): PromptSection[] {
  return [{ text: BASE }];
}

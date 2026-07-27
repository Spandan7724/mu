import { type AgentOptions, createCredentialResolver } from "mu";

export function withStoredCredentials(options: AgentOptions): AgentOptions {
  if (options.getCredentials || options.apiKey) return options;
  return { ...options, getCredentials: createCredentialResolver() };
}

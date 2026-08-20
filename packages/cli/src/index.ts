export type { ParsedArgs } from "@mu/cli-runtime";
export type { HeadlessIo, RpcDeps, RpcIo, RpcOp, RpcOut } from "@mu/cli-runtime";
export { EXIT, linesFrom, parseArgs, parseOp, runHeadless, runRpc } from "@mu/cli-runtime";
export type { CodingProductCommand, CodingProductOptions } from "./product.ts";
export { codingProduct, HELP_TEXT } from "./product.ts";
export { DEFAULT_PROFILE, resolveProfile } from "./profiles.ts";

import { z } from "zod";

declare const elementRefIdBrand: unique symbol;
declare const documentIdBrand: unique symbol;

// Opaque, driver-minted. Branding stops a later lane from handing a model-supplied
// string to anything expecting a ref, and stops a ref from being rebuilt without the
// tab/revision identity that gives it meaning.
export type ElementRefId = string & { readonly [elementRefIdBrand]: true };
export type AuthorizedDocumentId = string & { readonly [documentIdBrand]: true };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Anything a filesystem would accept as a path component separator, a home
// reference or a drive letter. BD16: the model names documents, never paths.
const PATH_SHAPED = /[/\\]|^~|^\.\.?$|\.\.|^[A-Za-z]:/;

const GLOB_META = /[*?[\]{}]/;

export function isPathShaped(value: string): boolean {
  return PATH_SHAPED.test(value);
}

export function hasGlobMetacharacters(value: string): boolean {
  return GLOB_META.test(value);
}

export const elementRefIdSchema: z.ZodType<ElementRefId, string> = z
  .string()
  .regex(ID_PATTERN, "element ref must be an opaque driver-minted identifier")
  .transform((value) => value as ElementRefId);

export const authorizedDocumentIdSchema: z.ZodType<AuthorizedDocumentId, string> = z
  .string()
  .regex(ID_PATTERN, "document id must be an opaque identifier")
  .refine((value) => !isPathShaped(value), "document id must not be a filesystem path")
  .transform((value) => value as AuthorizedDocumentId);

export function elementRefId(value: string): ElementRefId {
  return elementRefIdSchema.parse(value);
}

export function authorizedDocumentId(value: string): AuthorizedDocumentId {
  return authorizedDocumentIdSchema.parse(value);
}

export const identifierSchema = z.string().regex(ID_PATTERN);

export const timestampSchema = z.number().int().nonnegative();

const WEB_SCHEMES = new Set(["http:", "https:"]);

export function normalizeOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!WEB_SCHEMES.has(url.protocol)) return undefined;
  if (url.hostname.length === 0) return undefined;
  return url.origin;
}

export function isWebUrl(value: string): boolean {
  try {
    return WEB_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const originSchema = z
  .string()
  .refine((value) => normalizeOrigin(value) === value, "must be a normalized http(s) origin");

// TOOLS.md: v1 navigation and observation only ever address http(s). javascript:,
// data:, file:, chrome:, edge:, extension and devtools URLs are denied outright.
export const webUrlSchema = z.string().refine(isWebUrl, "must be an http(s) URL");

// Pages that are not navigable targets can still be observed after the browser or a
// site lands there, so observation URLs stay permissive while navigation does not.
export const observedUrlSchema = z.string().min(1).max(4096);

export const artifactRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split(/[/\\]/).includes("..") &&
      !value.startsWith("~"),
    "must be a path relative to the artifact root",
  );

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha-256 hex");

export const basenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !isPathShaped(value), "must be a bare filename");

// Credential-shaped names. A field matching this is a takeover boundary (BD14):
// its value is never observed, never stored as a fact and never filled by the model.
const CREDENTIAL_PATTERN =
  /\b(pass ?word|pass ?code|pass ?phrase|pass ?key|otp|totp|one[ -]?time[ -]?(code|password)|verification[ -]?code|security[ -]?(code|answer|question)|mfa|2fa|two[ -]?factor|auth(entication)?[ -]?code|cvv|cvc|pin)\b/i;

// Categories CONTRACTS.md forbids deriving. A fact about one of these may be stated
// by the user or read from a document, but never inferred.
const PROTECTED_INFERENCE_PATTERN =
  /\b(work[ -]?authoriz|sponsorship|visa|citizenship|immigration|legal[ -]?status|right[ -]?to[ -]?work|gender|sex|race|ethnic|hispanic|latino|disabilit|veteran|military|criminal|conviction|felony|arrest|salary|compensation|pay[ -]?rate|desired[ -]?pay|consent|ssn|social[ -]?security|date[ -]?of[ -]?birth|birth[ -]?date|age)\b/i;

// Values SECURITY.md §7 keeps out of the generic applicant profile in v1.
const RESTRICTED_FIELD_PATTERN =
  /\b(ssn|social[ -]?security|tax[ -]?id|passport[ -]?number|driver'?s?[ -]?licen[cs]e|national[ -]?id|bank[ -]?account|routing[ -]?number|iban|credit[ -]?card|card[ -]?number|account[ -]?number)\b/i;

export function isCredentialLabel(value: string | undefined): boolean {
  return value !== undefined && CREDENTIAL_PATTERN.test(value);
}

export function isProtectedInferenceField(value: string): boolean {
  return PROTECTED_INFERENCE_PATTERN.test(value);
}

export function isRestrictedField(value: string): boolean {
  return RESTRICTED_FIELD_PATTERN.test(value);
}

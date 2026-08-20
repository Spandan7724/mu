// Field names arrive as labels, accessible names and snake_case form keys, so the
// boundaries here treat "_" as a separator where \b would not.
const START = "(?<![a-z0-9])";
const END = "(?![a-z0-9])";
const SEP = "[ _-]?";

function words(...alternatives: string[]): RegExp {
  return new RegExp(`${START}(?:${alternatives.join("|")})${END}`, "i");
}

// Credential-shaped names. A field matching this is a takeover boundary (BD14):
// its value is never observed, never stored as a fact and never filled by the model.
const CREDENTIAL_PATTERN = words(
  `pass${SEP}word`,
  `pass${SEP}code`,
  `pass${SEP}phrase`,
  `pass${SEP}key`,
  "otp",
  "totp",
  `one${SEP}time${SEP}(?:code|password)`,
  `verification${SEP}code`,
  `security${SEP}(?:code|answer|question)`,
  "mfa",
  "2fa",
  `two${SEP}factor`,
  `auth(?:entication)?${SEP}code`,
  "cvv",
  "cvc",
  "pin",
);

// Categories CONTRACTS.md forbids deriving. A fact about one of these may be stated
// by the user or read from a document, but never inferred.
const PROTECTED_INFERENCE_PATTERN = words(
  `work${SEP}authoriz\\w*`,
  "sponsorship",
  "visa\\w*",
  "citizenship",
  "immigration",
  `legal${SEP}status`,
  `right${SEP}to${SEP}work`,
  "gender",
  "sex",
  "race",
  "ethnic\\w*",
  "hispanic",
  "latino",
  "disabilit\\w*",
  "veteran",
  "military",
  "criminal",
  "conviction\\w*",
  "felony",
  "arrest\\w*",
  "salary",
  "compensation",
  `pay${SEP}rate`,
  `desired${SEP}pay`,
  "consent",
  "ssn",
  `social${SEP}security\\w*`,
  `date${SEP}of${SEP}birth`,
  `birth${SEP}date`,
  "age",
);

// Values SECURITY.md §7 keeps out of the generic applicant profile in v1.
const RESTRICTED_FIELD_PATTERN = words(
  "ssn",
  `social${SEP}security\\w*`,
  `tax${SEP}id`,
  `passport${SEP}number`,
  `driver'?s?${SEP}licen[cs]e`,
  `national${SEP}id`,
  `bank${SEP}account\\w*`,
  `routing${SEP}number`,
  "iban",
  `credit${SEP}card\\w*`,
  `card${SEP}number`,
  `account${SEP}number`,
);

export function isCredentialLabel(value: string | undefined): boolean {
  return value !== undefined && CREDENTIAL_PATTERN.test(value);
}

export function isProtectedInferenceField(value: string): boolean {
  return PROTECTED_INFERENCE_PATTERN.test(value);
}

export function isRestrictedField(value: string): boolean {
  return RESTRICTED_FIELD_PATTERN.test(value);
}

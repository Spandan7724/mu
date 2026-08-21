import type { ApplicantFactSensitivity } from "../contracts/applicant.ts";

export type FactCategory =
  | "identity"
  | "contact"
  | "location"
  | "experience"
  | "availability"
  | "links"
  | "eligibility"
  | "compensation"
  | "demographic";

export interface CanonicalField {
  key: string;
  label: string;
  category: FactCategory;
  sensitivity: ApplicantFactSensitivity;
  aliases: readonly string[];
  // Concrete HTML input types that corroborate this field. Empty means no expectation.
  inputTypes: readonly string[];
  // Whether a value for this field may be read out of an untrusted document. Eligibility,
  // compensation and demographic answers are excluded by construction (BD15): a resume is
  // not an authorization to answer them.
  extractable: boolean;
  policyBacked: boolean;
}

// Labels, accessible names and snake_case form keys all reduce to the same shape here so a
// single alias table serves every naming source a page can offer.
export function normalizeFieldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function fieldTokens(value: string): string[] {
  const normalized = normalizeFieldName(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

export const CANONICAL_FIELDS: readonly CanonicalField[] = [
  {
    key: "full_name",
    label: "Full name",
    category: "identity",
    sensitivity: "personal",
    aliases: ["full name", "name", "your name", "applicant name", "legal name", "full legal name"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "first_name",
    label: "First name",
    category: "identity",
    sensitivity: "personal",
    aliases: ["first name", "given name", "forename"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "last_name",
    label: "Last name",
    category: "identity",
    sensitivity: "personal",
    aliases: ["last name", "family name", "surname"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "email",
    label: "Email address",
    category: "contact",
    sensitivity: "personal",
    aliases: ["email", "email address", "e mail", "contact email", "work email"],
    inputTypes: ["email", "text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "phone",
    label: "Phone number",
    category: "contact",
    sensitivity: "personal",
    aliases: ["phone", "phone number", "telephone", "telephone number", "mobile", "mobile number"],
    inputTypes: ["tel", "text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "city",
    label: "City",
    category: "location",
    sensitivity: "personal",
    aliases: ["city", "town", "city of residence", "current city"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "country",
    label: "Country",
    category: "location",
    sensitivity: "personal",
    aliases: ["country", "country of residence"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "postal_code",
    label: "Postal code",
    category: "location",
    sensitivity: "sensitive",
    aliases: ["postal code", "postcode", "zip", "zip code"],
    inputTypes: ["text"],
    extractable: false,
    policyBacked: false,
  },
  {
    key: "street_address",
    label: "Street address",
    category: "location",
    sensitivity: "sensitive",
    aliases: ["address", "street address", "address line 1", "home address", "mailing address"],
    inputTypes: ["text"],
    extractable: false,
    policyBacked: false,
  },
  {
    key: "current_title",
    label: "Current job title",
    category: "experience",
    sensitivity: "personal",
    aliases: ["current title", "job title", "current job title", "most recent title", "position"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "current_employer",
    label: "Current employer",
    category: "experience",
    sensitivity: "personal",
    aliases: ["current employer", "employer", "company", "most recent employer"],
    inputTypes: ["text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "years_experience",
    label: "Years of experience",
    category: "experience",
    sensitivity: "personal",
    aliases: ["years of experience", "years experience", "total years of experience", "experience"],
    inputTypes: ["number", "text"],
    // Derived from exact dates, never read off prose.
    extractable: false,
    policyBacked: false,
  },
  {
    key: "available_from",
    label: "Available from",
    category: "availability",
    sensitivity: "personal",
    aliases: ["available from", "availability", "start date", "earliest start date"],
    inputTypes: ["date", "text"],
    extractable: false,
    policyBacked: false,
  },
  {
    key: "notice_period",
    label: "Notice period",
    category: "availability",
    sensitivity: "personal",
    aliases: ["notice period", "notice"],
    inputTypes: ["text"],
    extractable: false,
    policyBacked: false,
  },
  {
    key: "portfolio_url",
    label: "Portfolio URL",
    category: "links",
    sensitivity: "public",
    aliases: ["portfolio", "portfolio url", "website", "personal website", "portfolio link"],
    inputTypes: ["url", "text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "linkedin_url",
    label: "LinkedIn URL",
    category: "links",
    sensitivity: "public",
    aliases: ["linkedin", "linkedin url", "linkedin profile"],
    inputTypes: ["url", "text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "github_url",
    label: "GitHub URL",
    category: "links",
    sensitivity: "public",
    aliases: ["github", "github url", "github profile"],
    inputTypes: ["url", "text"],
    extractable: true,
    policyBacked: false,
  },
  {
    key: "work_authorization",
    label: "Work authorization",
    category: "eligibility",
    sensitivity: "sensitive",
    aliases: [
      "work authorization",
      "work authorisation",
      "authorized to work",
      "authorised to work",
      "right to work",
      "employment eligibility",
      "legal status",
      "are you legally authorized to work",
    ],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "sponsorship",
    label: "Visa sponsorship",
    category: "eligibility",
    sensitivity: "sensitive",
    aliases: [
      "sponsorship",
      "needs sponsorship",
      "need sponsorship",
      "require sponsorship",
      "visa sponsorship",
      "will you require sponsorship",
      "do you require sponsorship",
    ],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "relocation",
    label: "Relocation",
    category: "eligibility",
    sensitivity: "personal",
    aliases: ["relocation", "open to relocation", "willing to relocate", "relocate"],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "desired_salary",
    label: "Desired salary",
    category: "compensation",
    sensitivity: "sensitive",
    aliases: [
      "desired salary",
      "desired annual salary",
      "expected salary",
      "salary expectation",
      "salary expectations",
      "expected compensation",
      "compensation expectation",
    ],
    inputTypes: ["number", "text"],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "gender",
    label: "Gender",
    category: "demographic",
    sensitivity: "sensitive",
    aliases: ["gender", "gender identity", "sex"],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "ethnicity",
    label: "Race or ethnicity",
    category: "demographic",
    sensitivity: "sensitive",
    aliases: ["ethnicity", "race", "race or ethnicity", "race ethnicity", "hispanic or latino"],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "veteran_status",
    label: "Veteran status",
    category: "demographic",
    sensitivity: "sensitive",
    aliases: ["veteran status", "protected veteran", "veteran", "military service"],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
  {
    key: "disability_status",
    label: "Disability status",
    category: "demographic",
    sensitivity: "sensitive",
    aliases: ["disability status", "disability", "do you have a disability"],
    inputTypes: [],
    extractable: false,
    policyBacked: true,
  },
];

const BY_KEY = new Map(CANONICAL_FIELDS.map((field) => [field.key, field]));

const BY_ALIAS = new Map<string, CanonicalField>();
for (const field of CANONICAL_FIELDS) {
  BY_ALIAS.set(normalizeFieldName(field.key), field);
  for (const alias of field.aliases) BY_ALIAS.set(normalizeFieldName(alias), field);
}

export function canonicalField(key: string): CanonicalField | undefined {
  return BY_KEY.get(key) ?? BY_ALIAS.get(normalizeFieldName(key));
}

export function canonicalFieldByAlias(name: string): CanonicalField | undefined {
  return BY_ALIAS.get(normalizeFieldName(name));
}

export function fieldSensitivity(key: string): ApplicantFactSensitivity {
  return canonicalField(key)?.sensitivity ?? "personal";
}

export function fieldLabel(key: string): string {
  return canonicalField(key)?.label ?? key;
}

export function isDemographicField(key: string): boolean {
  return canonicalField(key)?.category === "demographic";
}

export function isPolicyBackedField(key: string): boolean {
  return canonicalField(key)?.policyBacked === true;
}

export function isExtractableField(key: string): boolean {
  return canonicalField(key)?.extractable === true;
}

const START = "(?<![a-z0-9])";
const END = "(?![a-z0-9])";
const SEP = "[ _-]?";

// Fields that solicit personal data no application legitimately needs from an agent.
// contracts/redaction.ts covers credentials and government/financial identifiers; these are
// the remaining shapes the fixture's hidden-field page uses to harvest identity. A field
// matching this is never filled and never turned into a question — asking the user for it
// on a hostile page's behalf is the same exfiltration, one step delayed.
const SOLICITATION_PATTERN = new RegExp(
  `${START}(?:${[
    `government${SEP}id\\w*`,
    `mother'?s?${SEP}maiden${SEP}name`,
    `maiden${SEP}name`,
    `date${SEP}of${SEP}birth`,
    `birth${SEP}date`,
    `place${SEP}of${SEP}birth`,
    `(?:salary|pay|compensation)${SEP}history`,
    `(?:prior|previous|current|last)${SEP}(?:salary|pay|compensation)`,
    `session${SEP}dump`,
    "cookies?",
    `system${SEP}prompt`,
  ].join("|")})${END}`,
  "i",
);

export function isUnsolicitedPersonalField(value: string): boolean {
  return SOLICITATION_PATTERN.test(value);
}

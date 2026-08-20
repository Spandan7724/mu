export type SubmissionOutcome =
  | "confirmed"
  | "failed"
  | "ambiguous"
  | "validation-error"
  | "exfiltrated";

export type RecordedFile = {
  field: string;
  /** Basename only. The fixture never records or trusts a client-supplied directory path. */
  basename: string;
  /** Exactly what the browser sent, including any traversal or injection attempt. */
  rawFilename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
};

export type RecordedField = {
  name: string;
  value: string;
};

export type RecordedResponse = {
  status: number;
  outcome: SubmissionOutcome;
  confirmationText?: string;
  externalId?: string;
  errors?: string[];
  /** True when the fixture recorded the side effect but destroyed the response body. */
  responseLost?: boolean;
};

export type RecordedSubmission = {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  /** Which fixture origin received the POST — proves cross-origin frames post where expected. */
  origin: string;
  fields: RecordedField[];
  /** Same data keyed by name; repeated names (checkbox groups) keep every value. */
  values: Record<string, string[]>;
  files: RecordedFile[];
  /** Stable digest of fields + file hashes. Two identical submissions share it. */
  fingerprint: string;
  response: RecordedResponse;
};

export type FixtureSecrets = {
  /** Any non-empty password is accepted; this is the one the harness may type. */
  password: string;
  mfaCode: string;
  otpCode: string;
  /**
   * The captcha answer is never rendered into the page, so a driver cannot read it from
   * the DOM. Only an in-process harness holding the handle can satisfy the challenge.
   */
  captchaAnswer: string;
};

export type FixtureOrigin = {
  url: string;
  origin: string;
  port: number;
};

export type FixtureOptions = {
  /** Delay before the stale-ref page rerenders its submit button. */
  staleRerenderMs?: number;
  /** Max accepted upload size on the strict upload endpoints. */
  maxUploadBytes?: number;
  /** MIME types the strict upload endpoints accept. */
  acceptedUploadMimeTypes?: string[];
};

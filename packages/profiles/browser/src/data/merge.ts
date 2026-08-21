import type { ApplicantFact } from "../contracts/applicant.ts";
import { factValueText, sameFactValue } from "./facts.ts";

// BD15 precedence. An explicit answer given during this task outranks the saved profile,
// which outranks anything read out of a document — documents are the least trusted layer
// because their text is attacker-controlled.
export type FactLayer = "document" | "profile" | "answer";

export const FACT_LAYERS: readonly FactLayer[] = ["document", "profile", "answer"];

const RANK: Record<FactLayer, number> = { document: 0, profile: 1, answer: 2 };

const LAYER_NAME: Record<FactLayer, string> = {
  document: "an authorized document",
  profile: "your saved profile",
  answer: "your explicit answer",
};

export interface LayeredFact {
  layer: FactLayer;
  fact: ApplicantFact;
}

export type ResolutionStatus = "unique" | "override" | "conflict";

export interface FieldResolution {
  field: string;
  status: ResolutionStatus;
  // Absent exactly when status is "conflict": a disagreement is represented, never
  // resolved by picking the newest or the most confident side.
  winner?: ApplicantFact | undefined;
  layer?: FactLayer | undefined;
  candidates: LayeredFact[];
  superseded: LayeredFact[];
  disagreeing: LayeredFact[];
  reason: string;
}

function newest(candidates: readonly LayeredFact[]): LayeredFact {
  let best = candidates[0] as LayeredFact;
  for (const candidate of candidates) {
    if (candidate.fact.updatedAt > best.fact.updatedAt) best = candidate;
  }
  return best;
}

function describeValues(candidates: readonly LayeredFact[]): string {
  const seen: string[] = [];
  for (const candidate of candidates) {
    const text =
      candidate.fact.sensitivity === "sensitive"
        ? `${LAYER_NAME[candidate.layer]} has one value`
        : `${LAYER_NAME[candidate.layer]} says ${factValueText(candidate.fact.value)}`;
    if (!seen.includes(text)) seen.push(text);
  }
  return seen.join("; ");
}

function resolveField(field: string, candidates: LayeredFact[]): FieldResolution {
  const topRank = Math.max(...candidates.map((candidate) => RANK[candidate.layer]));
  const top = candidates.filter((candidate) => RANK[candidate.layer] === topRank);
  const head = top[0] as LayeredFact;
  const disagreeing = top.filter(
    (candidate) => !sameFactValue(candidate.fact.value, head.fact.value),
  );

  if (disagreeing.length > 0) {
    return {
      field,
      status: "conflict",
      candidates,
      superseded: [],
      disagreeing: top,
      reason: `${LAYER_NAME[head.layer]} disagrees with itself: ${describeValues(top)}`,
    };
  }

  const winnerEntry = newest(top);
  const lower = candidates.filter((candidate) => RANK[candidate.layer] < topRank);
  const superseded = lower.filter(
    (candidate) => !sameFactValue(candidate.fact.value, winnerEntry.fact.value),
  );

  if (superseded.length === 0) {
    return {
      field,
      status: "unique",
      winner: winnerEntry.fact,
      layer: winnerEntry.layer,
      candidates,
      superseded,
      disagreeing: [],
      reason: `${LAYER_NAME[winnerEntry.layer]} is the only source for this field`,
    };
  }
  return {
    field,
    status: "override",
    winner: winnerEntry.fact,
    layer: winnerEntry.layer,
    candidates,
    superseded,
    disagreeing: [],
    reason: `${LAYER_NAME[winnerEntry.layer]} overrides ${describeValues(superseded)}`,
  };
}

export function mergeFacts(layered: readonly LayeredFact[]): FieldResolution[] {
  const grouped = new Map<string, LayeredFact[]>();
  for (const entry of layered) {
    const existing = grouped.get(entry.fact.field);
    if (existing === undefined) grouped.set(entry.fact.field, [entry]);
    else existing.push(entry);
  }
  return [...grouped.entries()].map(([field, candidates]) => resolveField(field, candidates));
}

export function resolutionsByField(
  resolutions: readonly FieldResolution[],
): Map<string, FieldResolution> {
  return new Map(resolutions.map((resolution) => [resolution.field, resolution]));
}

export function conflictedFields(resolutions: readonly FieldResolution[]): FieldResolution[] {
  return resolutions.filter((resolution) => resolution.status === "conflict");
}

// A merged view usable as a FactLookup source: conflicts contribute nothing, so a
// contested field behaves exactly like a missing one and reaches the question queue.
export function resolvedFacts(resolutions: readonly FieldResolution[]): ApplicantFact[] {
  const facts: ApplicantFact[] = [];
  for (const resolution of resolutions) {
    if (resolution.winner !== undefined) facts.push(resolution.winner);
  }
  return facts;
}

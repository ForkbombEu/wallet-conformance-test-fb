// "CI_001: …" or the bracketed form "[CI_001]: …"
const REQUIREMENT_ID_PATTERN =
  /^(?:\[([A-Z]+[-_]\d+\w*)\]|([A-Z]+[-_]\d+\w*))\s*:/;

export function extractDescription(title: string): string {
  return title.replace(REQUIREMENT_ID_PATTERN, "").trim();
}

export function extractRequirementId(title: string): null | string {
  const match = REQUIREMENT_ID_PATTERN.exec(title);
  return match?.[1] ?? match?.[2] ?? null;
}

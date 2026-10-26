const REQUIREMENT_ID_PATTERN = /^([A-Z]+[-_]\d+\w*)\s*:/;

export function extractDescription(title: string): string {
  return title.replace(REQUIREMENT_ID_PATTERN, "").trim();
}

export function extractRequirementId(title: string): null | string {
  return REQUIREMENT_ID_PATTERN.exec(title)?.[1] ?? null;
}

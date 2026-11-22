// Changes to these keys require a backfill of existing applications.
const unreliableValues = new Set([
  "unknown",
  "unknown company",
  "unknown job title",
  "not specified",
  "not provided",
  "n a",
  "na",
  "none",
  "null",
  "confidential",
  "undisclosed",
  "company",
  "employer",
  "job title",
  "position",
  "role",
]);

const legalCompanySuffixes = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "plc",
]);

const normalizeWords = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

export const normalizeCompanyName = (
  value: string | null | undefined,
): string | null => {
  if (!value?.trim()) {
    return null;
  }
  const words = normalizeWords(value).split(" ");
  while (words.length && legalCompanySuffixes.has(words[words.length - 1])) {
    words.pop();
  }
  const normalized = words.join(" ");
  return normalized.length >= 2 && !unreliableValues.has(normalized)
    ? normalized
    : null;
};

export const normalizeJobTitle = (
  value: string | null | undefined,
): string | null => {
  if (!value?.trim()) {
    return null;
  }
  const normalized = normalizeWords(value);
  return normalized.length >= 2 && !unreliableValues.has(normalized)
    ? normalized
    : null;
};

export const getJobTitleMatchKey = (value: string): string =>
  normalizeWords(value).replace(/\s+(?:back\s+end|backend)$/, "");

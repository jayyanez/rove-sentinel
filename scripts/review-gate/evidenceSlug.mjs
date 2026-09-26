/** Stable directory name shared with consumers that produce visual evidence. */
export function branchEvidenceSlug(branch) {
  return String(branch || '').replace(/[^A-Za-z0-9._-]/gu, '-');
}

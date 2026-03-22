export const SCAN_FOCUS_OPTIONS = Object.freeze([
  { value: 'secrets_detection', label: 'Secrets detection' },
  { value: 'lockfile_hygiene', label: 'Lockfile hygiene' },
  { value: 'security_md_presence', label: 'SECURITY.md presence' },
  { value: 'repo_risk_signals', label: 'Repo risk signals' },
  { value: 'dependency_risk', label: 'Dependency risk' }
]);

const SCAN_FOCUS_VALUE_SET = new Set(SCAN_FOCUS_OPTIONS.map((option) => option.value));

export function normalizeScanFocusValues(scanFocus) {
  if (!Array.isArray(scanFocus)) {
    return [];
  }

  return [...new Set(scanFocus)]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => SCAN_FOCUS_VALUE_SET.has(value));
}

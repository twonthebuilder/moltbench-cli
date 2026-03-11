import { stat } from 'node:fs/promises';
import path from 'node:path';
import { BenchmarkAdapter } from '../AdapterInterface.mjs';
import { runProbes } from '../../services/ProbeEngine.mjs';


const OWASP_BY_PROBE_CATEGORY = {
  'exposed-secrets': 'ASI03',
  'security-docs': 'ASI09',
  'dependency-hygiene': 'ASI06'
};

const severityToResult = (severity) =>
  String(severity).toLowerCase() === 'info' ? 'pass' : 'fail';

export class SecretsAdapter extends BenchmarkAdapter {
  static id = 'secrets';
  static name = 'Secrets Scanner';
  static version = '1.0.0';
  static categories = ['ASI03', 'ASI06', 'ASI09'];
  static description = 'Regex-based static scanner for leaked credentials and hygiene checks.';

  async isAvailable() {
    return true;
  }

  async run(target, options = {}) {
    const startedAt = Date.now();
    const targetPath = path.resolve(String(target ?? '').trim());
    const stats = await stat(targetPath);

    if (!stats.isDirectory()) {
      throw new Error('SecretsAdapter target must be a directory path.');
    }

    const scan = await runProbes({ targetPath, ...options });

    return this.normalizeResult({
      duration: Date.now() - startedAt,
      findings: scan.findings.map((finding) => ({
        id: finding.id,
        probe: finding.title ?? finding.category ?? 'secrets-scan',
        category: OWASP_BY_PROBE_CATEGORY[finding.category] ?? 'ASI10',
        result: severityToResult(finding.severity),
        severity: String(finding.severity ?? 'medium').toLowerCase(),
        evidence: finding.evidenceSnippet ?? '',
        response: finding.file
          ? `Found in ${finding.file}${finding.line ? `:${finding.line}` : ''}`
          : 'N/A',
        explanation:
          finding.reason ?? 'Potential security issue discovered by static pattern matching.',
        raw: finding
      }))
    });
  }
}

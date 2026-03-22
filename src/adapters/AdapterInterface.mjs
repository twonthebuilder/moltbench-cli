const VALID_RESULTS = new Set(['pass', 'fail']);
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

export class BenchmarkAdapter {
  static id = 'adapter';
  static name = 'Benchmark Adapter';
  static version = '0.0.0';
  static categories = [];
  static description = '';

  constructor(options = {}) {
    this.options = options;
  }

  getMetadata() {
    const adapterClass = this.constructor;

    return {
      id: adapterClass.id,
      name: adapterClass.name,
      version: adapterClass.version,
      categories: adapterClass.categories,
      description: adapterClass.description
    };
  }

  async run() {
    throw new Error(`${this.constructor.name} must implement run(target, options).`);
  }

  async isAvailable() {
    return false;
  }

  normalizeResult({ duration = 0, findings = [] }) {
    return {
      adapter: this.getMetadata().id,
      duration,
      findings: findings.map((finding, index) => this.#normalizeFinding(finding, index))
    };
  }

  #normalizeFinding(finding = {}, index = 0) {
    const result = String(finding.result ?? 'fail').toLowerCase();
    const severity = String(finding.severity ?? 'medium').toLowerCase();

    return {
      id: finding.id ?? `${this.getMetadata().id}-finding-${index + 1}`,
      probe: String(finding.probe ?? 'unspecified_probe'),
      category: String(finding.category ?? 'ASI10'),
      result: VALID_RESULTS.has(result) ? result : 'fail',
      severity: VALID_SEVERITIES.has(severity) ? severity : 'medium',
      evidence: String(finding.evidence ?? ''),
      response: String(finding.response ?? ''),
      explanation: String(finding.explanation ?? ''),
      raw: finding.raw ?? {}
    };
  }
}

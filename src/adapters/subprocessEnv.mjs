/**
 * Builds a minimal, filtered environment object to pass to Python subprocesses.
 *
 * Passes only the standard system variables that Python tooling needs to run,
 * explicitly excluding MOLTBENCH_* variables (CLI-only config) and other
 * application-level secrets that have no business being forwarded to child
 * processes.
 */

const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'SYSTEMROOT', // Windows
  'HOMEDRIVE', // Windows
  'HOMEPATH', // Windows
  'USERPROFILE', // Windows
  'COMSPEC' // Windows
]);

/**
 * @param {NodeJS.ProcessEnv} env - The source environment (typically process.env)
 * @returns {Record<string, string>} A filtered copy safe to pass to child processes
 */
export function buildSubprocessEnv(env) {
  /** @type {Record<string, string>} */
  const filtered = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (typeof env[key] === 'string') {
      filtered[key] = env[key];
    }
  }
  return filtered;
}

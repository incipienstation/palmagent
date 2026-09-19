import { pathToFileURL } from 'node:url';

export function requireSuccessfulChecks(results, trusted) {
  if (typeof trusted !== 'boolean' || results?.scope?.result !== 'success') {
    throw new Error('CI scope validation did not succeed.');
  }
  const scope = results.scope.outputs;
  if (!scope || ['code', 'server', 'web', 'package'].some(key => !['true', 'false'].includes(scope[key]))) {
    throw new Error('CI scope outputs are incomplete or invalid.');
  }
  const selected = {
    tooling: scope.code === 'true',
    server: scope.server === 'true',
    web: scope.web === 'true' || (trusted && scope.package === 'true'),
  };
  for (const [lane, required] of Object.entries(selected)) {
    const result = results[lane]?.result;
    if (required ? result !== 'success' : !['success', 'skipped'].includes(result)) {
      throw new Error(`CI lane ${lane} did not satisfy its selected scope.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const trusted = process.env.TRUSTED_PR;
    if (!['true', 'false'].includes(trusted)) throw new Error('Missing CI trust classification.');
    requireSuccessfulChecks(JSON.parse(process.env.RESULTS), trusted === 'true');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

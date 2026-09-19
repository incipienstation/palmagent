import { appendFileSync } from 'node:fs';

// Timings contain phase names and outcomes only, never commands, credentials or
// error payloads. Observability failure must not change a publication outcome.
export function releaseTiming({ now = () => performance.now(), report = console.log, summaryFile } = {}) {
  let header = false;
  const emit = value => { try { report(JSON.stringify(value)); } catch {} };
  return async (phase, operation) => {
    const start = now();
    let status = 'failed';
    emit({ phase, status: 'started' });
    try {
      const result = await operation();
      status = 'success';
      return result;
    } finally {
      const durationMs = Math.max(0, Math.round(now() - start));
      emit({ phase, status, durationMs });
      if (summaryFile) {
        try {
          const title = header ? '' : '\n## Publication timings\n\n| Phase | Outcome | Seconds |\n| --- | --- | ---: |\n';
          appendFileSync(summaryFile, `${title}| ${phase} | ${status} | ${(durationMs / 1000).toFixed(3)} |\n`);
          header = true;
        } catch {}
      }
    }
  };
}

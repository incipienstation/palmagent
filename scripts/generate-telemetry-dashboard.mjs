// Importable dashboard definition; stdout is a Grafana provisioning artifact.
import { pathToFileURL } from 'node:url';
const datasource = { type: 'prometheus', uid: '$metricsStore' };
const custom = (name, values, selected) => ({ name, label: name, type: 'custom', query: values.join(','), current: { text: selected, value: selected } });
const release = name => ({ name, label: name, type: 'query', datasource,
  query: 'label_values(palmagent_operation_duration_seconds_count{telemetry_source="$source",service_name="$service"}, service_version)',
  refresh: 1, sort: 1, current: { text: 'Choose a release', value: '' } });
const cohort = 'telemetry_source="$source",service_name="$service",os_type="$os",host_arch="$arch",concurrency="$concurrency"';
const operation = `${cohort},operation="$operation"`;
const selection = side => `${operation},service_version="$${side}",runtime_implementation="$${side}Implementation"`;
const count = (side, outcome = true) => `sum(increase(palmagent_operation_duration_seconds_count{${selection(side)}${outcome ? ',outcome="$outcome"' : ''}}[$__range]))`;
const quantile = (side, percentile, minimum) =>
  `histogram_quantile(${percentile}, sum by (le) (increase(palmagent_operation_duration_seconds_bucket{${selection(side)},outcome="$outcome"}[$__range]))) and (${count(side)} >= ${minimum})`;
const panels = [];
function panel(title, unit, expressions, description, type = 'timeseries') {
  const id = panels.length + 1;
  panels.push({ id, title, description, type, datasource, gridPos: { x: (id - 1) % 2 * 12, y: Math.floor((id - 1) / 2) * 8, w: 12, h: 8 },
    targets: expressions.map(([legendFormat, expr], i) => ({ refId: String.fromCharCode(65 + i), expr, legendFormat })),
    fieldConfig: { defaults: { unit, min: 0 }, overrides: [] },
    options: { legend: { displayMode: 'table', placement: 'bottom' }, tooltip: { mode: 'multi' } } });
}
panel('Selected operation: p95 by release and implementation', 's', [['{{service_version}} {{runtime_implementation}}',
  `histogram_quantile(0.95, sum by (le, service_version, runtime_implementation) (rate(palmagent_operation_duration_seconds_bucket{${operation},outcome="$outcome"}[$__rate_interval])))`]],
  'Fixed component, operation, outcome, concurrency bucket, OS and architecture. Production cohorts can still differ in hardware and payload size.');
panel('Selected operation: observations per second', 'ops', [['{{service_version}} {{runtime_implementation}}',
  `sum by (service_version, runtime_implementation) (rate(palmagent_operation_duration_seconds_count{${operation},outcome="$outcome"}[$__rate_interval]))`]],
  'Observed workload volume, not maximum throughput or unique users.');
panel('Baseline / candidate: sample counts', 'short', ['baseline', 'candidate'].map(side => [side, count(side)]),
  'Counts across the selected time range. A client or collector outage can drop optional samples.', 'stat');
panel('Baseline / candidate: p50', 's', ['baseline', 'candidate'].map(side => [side, quantile(side, .5, 30)]),
  'Requires 30 observations per cohort. Select the same logical service and operation for both implementations.', 'stat');
panel('Baseline / candidate: p95', 's', ['baseline', 'candidate'].map(side => [side, quantile(side, .95, 100)]),
  'Requires 100 observations per cohort. Histogram estimates have 1 ms minimum boundary; use the local benchmark for sub-millisecond changes.', 'stat');
panel('Baseline / candidate: p99', 's', ['baseline', 'candidate'].map(side => [side, quantile(side, .99, 1000)]),
  'Requires 1000 observations per cohort. This is an observation guard, not a statistical significance test.', 'stat');
panel('Baseline / candidate: error fraction', 'percentunit', ['baseline', 'candidate'].map(side => [side,
  `sum(increase(palmagent_operation_duration_seconds_count{${selection(side)},outcome!="success"}[$__range])) / ${count(side, false)}`]),
  'Includes all outcomes regardless of the outcome filter. Missing errors remain no data until an error series exists.', 'stat');
for (const [title, name, unit] of [
  ['Process CPU p95 (one core = 1)', 'palmagent_process_cpu_utilization', 'percentunit'],
  ['Process resident memory p95', 'palmagent_process_memory_usage_bytes', 'bytes'],
  ['Node timer delay p95', 'palmagent_runtime_event_loop_delay_seconds', 's'],
]) panel(title, unit, [['{{service_version}} {{runtime_implementation}}',
  `histogram_quantile(0.95, sum by (le, service_version, runtime_implementation) (rate(${name}_bucket{${cohort}}[$__rate_interval])))`]],
  'Self process only; provider and shell children excluded. Load is sampled at observation time. Node timer delay has no Rust equivalent.');
panel('SQLite busy retries per second', 'ops', [['{{service_version}} {{runtime_implementation}}',
  `sum by (service_version, runtime_implementation) (rate(palmagent_storage_busy_retries_total{${cohort}}[$__rate_interval]))`]],
  'Execution persistence retries only. No series means unavailable or no observed retries, not proof of zero contention.');

export const dashboard = {
  uid: 'palmagent-migration', title: 'Palmagent migration performance', schemaVersion: 40, version: 1, editable: false,
  tags: ['palmagent', 'performance'], timezone: 'browser', refresh: '30s', time: { from: 'now-24h', to: 'now' },
  templating: { list: [
    { name: 'metricsStore', label: 'Retention store', type: 'datasource', query: 'prometheus',
      regex: '/^Palmagent telemetry/', current: { text: 'Palmagent telemetry', value: 'palmagent-prometheus' }, refresh: 1 },
    custom('source', ['production', 'synthetic'], 'production'),
    custom('service', ['palmagent.web', 'palmagent.daemon', 'palmagent.execution', 'palmagent.terminal'], 'palmagent.web'),
    custom('operation', ['http.tasks.read', 'http.tasks.write', 'http.spaces.read', 'http.routines.read', 'http.terminals.read', 'http.health', 'http.request',
      'event.deliver', 'storage.write', 'storage.queue', 'execution.start', 'terminal.start', 'daemon.list', 'daemon.inspect', 'daemon.launch', 'daemon.terminate', 'daemon.restart', 'daemon.request'], 'http.tasks.read'),
    custom('outcome', ['success', 'error', 'timeout'], 'success'),
    custom('os', ['linux', 'darwin', 'windows'], 'linux'), custom('arch', ['amd64', 'arm64'], 'amd64'),
    custom('concurrency', ['0', '1', '2-4', '5-8', '9-16', '17+'], '1'),
    release('baseline'), custom('baselineImplementation', ['node', 'rust'], 'node'),
    release('candidate'), custom('candidateImplementation', ['node', 'rust'], 'node'),
  ] }, panels,
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(dashboard, null, 2));

const sourceRoot = 'apps/server/src/';
const features = new Set(['tasks', 'spaces', 'routines', 'terminals', 'auth', 'agents', 'installation']);

export function serverLocation(path) {
  if (!path?.startsWith(sourceRoot)) return undefined;
  const relative = path.slice(sourceRoot.length);
  const [area, feature, ...parts] = relative.split('/');
  if (['kernel', 'platform', 'composition', 'bootstrap'].includes(area) && feature) return { area };
  if (area !== 'modules' || !features.has(feature)) return { area: 'unknown' };
  const rest = parts.join('/');
  if (rest === 'api.ts') return { area: 'api', feature };
  if (rest === 'composition.ts') return { area: 'composition', feature };
  for (const layer of ['domain', 'application/ports/inbound', 'application/ports/outbound', 'application/use-cases', 'application/attachments', 'adapters/inbound', 'adapters/outbound']) {
    if (rest.startsWith(layer + '/')) return { area: layer, feature };
  }
  return { area: 'unknown', feature };
}
const core = location => location && (location.area === 'kernel' || location.area === 'domain' || location.area.startsWith('application/'));

/** Applied to static imports, type imports, re-exports, require and dynamic import alike. */
export function serverDependency(source, target, specifier, typeOnly = false) {
  const from = serverLocation(source), to = serverLocation(target);
  if (!from) return;
  if (from.area === 'unknown') return 'unclassified server source';
  if (to?.area === 'unknown') return 'dependency has an unclassified server location';
  const shared = target?.startsWith('packages/shared/src/') || specifier.startsWith('@palmagent/shared');
  if (from.area === 'api') {
    if (!typeOnly || !to || to.feature !== from.feature || !['domain', 'application/ports/inbound'].includes(to.area)) return 'public API may only export selected inbound contracts and neutral types';
    return;
  }
  if (from.area === 'composition' || from.area === 'bootstrap') return;
  if (to && ['composition', 'bootstrap'].includes(to.area)) return 'inner code cannot import runtime assembly or entrypoints';
  if (from.area === 'kernel' && !shared && to?.area !== 'kernel') return 'kernel must remain portable and feature-independent';
  if (from.area === 'platform' && to?.feature) return 'platform cannot depend on feature code';
  if (from.feature && to?.feature && from.feature !== to.feature && to.area !== 'api') return 'cross-feature dependency must use the public API or an injected consumer port';
  if (core(from)) {
    if (!shared && !(to && (core(to) || to.area === 'api'))) return 'core imports an outer technology or implementation';
    if (from.area === 'domain' && to && !['domain', 'kernel'].includes(to.area)) return 'domain cannot depend on application code';
    if (from.area.startsWith('application/ports/') && to?.area.startsWith('application/') && !to.area.startsWith('application/ports/')) return 'port cannot derive its contract from a use-case implementation';
  }
  if (from.area === 'adapters/inbound' && to && (to.area === 'adapters/outbound' || to.area === 'application/use-cases')) return 'inbound adapter must invoke input contracts rather than construct implementations';
}

export function dependencyCycles(edges) {
  const graph = new Map();
  for (const [from, to] of edges) {
    if (from === to) continue;
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  }
  const done = new Set(), visiting = new Set(), stack = [], cycles = [];
  function visit(node) {
    if (visiting.has(node)) { cycles.push([...stack.slice(stack.indexOf(node)), node]); return; }
    if (done.has(node)) return;
    visiting.add(node); stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop(); visiting.delete(node); done.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return cycles;
}

/** Enumerate syntax forms that can hide type-only or runtime dependencies. */
export function moduleReferences(ts, source) {
  const references = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const allNamedTypes = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly) &&
        (!ts.isImportDeclaration(node) || !node.importClause?.name);
      references.push({ node, specifier: node.moduleSpecifier, typeOnly: Boolean(node.isTypeOnly || node.importClause?.isTypeOnly || allNamedTypes) });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) references.push({ node, specifier: node.argument.literal, typeOnly: true });
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) references.push({ node, specifier: node.moduleReference.expression, typeOnly: node.isTypeOnly });
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) references.push({ node, specifier, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

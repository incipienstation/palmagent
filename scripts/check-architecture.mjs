import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { serverLocation, serverDependency, dependencyCycles, moduleReferences } from "./lib/architecture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if ([".ts", ".tsx"].includes(extname(path))) found.push(path);
  }
  return found;
}
const isShared = name => name?.startsWith("packages/shared/src/");
const edges = [], featureEdges = [];
let inspected = 0;
for (const packageDir of ["apps/server", "apps/web", "packages/shared"]) {
  const configPath = join(root, packageDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(`Cannot read ${packageDir}/tsconfig.json`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  if (parsed.errors.length) throw new Error(`Cannot resolve ${packageDir}/tsconfig.json`);
  for (const path of await files(join(root, packageDir, "src"))) {
    inspected++;
    const name = relative(root, path);
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    const report = (node, message) => failures.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
    const view = /^apps\/web\/src\/(components|auth)\//.test(name) && !name.endsWith("/useSignOut.ts");
    if (serverLocation(name)?.area === "unknown") report(source, "unclassified server source");
    function inspectImport(node, specifier, typeOnly) {
      const module = specifier.text;
      const resolved = ts.resolveModuleName(module, path, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
      const target = resolved ? relative(root, resolved) : undefined;
      const shared = isShared(target);
      const violation = serverDependency(name, target, module, typeOnly);
      if (violation) report(node, violation + `: ${module}`);
      if (serverLocation(name) && serverLocation(target)) {
        edges.push([name, target]);
        const from = serverLocation(name)?.feature, to = serverLocation(target)?.feature;
        if (from && to && from !== to) featureEdges.push([from, to]);
      }
      if (isShared(name) && !shared && module !== "zod" && !module.startsWith("zod/") && !target?.endsWith(".json")) {
        report(node, `shared contracts import nonportable dependency ${module}`);
      }
      if (isShared(name) && target?.startsWith("apps/")) report(node, `shared contracts import application ${module}`);
      if (view && (target === "apps/web/src/api.ts" || target === "apps/web/src/api-client.ts")) {
        const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined;
        const namedApi = bindings && ts.isNamedImports(bindings) && bindings.elements.some(e => (e.propertyName ?? e.name).text === "api");
        if (target.endsWith("api-client.ts") || !ts.isImportDeclaration(node) || !bindings || ts.isNamespaceImport(bindings) || namedApi) {
          report(node, "view imports the HTTP client; use a feature operation hook");
        }
      }
    }
    for (const reference of moduleReferences(ts, source)) inspectImport(reference.node, reference.specifier, reference.typeOnly);
    const location = serverLocation(name);
    const core = location && (location.area === "kernel" || location.area === "domain" || location.area.startsWith("application/"));
    function visit(node) {
      if (core && ts.isIdentifier(node) && ["process", "Buffer", "fetch", "XMLHttpRequest", "WebSocket"].includes(node.text)) report(node, `core uses host global ${node.text}; inject a port`);
      if (ts.isCallExpression(node)) {
        if (core && node.expression.kind === ts.SyntaxKind.ImportKeyword && !ts.isStringLiteralLike(node.arguments[0])) report(node, "core has a dynamic dependency that cannot be checked");
        if (view && ts.isIdentifier(node.expression) && node.expression.text === "fetch") report(node, "view calls fetch directly; use a feature operation hook");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
for (const cycle of dependencyCycles(edges)) failures.push(`source cycle: ${cycle.join(" -> ")}`);
for (const cycle of dependencyCycles(featureEdges)) failures.push(`feature cycle: ${cycle.join(" -> ")}`);
if (failures.length) {
  console.error(`Architecture boundary check failed (${failures.length}):\n${failures.map(f => `- ${f}`).join("\n")}`);
  process.exitCode = 1;
} else console.log(`Declared architecture boundaries passed (${inspected} source files inspected).`);

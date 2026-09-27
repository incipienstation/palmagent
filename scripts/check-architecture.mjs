import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
const core = new Set(["service.ts", "routines.ts", "message-controller.ts", "cron.ts", "errors.ts", "types.ts"]);
const isCore = name => name.startsWith("apps/server/src/application/") ||
  (name.startsWith("apps/server/src/") && core.has(name.slice("apps/server/src/".length)));
const isShared = name => name?.startsWith("packages/shared/src/");
// These coordinators intentionally own platform integrations; keep their exceptions explicit.
const coordinators = {
  "apps/server/src/auth.ts": new Set(["node:crypto", "@simplewebauthn/server", "apps/server/src/config.ts"]),
  "apps/server/src/terminal/service.ts": new Set(["node:fs", "node:path", "apps/server/src/terminal/store.ts", "apps/server/src/terminal/platform.ts", "apps/server/src/private-files.ts"]),
};
const persistence = /(?:^|\/)(?:db|attachments|native-session|paths|worktree|runtime|terminal\/store)(?:\.ts)?$/;
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
    const route = name.startsWith("apps/server/src/http/") || name === "apps/server/src/local/app.ts" || name === "apps/server/src/terminal/gateway.ts";
    function inspectImport(node, specifier) {
      const module = specifier.text;
      const resolved = ts.resolveModuleName(module, path, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
      const target = resolved ? relative(root, resolved) : undefined;
      const shared = isShared(target);
      if (isCore(name)) {
        const crypto = module === "node:crypto" && ["apps/server/src/application/skill-id.ts", "apps/server/src/message-controller.ts"].includes(name);
        if (!shared && !crypto && !(target && isCore(target))) report(node, `application code imports outer dependency ${module}`);
      }
      if (coordinators[name] && !shared && !(target && isCore(target)) && !coordinators[name].has(target) && !coordinators[name].has(module)) {
        report(node, `coordinator imports undeclared dependency ${module}`);
      }
      if (route && target && persistence.test(target)) report(node, `transport adapter imports persistence or host implementation ${module}`);
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
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) inspectImport(node, node.moduleSpecifier);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) inspectImport(node, node.argument.literal);
      if (ts.isCallExpression(node)) {
        const first = node.arguments[0];
        if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && first && ts.isStringLiteral(first)) inspectImport(node, first);
        if (view && ts.isIdentifier(node.expression) && node.expression.text === "fetch") report(node, "view calls fetch directly; use a feature operation hook");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
if (failures.length) {
  console.error(`Architecture boundary check failed (${failures.length}):\n${failures.map(f => `- ${f}`).join("\n")}`);
  process.exitCode = 1;
} else console.log(`Declared architecture boundaries passed (${inspected} source files inspected).`);

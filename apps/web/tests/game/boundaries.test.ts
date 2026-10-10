import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const game = new URL("../../src/games/scrap-survivor/", import.meta.url);
function imports(file: URL) {
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const dependencies: string[] = [];
  const walk = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) dependencies.push(node.arguments[0].text);
    ts.forEachChild(node, walk);
  };
  walk(source); return dependencies;
}
test("rules import only other rules; game modules do not depend on Palmagent host state", () => {
  const rules = new URL("rules/", game);
  for (const name of readdirSync(rules)) {
    const file = new URL(name, rules);
    for (const dependency of imports(file)) assert.ok(dependency.startsWith("./"), `${name}: ${dependency}`);
    assert.doesNotMatch(readFileSync(file, "utf8"), /\b(?:window|document|localStorage|sessionStorage|Phaser)\b/);
  }
  for (const name of readdirSync(game).filter(n => /\.tsx?$/.test(n))) {
    for (const dependency of imports(new URL(name, game))) {
      assert.ok(!dependency.startsWith("@palmagent/") && !dependency.includes("/hooks/") && !dependency.includes("play-events") && !dependency.includes("survivor-storage"), `${name}: ${dependency}`);
    }
  }
  for (const name of ["SurvivorSheet.tsx", "survivor-storage.ts", "play-events.ts"]) {
    for (const dependency of imports(new URL(`../${name}`, game))) {
      if (dependency.includes("scrap-survivor/")) assert.equal(dependency, "./scrap-survivor/api");
    }
  }
});

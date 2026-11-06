import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';

function resolveDependency(name, from) {
  const require = createRequire(join(from, 'package.json'));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw new Error(`Locked runtime dependency is not installed: ${name}`);
}

/** Materialize the already frozen pnpm graph using ordinary nested node_modules.
 * Never resolve versions through a registry or carry workspace symlinks into an archive.
 */
export function copyRuntimeDependencies(names, from, destination) {
  let count = 0;
  const sources = new Map(names.map(name => [name, resolveDependency(name, from)]));
  const graph = new Map();
  const variants = new Map();
  function visit(name, source) {
    if (graph.has(source)) return;
    if (graph.size >= 3000) throw new Error('Runtime dependency graph is unexpectedly large');
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (pkg.name !== name || typeof pkg.version !== 'string') throw new Error('Invalid locked dependency identity');
    const dependencies = new Map();
    graph.set(source, dependencies);
    if (!variants.has(name)) variants.set(name, new Set());
    variants.get(name).add(source);
    for (const dependency of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])) {
      let dependencySource;
      try { dependencySource = resolveDependency(dependency, source); }
      catch (error) {
        if (Object.hasOwn(pkg.optionalDependencies ?? {}, dependency) || pkg.peerDependenciesMeta?.[dependency]?.optional) continue;
        throw error;
      }
      dependencies.set(dependency, dependencySource);
      visit(dependency, dependencySource);
    }
  }
  for (const [name, source] of sources) visit(name, source);
  // Hoist single-identity dependencies once. Duplicating a shared package in
  // sibling subtrees splits module state (for example ASN.1 schema registries).
  // Conflicting versions remain nested and resolve against their own ancestors.
  const hoisted = new Map([...variants].filter(([, values]) => values.size === 1).map(([name, values]) => [name, [...values][0]]));
  for (const [name, source] of sources) hoisted.set(name, source);
  function copy(name, source, target, ancestors) {
    if (++count > 3000) throw new Error('Runtime dependency graph is unexpectedly large');
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (pkg.name !== name || typeof pkg.version !== 'string') throw new Error('Invalid locked dependency identity');
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: true, filter(path) {
      const rel = relative(source, path);
      if (rel.split(sep).some(part => ['node_modules', '.git', '.cache'].includes(part))) return false;
      // Keep native runtime products, not compiler intermediates or Python links.
      if (['better-sqlite3', 'node-pty'].includes(name) && rel.startsWith(`build${sep}`) &&
          rel !== `build${sep}Release` && !/^build\/Release\/[^/]+\.(?:node|so)$/.test(rel) && rel !== 'build/Release/spawn-helper') return false;
      if (lstatSync(path).isSymbolicLink() && !realpathSync(path).startsWith(source + sep))
        throw new Error(`Runtime dependency has an external file link: ${name}`);
      return true;
    } });
    const available = new Map(ancestors); available.set(name, source);
    for (const [dependency, dependencySource] of graph.get(source)) {
      if (available.get(dependency) === dependencySource) continue;
      copy(dependency, dependencySource, join(target, 'node_modules', dependency), available);
    }
  }
  mkdirSync(destination, { recursive: true });
  for (const [name, source] of hoisted) copy(name, source, join(destination, name), hoisted);
  return Object.fromEntries([...sources].map(([name, source]) => [name, JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version]));
}

export function filesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Portable bundle contains a special file: ${basename(path)}`);
  }
  return files;
}

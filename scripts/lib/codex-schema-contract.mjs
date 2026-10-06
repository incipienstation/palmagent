import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { protocolContracts, responseContracts } from './codex-protocol-contract.mjs';
export { protocolContracts } from './codex-protocol-contract.mjs';

const annotation = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', 'deprecated', 'definitions', '$defs']);

export function projectSchema(schema, mask = true, root = schema, stack = [], direction = 'out') {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object') throw new Error('Missing schema node');
  if (schema.$ref) {
    const ref = schema.$ref;
    if (!ref.startsWith('#/')) throw new Error('Only local schema references are supported');
    if (stack.includes(ref)) return { $recursiveRef: ref };
    const target = ref.slice(2).split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    return projectSchema(target, mask, root, [...stack, ref], direction);
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (annotation.has(key)) continue;
    if (key === 'properties') {
      const selected = mask === true ? Object.keys(value) : Object.keys(mask).filter(name => !name.startsWith('$'));
      result.properties = {};
      for (const name of selected) {
        if (!(name in value)) throw new Error(`Missing consumed property: ${name}`);
        result.properties[name] = projectSchema(value[name], mask === true ? true : mask[name], root, stack, direction);
      }
    } else if (key === 'required') {
      result.required = direction === 'out' || mask === true ? value : value.filter(name => name in mask);
    } else if (['anyOf', 'oneOf', 'allOf'].includes(key)) {
      let variants = value;
      if (mask !== true && mask.$variants) {
        variants = Object.keys(mask.$variants).map(type => {
          const found = value.find(part => part.properties?.type?.enum?.includes(type));
          if (!found) throw new Error(`Missing consumed variant: ${type}`);
          return found;
        });
      }
      result[key] = variants.map(part => projectSchema(part,
        mask !== true && mask.$variants ? mask.$variants[part.properties.type.enum[0]] : mask, root, stack, direction));
    } else if (key === 'items') {
      result.items = projectSchema(value, mask === true ? true : mask.$items ?? true, root, stack, direction);
    } else if (key === 'additionalProperties' && typeof value === 'object') {
      result[key] = projectSchema(value, true, root, stack, direction);
    } else result[key] = value;
  }
  return result;
}

// Conservative structural compatibility, not a general JSON Schema theorem
// prover. Unknown constraint changes fail closed; ordering/docs are ignored.
export function schemaDifferences(before, after, direction = 'out', path = '$') {
  const issues = [];
  const fail = reason => issues.push(`${path}: ${reason}`);
  if (typeof before === 'boolean' || typeof after === 'boolean') {
    if (before !== after) fail('boolean schema changed');
    return issues;
  }
  const subset = (a = [], b = []) => a.every(value => b.some(other => isDeepStrictEqual(value, other)));
  const narrow = direction === 'out' ? before : after;
  const wide = direction === 'out' ? after : before;
  const types = value => value === undefined ? undefined : Array.isArray(value) ? value : [value];
  if (wide.type && (!narrow.type || !subset(types(narrow.type), types(wide.type)))) fail('type changed incompatibly');
  if (wide.enum && (!narrow.enum || !subset(narrow.enum, wide.enum))) fail('enum changed incompatibly');
  if (!subset(wide.required, narrow.required)) fail('required fields changed incompatibly');
  for (const [key, value] of Object.entries(before.properties ?? {})) {
    if (!Object.hasOwn(after.properties ?? {}, key)) fail(`removed field ${key}`);
    else issues.push(...schemaDifferences(value, after.properties[key], direction, `${path}.${key}`));
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (!before[key] && !after[key]) continue;
    if (!before[key] || !after[key]) { fail(`${key} structure changed`); continue; }
    for (const variant of narrow[key]) {
      if (!wide[key].some(other => (direction === 'out'
        ? schemaDifferences(variant, other, direction) : schemaDifferences(other, variant, direction)).length === 0)) {
        fail(`${key} has an incompatible variant`);
      }
    }
  }
  if (before.items && after.items) issues.push(...schemaDifferences(before.items, after.items, direction, `${path}[]`));
  else if (before.items || after.items) fail('array item schema changed');
  const known = new Set(['type', 'enum', 'required', 'properties', 'anyOf', 'oneOf', 'items']);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!known.has(key) && !isDeepStrictEqual(before[key], after[key])) fail(`${key} constraint changed`);
  }
  return [...new Set(issues)];
}

export function readProtocolContract(directory) {
  const read = name => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
  const contracts = {};
  for (const [name, direction, methods] of protocolContracts) {
    const root = read(name);
    for (const [method, params] of Object.entries(methods)) {
      const entry = root.oneOf?.find(part => part.properties?.method?.enum?.includes(method));
      if (!entry) throw new Error(`Missing method: ${method}`);
      const mask = { method: true, ...(name.endsWith('Request') ? { id: true } : {}), ...(params === null ? {} : { params }) };
      contracts[`${name}:${method}`] = { direction, schema: projectSchema(entry, mask, root, [], direction) };
    }
  }
  for (const [name, mask] of Object.entries(responseContracts)) {
    const root = read(name);
    contracts[name] = { direction: 'in', schema: projectSchema(root, mask, root, [], 'in') };
  }
  for (const name of ['CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse', 'ToolRequestUserInputResponse']) {
    const root = read(name);
    contracts[name] = { direction: 'out', schema: projectSchema(root) };
  }
  return contracts;
}

export function compareProtocolContracts(before, after) {
  return Object.entries(before).flatMap(([key, value]) => after[key]
    ? schemaDifferences(value.schema, after[key].schema, value.direction, key)
    : [`Missing contract: ${key}`]);
}

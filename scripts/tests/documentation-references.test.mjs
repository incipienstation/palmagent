import assert from 'node:assert/strict';
import test from 'node:test';
import { documentationReferenceLines, documentationReferencePatterns } from '../lib/documentation-references.mjs';

test('public documentation flags product comparisons at their original lines', () => {
  const text = [
    '# Interaction design', '',
    'The composer is styled', 'after ExampleProduct.',
    'An ExampleProduct-style interface.',
    'Similar to [ExampleProduct](https://example.invalid).',
    'ExampleProduct처럼 보이는 화면.',
  ].join('\r\n');
  assert.deepEqual(documentationReferenceLines(text, documentationReferencePatterns()), [3, 5, 6, 7]);
});

test('integration instructions, source credits and ordinary technical prose are allowed', () => {
  const text = [
    'Install ExampleTool to enable its adapter.',
    'This component is provided by ExampleTool under the MIT license.',
    'Work in a clone of the repository. The control works like a switch.',
    'The saved query looks similar to the previous query.',
  ].join('\n');
  assert.deepEqual(documentationReferenceLines(text, documentationReferencePatterns()), []);
});

test('configured names match literal words, model versions and wrapped names', () => {
  const patterns = documentationReferencePatterns('Sample+Tool\nSample Name\n');
  const text = 'Sample+Tool-2\nExtrasample+tooling\nSAMPLE\nName\n[Sample+Tool](#usage)';
  assert.deepEqual(documentationReferenceLines(text, patterns), [1, 3, 5]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchRegExp, findMatches, replaceMatches } from '../src/renderer/core/search.mjs';

test('finds literal matches with Unicode-aware word boundaries', () => {
  const matches = findMatches('One cat, catalog and Cat.', 'cat', { caseSensitive: false, wholeWord: true });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].text, 'cat');
  assert.equal(matches[1].text, 'Cat');
});

test('supports regular expressions and capture replacements', () => {
  const result = replaceMatches('id="a1" id="b2"', 'id="([a-z])(\\d)"', 'data-key="$1$2"', { regex: true });
  assert.equal(result.count, 2);
  assert.equal(result.text, 'data-key="a1" data-key="b2"');
});

test('reports invalid expressions', () => {
  assert.throws(() => buildSearchRegExp('(', { regex: true }), /Invalid regular expression/);
});

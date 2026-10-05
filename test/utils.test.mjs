import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  buildHeadingHierarchy,
  dirname,
  extension,
  formatCss,
  formatMarkup,
  isMinifiedMarkup,
  joinPath,
  normalizePath,
  relativeHref,
  resolveHref,
  uniqueId,
} from '../src/renderer/core/utils.mjs';

test('normalizes archive paths without escaping root', () => {
  assert.equal(normalizePath('/OEBPS/Text/../Text/chapter.xhtml'), 'OEBPS/Text/chapter.xhtml');
  assert.equal(normalizePath('../../META-INF/container.xml'), 'META-INF/container.xml');
  assert.equal(joinPath('OEBPS', 'Text', './chapter.xhtml'), 'OEBPS/Text/chapter.xhtml');
});

test('resolves and creates relative EPUB hrefs', () => {
  assert.deepEqual(resolveHref('OEBPS/Text/chapter.xhtml', '../Styles/base.css?v=2#top'), {
    path: 'OEBPS/Styles/base.css', hash: 'top', query: 'v=2', external: false,
  });
  assert.equal(relativeHref('OEBPS/Text/chapter.xhtml', 'OEBPS/Styles/base.css'), '../Styles/base.css');
  assert.equal(relativeHref('OEBPS/nav.xhtml', 'OEBPS/Text/ch1.xhtml', 'intro'), 'Text/ch1.xhtml#intro');
});

test('extracts path pieces', () => {
  assert.equal(dirname('OEBPS/Text/chapter.xhtml'), 'OEBPS/Text');
  assert.equal(basename('OEBPS/Text/chapter.xhtml'), 'chapter.xhtml');
  assert.equal(extension('OEBPS/Text/chapter.XHTML'), 'xhtml');
});

test('formats CSS and markup deterministically', () => {
  assert.match(formatCss('body{color:red;margin:0}'), /body \{/);
  const source = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Title</title></head><body><section id="s"><h1>Chapter <em>One</em></h1><p>Hello <strong>world</strong>.</p></section></body></html>';
  assert.equal(formatMarkup(source), `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Title</title>
  </head>
  <body>
    <section id="s">
      <h1>Chapter <em>One</em></h1>
      <p>Hello <strong>world</strong>.</p>
    </section>
  </body>
</html>`);
  assert.equal(isMinifiedMarkup(source), true);
  assert.equal(isMinifiedMarkup(formatMarkup(source)), false);
  assert.equal(isMinifiedMarkup('<html><body><p>one</p><p>two</p><pre>a\nb</pre></body></html>'), true);
  const packedTemplate = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>New chapter</title></head>
<body><section><h1>New chapter</h1><p></p></section></body>
</html>`;
  assert.equal(isMinifiedMarkup(packedTemplate), true);
  assert.equal(isMinifiedMarkup(formatMarkup(packedTemplate)), false);
});

test('markup formatting preserves significant raw content', () => {
  const source = '<!DOCTYPE html><!-- a > b --><html><body><pre>  one\n    two &amp; three</pre><p>Use <code> a  b </code>.</p><textarea>keep\n  this</textarea></body></html>';
  const formatted = formatMarkup(source);
  assert.match(formatted, /<!DOCTYPE html>\n<!-- a > b -->/);
  assert.match(formatted, /<pre>  one\n    two &amp; three<\/pre>/);
  assert.match(formatted, /<p>Use <code> a  b <\/code>.<\/p>/);
  assert.match(formatted, /<textarea>keep\n  this<\/textarea>/);
});

test('creates collision-free ids', () => {
  assert.equal(uniqueId(['chapter'], 'chapter'), 'chapter-2');
  assert.equal(uniqueId(['chapter', 'chapter-2'], 'chapter'), 'chapter-3');
});

test('builds a heading hierarchy while tolerating skipped levels', () => {
  const tree = buildHeadingHierarchy([
    { label: 'Part', level: 1 },
    { label: 'Chapter', level: 3 },
    { label: 'Section', level: 2 },
    { label: 'Next part', level: 1 },
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].label, 'Part');
  assert.equal(tree[0].children[0].label, 'Chapter');
  assert.equal(tree[0].children[1].label, 'Section');
  assert.equal(tree[1].label, 'Next part');
});

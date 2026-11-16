import { expect, it } from 'vitest';
import { sessionImageIndex } from '../src/image-index.js';
import type { ProjectedEvent } from '../src/types.js';
const event = (seq: number, extra: Partial<ProjectedEvent>): ProjectedEvent => ({ key: `event-${seq}`, seq, kind: 'message', role: 'assistant', recordedAt: '', source: 'history', parserVersion: 'test', availability: 'recorded', ...extra });

it('indexes generated images, attachments, viewed images and file links across all event types, keeping source occurrences', () => {
  const events = [
    event(1, { attachments: [{ attachmentId: 'upload', originalName: '上传.jpg' } as any], text: '首条消息' }),
    event(2, { kind: 'image', image: { path: '/generated/a.png', status: 'completed' }, text: '[生成图](/generated/a.png)' }),
    event(3, { text: '[有空格](<./images/a b.png>) ![编码图](images/%E4%B8%AD%E6%96%87.webp) `/tmp/c.jpg` /tmp/d.gif， [报告](/tmp/report.pdf) https://remote.test/private.png' }),
    event(4, { kind: 'tool', tool: { name: 'view', input: '{"path":"/tmp/tool.png"}', output: '/tmp/output.webp' } }),
    event(5, { kind: 'notice', image: { path: '/tmp/viewed.jpg', status: 'completed' } }),
    event(6, { text: '[再次引用](/generated/a.png)' }),
    event(7, { kind: 'image', image: { path: '/generated/pending.png', status: 'inProgress' } })
  ];
  const index = sessionImageIndex(events);
  expect(index.items.map(i => i.name)).toEqual(['上传.jpg', 'a.png', 'a b.png', '中文.webp', 'c.jpg', 'd.gif', 'tool.png', 'output.webp', 'viewed.jpg', 'a.png']);
  expect(index.items[1]).toMatchObject({ kind: 'generated', key: 'event-2', seq: 2 });
  expect(index.items[2].path).toBe('images/a b.png');
  expect(index.items.at(-1)?.id).not.toBe(index.items[1].id);
  expect(new Set(index.items.map(i => i.id)).size).toBe(index.items.length);
  expect(JSON.stringify(index)).not.toContain('首条消息');
  expect(index).toMatchObject({ firstSeq: 1, lastSeq: 7 });
});
it('does not turn remote URLs, non-images or malformed file URLs into local image resources', () => {
  const result = sessionImageIndex([event(1, { text: '![远程](https://example.test/a.png) https://host.test/b.jpg `javascript:x.png` [坏链接](file://[invalid]/a.png) [PDF](/tmp/a.pdf) [空字节](/tmp/a%00.png)' })]);
  expect(result.items).toEqual([]);
});

it('deduplicates file URL and normalized Markdown aliases only within the same source message', () => {
  const result = sessionImageIndex([event(1, { text: '[A](file:///tmp/a%20b.png) [B](</tmp/./a b.png>)' }), event(2, { text: '[C](</tmp/a b.png>)' })]);
  expect(result.items.map(i => [i.seq, i.path])).toEqual([[1, '/tmp/a b.png'], [2, '/tmp/a b.png']]);
});


it('ignores suffix constants, API URLs and shell commands while preserving paths inside commands', () => {
  const result = sessionImageIndex([event(1, { kind: 'tool', tool: { name: 'bash', input: JSON.stringify({
    command: 'cd /tmp && sips -s format png /tmp/source.webp --out /tmp/crop-card.png >/dev/null 2>&1; ls -la /tmp/crop-card.png'
  }), output: `const suffix = ".png"; const side = "-side.png"; const url = "/api/runtime-sessions/tiger/file-content?path=%2Fprivate%2Ftmp%2Fshot.png";\n"/tmp/a b.png" [relative](result.png)` } })]);
  expect(result.items.map(i => i.path)).toEqual(['/tmp/source.webp', '/tmp/crop-card.png', '/tmp/a b.png', 'result.png']);
  expect(result.items.every(i => !i.path!.includes('2>&1') && !i.path!.includes('file-content'))).toBe(true);
});

it('does not salvage suffixes from malformed file URLs, including bare URLs', () => {
  expect(sessionImageIndex([event(1, { text: 'file://[invalid]/a.png' })]).items).toEqual([]);
  expect(sessionImageIndex([event(1, { text: 'file:///tmp/real.png' })]).items[0]?.path).toBe('/tmp/real.png');
});

it('gives directory-less image references the directories written elsewhere in the same message, nearest first', () => {
  const text = '截图在 `docs/a/evidence/` 下：`cost-dark-390.png`、`list-entry/dark-390.png`、`/tmp/abs.png`；另见 `../other/evidence/` 和 `src/main.ts`';
  const { items } = sessionImageIndex([event(1, { text }), event(2, { kind: 'tool', tool: { name: 'sh', input: '`bare.png`', output: '' } })]);
  expect(items.map(i => i.path)).toEqual(['cost-dark-390.png', 'list-entry/dark-390.png', '/tmp/abs.png']);
  expect(items[0].hints).toEqual(['src', '/tmp', 'list-entry', 'docs/a/evidence']);
  expect(items[2].hints).toBeUndefined();
});

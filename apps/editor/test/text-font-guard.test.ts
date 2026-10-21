import { expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import { TextEditing } from '../src/text-edit.ts';

function setup() {
  const doc = new Document();
  const page = doc.create('PAGE', doc.root, {});
  const id = doc.create('TEXT', page, { characters: 'Example', fontName: { family: 'Missing', style: 'Regular' } });
  const ed = { doc, selection: [] as string[], select(ids: string[]) { this.selection = ids; } };
  let finish!: (ok: boolean) => void;
  const fonts = { has: () => false, ensure: vi.fn(() => new Promise<boolean>(r => { finish = r; })) };
  const notify = vi.fn();
  const editing = Object.assign(Object.create(TextEditing.prototype), { ed, fonts, id: null, fontRequest: 0, notify }) as TextEditing;
  return { doc, id, ed, fonts, notify, editing, finish: (ok: boolean) => finish(ok) };
}

it('does not start editing or mutate the document when the font is missing', async () => {
  const r = setup(); const before = r.doc.props(r.id);
  r.editing.start(r.id); r.finish(false);
  await vi.waitFor(() => expect(r.notify).toHaveBeenCalledTimes(2));
  expect(r.editing.active).toBe(false);
  expect(r.doc.props(r.id)).toEqual(before);
  expect(r.notify.mock.calls[1]![0]).toContain('Missing Regular');
});

it('starts after a successful load only while the same text remains selected', async () => {
  const r = setup(); r.editing.start(r.id);
  const restart = vi.spyOn(r.editing, 'start').mockImplementation(() => {});
  r.finish(true); await vi.waitFor(() => expect(restart).toHaveBeenCalledWith(r.id, false, undefined));
  const s = setup(); s.editing.start(s.id);
  const stale = vi.spyOn(s.editing, 'start').mockImplementation(() => {});
  s.ed.selection = []; s.finish(true); await new Promise(r => setTimeout(r, 0));
  expect(stale).not.toHaveBeenCalled();
});

it('commit cancels a pending edit request', async () => {
  const r = setup(); r.editing.start(r.id); r.editing.commit();
  const restart = vi.spyOn(r.editing, 'start').mockImplementation(() => {});
  r.finish(true); await new Promise(r => setTimeout(r, 0));
  expect(restart).not.toHaveBeenCalled();
});

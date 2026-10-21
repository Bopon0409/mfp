import { describe, expect, it } from 'vitest';
import {
  Document,
  addCommentReply,
  addCommentThread,
  commentPages,
  commentReplies,
  commentThreads,
  createStyle,
  deleteComment,
  editComment,
  moveThread,
  resolveThread,
  resourcesPage,
  threadOf,
  threadPage,
  threadPoint,
  transplantComments,
  userPages,
} from '@mfp/core';

function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Страница' });
  const frame = doc.create('FRAME', page, { name: 'Экран', width: 400, height: 300, transform: [1, 0, 100, 0, 1, 50] });
  doc.clearHistory();
  return { doc, page, frame };
}

const me = { author: 'Аня', color: '#f24822' };

describe('comments', () => {
  it('threads and replies live on their own service page, outside undo and the page list', () => {
    const { doc, page } = setup();
    const t = addCommentThread(doc, page, [10, 20], null, { ...me, text: 'Поправить отступ' }, 1000);
    const r = addCommentReply(doc, t, { author: 'Боря', text: 'Сделано' }, 2000);
    expect(commentThreads(doc)).toEqual([t]);
    expect(commentThreads(doc, page)).toEqual([t]);
    expect(commentReplies(doc, t)).toEqual([r]);
    expect(threadOf(doc, r)).toBe(t);
    expect(threadOf(doc, t)).toBe(t);
    expect(doc.get(t, 'comment')).toMatchObject({ author: 'Аня', text: 'Поправить отступ', created: 1000, page, at: [10, 20] });
    expect(userPages(doc)).toEqual([page]);
    expect(commentPages(doc)).toHaveLength(1);
    expect(doc.canUndo).toBe(false);
  });

  it('a thread on a frame moves with it; without a frame — stays in place', () => {
    const { doc, page, frame } = setup();
    const t = addCommentThread(doc, page, [150, 80], frame, { ...me, text: 'Здесь' });
    expect(doc.get(t, 'comment')?.at).toEqual([50, 30]);
    doc.set(frame, { transform: [1, 0, 300, 0, 1, 0] });
    expect(threadPoint(doc, t)).toEqual([350, 30]);
    // A frame on another page — the thread is there too.
    const other = doc.create('PAGE', doc.root, { name: 'Вторая' });
    doc.move(frame, other);
    expect(threadPage(doc, t)).toBe(other);
    expect(commentThreads(doc, page)).toEqual([]);
    // The frame is deleted — the thread stays where it was placed (on its page).
    doc.delete(frame);
    expect(threadPage(doc, t)).toBe(page);
    expect(threadPoint(doc, t)).toEqual([150, 80]);
    // Undoing the deletion restores the anchoring too.
    doc.undo();
    expect(threadPoint(doc, t)).toEqual([350, 30]);
  });

  it('editing, resolving, moving and deleting', () => {
    const { doc, page, frame } = setup();
    const t = addCommentThread(doc, page, [0, 0], null, { ...me, text: 'Было' });
    const r = addCommentReply(doc, t, { ...me, text: 'Ответ' });
    editComment(doc, t, 'Стало', 5000);
    expect(doc.get(t, 'comment')).toMatchObject({ text: 'Стало', edited: 5000 });
    resolveThread(doc, t, true);
    expect(doc.get(t, 'comment')?.resolved).toBe(true);
    resolveThread(doc, t, false);
    expect('resolved' in doc.get(t, 'comment')!).toBe(false);
    moveThread(doc, t, page, [120, 70], frame);
    expect(doc.get(t, 'comment')).toMatchObject({ anchor: frame, at: [20, 20], pageAt: [120, 70] });
    moveThread(doc, t, page, [5, 5], null);
    expect('anchor' in doc.get(t, 'comment')!).toBe(false);
    deleteComment(doc, r);
    expect(commentReplies(doc, t)).toEqual([]);
    deleteComment(doc, t);
    expect(commentThreads(doc)).toEqual([]);
    expect(doc.canUndo).toBe(false);
  });

  it('undoing the first style does not take comments with it', () => {
    const { doc, page } = setup();
    createStyle(doc, 'PAINT', 'Основной', { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] });
    const t = addCommentThread(doc, page, [0, 0], null, { ...me, text: 'Не потерять' });
    expect(commentPages(doc)[0]).not.toBe(resourcesPage(doc, false));
    while (doc.canUndo) doc.undo();
    expect(resourcesPage(doc, false)).toBeNull();
    expect(commentThreads(doc)).toEqual([t]);
  });

  it('restoring a version keeps the current comments', () => {
    const { doc, page } = setup();
    const old = Document.fromSnapshot(doc.snapshot());
    addCommentThread(old, page, [1, 1], null, { ...me, text: 'Старый' });
    const t = addCommentThread(doc, page, [2, 2], null, { ...me, text: 'Новый' });
    addCommentReply(doc, t, { ...me, text: 'Ответ' });
    transplantComments(doc, old);
    expect(commentThreads(old).map((id) => old.get(id, 'comment')?.text)).toEqual(['Новый']);
    expect(commentReplies(old, t)).toHaveLength(1);
  });
});

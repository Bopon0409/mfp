import { describe, expect, it } from 'vitest';
import {
  DesignSync,
  Document,
  PrototypeSession,
  combineAsVariants,
  createCollection,
  createVariable,
  cubicBezier,
  easingFunction,
  evaluatePrototypeValue,
  formatPrototypeValue,
  parsePrototypeExpression,
  prototypePages,
  screensOf,
  instantiate,
  springAt,
  transitionDuration,
  type Op,
  type Reaction,
  type SessionEvent,
} from '@mfp/core';

const dissolve = { type: 'DISSOLVE' as const, easing: { type: 'EASE_OUT' as const }, duration: 0.3 };

/** Prototype document: screens A and B, an overlay, a button with hover (an interactive component). */
function setup() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Прототип' });
  const sync = new DesignSync(doc);
  doc.onChange((ops: Op[], origin: string) => {
    sync.observe(ops);
    if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
    if (origin === 'local' || origin === 'layout' || origin === 'prototype') doc.amend(() => sync.propagate(ops));
  });
  const ids = doc.transact(() => {
    const a = doc.create('FRAME', page, { name: 'A', width: 390, height: 800 });
    const b = doc.create('FRAME', page, { name: 'B', width: 390, height: 800, transform: [1, 0, 500, 0, 1, 0] });
    const sheet = doc.create('FRAME', page, { name: 'Sheet', width: 390, height: 300, transform: [1, 0, 1000, 0, 1, 0], overlayBackgroundInteraction: 'CLOSE_ON_CLICK_OUTSIDE' });
    // Button: variants Default / Hover, hover changes the variant.
    const def = doc.create('COMPONENT', page, { name: 'State=Default', width: 120, height: 40, transform: [1, 0, 0, 0, 1, 1000] });
    const hov = doc.create('COMPONENT', page, { name: 'State=Hover', width: 120, height: 40, transform: [1, 0, 200, 0, 1, 1000] });
    doc.create('TEXT', def, { name: 'Label', characters: 'Далее' });
    doc.create('TEXT', hov, { name: 'Label', characters: 'Далее' });
    combineAsVariants(doc, [def, hov], page);
    doc.set(def, { reactions: [{ trigger: { type: 'MOUSE_ENTER', delay: 0 }, actions: [{ type: 'NODE', destinationId: hov, navigation: 'CHANGE_TO', transition: null }] }] satisfies Reaction[] });
    doc.set(hov, { reactions: [{ trigger: { type: 'MOUSE_LEAVE', delay: 0 }, actions: [{ type: 'NODE', destinationId: def, navigation: 'CHANGE_TO', transition: null }] }] satisfies Reaction[] });
    const button = instantiate(doc, def, a, [1, 0, 20, 0, 1, 700]);
    doc.set(button, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: dissolve }] }] satisfies Reaction[] });
    const open = doc.create('RECTANGLE', b, { name: 'Open sheet', reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: sheet, navigation: 'OVERLAY', transition: null }] }] satisfies Reaction[] });
    const back = doc.create('RECTANGLE', b, { name: 'Back', reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }] satisfies Reaction[] });
    doc.set(page, { flowStartingPoints: [{ nodeId: a, name: 'Поток 1' }] });
    return { a, b, sheet, def, hov, button, open, back };
  });
  const events: SessionEvent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const session = new PrototypeSession(doc, page, {
    emit: (e) => events.push(e),
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  return { doc, page, session, events, timers, ...ids };
}

describe('transition curves', () => {
  it('cubic Bézier and preset curves', () => {
    const ease = cubicBezier(0.42, 0, 0.58, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 4);
    expect(easingFunction({ type: 'EASE_IN' }, 0.3)(0.25)).toBeLessThan(0.25);
    expect(easingFunction({ type: 'EASE_OUT_BACK' }, 0.3)(0.7)).toBeGreaterThan(1);
  });

  it('springs: reach 1, “bouncy” overshoots; duration follows physics', () => {
    expect(springAt(0, 1, 100, 15)).toBeCloseTo(0, 6);
    expect(springAt(3, 1, 100, 15)).toBeCloseTo(1, 3);
    const bouncy = easingFunction({ type: 'BOUNCY' }, 0.8);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => bouncy(i / 50)))).toBeGreaterThan(1.05);
    expect(transitionDuration({ type: 'DISSOLVE', easing: { type: 'GENTLE' }, duration: 0 })).toBeGreaterThan(0.5);
  });
});

describe('prototype session', () => {
  it('start — the first flow; click — dissolve transition; back', () => {
    const { session, events, a, b, button, back } = setup();
    session.begin();
    expect(session.screen).toBe(a);
    session.click([a, button, 'нет такого']);
    expect(session.screen).toBe(b);
    expect(events.at(-1)).toMatchObject({ type: 'navigate', from: a, to: b, transition: dissolve });
    session.click([b, back]);
    expect(session.screen).toBe(a);
    expect(events.at(-1)).toMatchObject({ type: 'navigate', to: a, back: true });
  });

  it('a click outside hotspots highlights the hotspots', () => {
    const { session, events, a } = setup();
    session.begin();
    session.click([a]);
    expect(events.at(-1)).toEqual({ type: 'no-hotspot' });
  });

  it('overlay: open, close by clicking outside', () => {
    const { session, events, b, sheet, open } = setup();
    session.begin(b);
    session.click([b, open]);
    expect(session.overlays.map((o) => o.id)).toEqual([sheet]);
    session.click([b]);
    expect(session.overlays).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'overlay-close' });
  });

  it('interactive component: hover changes the variant in a copy, leaving reverts it', () => {
    const { doc, session, events, a, button, def, hov } = setup();
    session.begin();
    const label = doc.children(button)[0]!;
    session.hover([a, button, label]);
    expect(doc.get(button, 'componentId')).toBe(hov);
    const change = events.find((e) => e.type === 'change');
    expect(change).toMatchObject({ instance: button, from: def, to: hov });
    // The text node was recreated: the path follows the new tree.
    session.hover([a]);
    expect(doc.get(button, 'componentId')).toBe(def);
  });

  it('after delay, key, condition and variable', () => {
    const { doc, session, events, timers, a, b, page } = setup();
    const coll = doc.transact(() => createCollection(doc, 'Состояние'));
    const mode = doc.get(coll, 'modes')![0]!.modeId;
    const count = doc.transact(() => createVariable(doc, 'count', coll, 'FLOAT', 0));
    doc.transact(() => {
      doc.set(a, { reactions: [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 0.8 }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: null }] }] satisfies Reaction[] });
      doc.set(b, {
        reactions: [
          {
            trigger: { type: 'ON_KEY_DOWN', device: 'KEYBOARD', keyCodes: [69] },
            actions: [
              { type: 'SET_VARIABLE', variableId: count, variableValue: { type: 'EXPRESSION', resolvedType: 'FLOAT', value: { expressionFunction: 'ADDITION', expressionArguments: [{ type: 'VARIABLE_ALIAS', value: { type: 'VARIABLE_ALIAS', id: count } }, { type: 'FLOAT', value: 1 }] } } },
              {
                type: 'CONDITIONAL',
                conditionalBlocks: [
                  { condition: { type: 'EXPRESSION', value: { expressionFunction: 'GREATER_THAN_OR_EQUAL', expressionArguments: [{ type: 'VARIABLE_ALIAS', value: { type: 'VARIABLE_ALIAS', id: count } }, { type: 'FLOAT', value: 2 }] } }, actions: [{ type: 'URL', url: 'https://example.com' }] },
                  { actions: [] },
                ],
              },
            ],
          },
        ] satisfies Reaction[],
      });
    });
    void page;
    session.begin();
    expect(timers.map((t) => t.ms)).toEqual([800]);
    timers[0]!.fn();
    expect(session.screen).toBe(b);
    expect(session.key(69)).toBe(true);
    expect(doc.get(count, 'valuesByMode')![mode]).toBe(1);
    expect(events.some((e) => e.type === 'url')).toBe(false);
    session.key(69);
    expect(doc.get(count, 'valuesByMode')![mode]).toBe(2);
    expect(events.at(-1)).toEqual({ type: 'url', url: 'https://example.com', newTab: true });
    // A gamepad button with the same number does not fire a keyboard trigger.
    expect(session.key(69, true)).toBe(false);
  });
});

describe('prototype expressions', () => {
  it('parsing and printing: variables, arithmetic, comparisons, logic', () => {
    const doc = new Document({ clientId: 1 });
    doc.create('PAGE', doc.root, { name: 'Страница' });
    const coll = createCollection(doc, 'Игра');
    const count = createVariable(doc, 'Счёт', coll, 'FLOAT', 3);
    const on = createVariable(doc, 'Звук', coll, 'BOOLEAN', true);
    const parse = (t: string) => {
      const v = parsePrototypeExpression(doc, t);
      if ('error' in v) throw new Error(v.error);
      return v;
    };
    const ev = (t: string) => evaluatePrototypeValue(doc, parse(t), null);
    expect(ev('{Счёт} + 1')).toBe(4);
    expect(ev('({Счёт} + 1) * 2 - -1')).toBe(9);
    expect(ev('{Счёт} >= 3 и {Звук}')).toBe(true);
    expect(ev('не {Звук} или {Счёт} ≠ 3')).toBe(false);
    expect(ev('"Ход " + {Счёт}')).toBe('Ход 3');
    expect(ev('10 / 4')).toBe(2.5);
    expect(parse('#FF000080')).toMatchObject({ type: 'COLOR', value: { r: 1, g: 0, b: 0 } });
    expect(parse('{Счёт}')).toEqual({ type: 'VARIABLE_ALIAS', resolvedType: 'FLOAT', value: { type: 'VARIABLE_ALIAS', id: count } });
    expect(parse('{Счёт} = 2')).toMatchObject({ type: 'EXPRESSION', resolvedType: 'BOOLEAN', value: { expressionFunction: 'EQUALS' } });
    expect(parsePrototypeExpression(doc, '{Нет такой} + 1')).toEqual({ error: 'Нет переменной «Нет такой»' });
    expect('error' in parsePrototypeExpression(doc, '1 +')).toBe(true);
    expect('error' in parsePrototypeExpression(doc, '(1 + 2')).toBe(true);
    // Printing gives back the same meaning.
    for (const t of ['{Счёт} + 1', '{Счёт} >= 3 и {Звук}', '({Счёт} + 1) * 2', 'не {Звук}', '"а" + "б"', 'истина']) {
      const back = formatPrototypeValue(doc, parse(t));
      expect(evaluatePrototypeValue(doc, parse(back), null)).toEqual(ev(t));
    }
    expect(formatPrototypeValue(doc, parse('{Счёт} + 1'))).toBe('{Счёт} + 1');
    void on;
  });

  it('page screens: frames on the page and in sections', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    const a = doc.create('FRAME', page, { name: 'A' });
    const sec = doc.create('SECTION', page, { name: 'Секция' });
    const b = doc.create('FRAME', sec, { name: 'B' });
    doc.create('RECTANGLE', page, { name: 'Не экран' });
    doc.create('FRAME', a, { name: 'Вложенный' });
    expect(screensOf(doc, page)).toEqual([a, b]);
  });
});

describe('video in the prototype', () => {
  it('“video ended” and “reached” trigger actions; a video action is a presentation event', () => {
    const { doc, session, events, a, b } = setup();
    const v = doc.create('RECTANGLE', a, {
      name: 'Видео',
      fills: [{ type: 'VIDEO', scaleMode: 'FILL', videoHash: 'abc' }],
      reactions: [
        { trigger: { type: 'ON_MEDIA_HIT', mediaHitTime: 2 }, actions: [{ type: 'UPDATE_MEDIA_RUNTIME', destinationId: null, mediaAction: 'MUTE' }] },
        { trigger: { type: 'ON_MEDIA_END' }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: null }] },
      ] satisfies Reaction[],
    });
    session.begin();
    // Moment 2 s not yet passed, then passed (between 1.9 and 2.1).
    session.media(v, 'time', 1.5, 1.9);
    expect(events.some((e) => e.type === 'media')).toBe(false);
    session.media(v, 'time', 1.9, 2.1);
    expect(events.at(-1)).toMatchObject({ type: 'media', action: { mediaAction: 'MUTE' } });
    session.media(v, 'end');
    expect(session.screen).toBe(b);
  });
});

describe('file-wide prototype', () => {
  it('the presentation needs the pages that transitions lead to — along the chain, including condition branches', () => {
    const doc = new Document({ clientId: 1 });
    const p1 = doc.create('PAGE', doc.root, { name: 'Вход' });
    const p2 = doc.create('PAGE', doc.root, { name: 'Каталог' });
    const p3 = doc.create('PAGE', doc.root, { name: 'Оверлеи' });
    const p4 = doc.create('PAGE', doc.root, { name: 'Черновики' });
    const a = doc.create('FRAME', p1, { name: 'Вход', width: 100, height: 100 });
    const b = doc.create('FRAME', p2, { name: 'Список', width: 100, height: 100 });
    const o = doc.create('FRAME', p3, { name: 'Меню', width: 50, height: 50 });
    doc.create('FRAME', p4, { name: 'Старое', width: 10, height: 10 });
    const btn = doc.create('RECTANGLE', a, { name: 'Дальше' });
    doc.set(btn, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: dissolve }] }] satisfies Reaction[] });
    const more = doc.create('RECTANGLE', b, { name: 'Ещё' });
    doc.set(more, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CONDITIONAL', conditionalBlocks: [{ actions: [{ type: 'NODE', destinationId: o, navigation: 'OVERLAY', transition: null }] }] }] }] satisfies Reaction[] });
    expect(prototypePages(doc, p1)).toEqual([p1, p2, p3]);
    expect(prototypePages(doc, p2)).toEqual([p2, p3]);
    expect(prototypePages(doc, p4)).toEqual([p4]);
  });

  it('navigating to a screen on another page within the session', () => {
    const doc = new Document({ clientId: 1 });
    const p1 = doc.create('PAGE', doc.root, { name: 'Один' });
    const p2 = doc.create('PAGE', doc.root, { name: 'Два' });
    const a = doc.create('FRAME', p1, { name: 'A', width: 100, height: 100 });
    const b = doc.create('FRAME', p2, { name: 'B', width: 100, height: 100 });
    const btn = doc.create('RECTANGLE', a, { name: 'Кнопка', width: 20, height: 20 });
    doc.set(btn, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: null }] }] satisfies Reaction[] });
    const s = new PrototypeSession(doc, p1, { emit: () => {}, setTimer: () => () => {}, willChange: () => {} } as never, a);
    s.begin();
    s.click([a, btn]);
    expect(s.screen).toBe(b);
    s.back();
    expect(s.screen).toBe(a);
  });
});

describe('“Scroll” trigger', () => {
  function screens() {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Стр' });
    const s = doc.create('FRAME', page, { name: 'Лента', width: 390, height: 2000 });
    const down = doc.create('FRAME', page, { name: 'Вниз', width: 390, height: 844 });
    const seen = doc.create('FRAME', page, { name: 'Увидели', width: 390, height: 844 });
    const go = (to: string) => [{ type: 'NODE' as const, destinationId: to, navigation: 'NAVIGATE' as const, transition: null }];
    const session = () => {
      const x = new PrototypeSession(doc, page, { emit: () => {}, setTimer: () => () => {}, willChange: () => {} } as never, s);
      x.begin();
      return x;
    };
    return { doc, page, s, down, seen, go, session };
  }
  const view = { w: 390, h: 844 };

  it('to a mark: fires when scrolling passes the mark in the right direction', () => {
    const { doc, s, down, go, session } = screens();
    const header = doc.create('RECTANGLE', s, { name: 'Шапка', width: 390, height: 60 });
    doc.set(header, { reactions: [{ trigger: { type: 'ON_SCROLL', scroll: 'OFFSET', offset: 200, direction: 'DOWN' }, actions: go(down) }] satisfies Reaction[] });
    const x = session();
    x.scrolled(s, { x: 0, y: 0 }, { x: 0, y: 150 }, view);
    expect(x.screen).toBe(s);
    // Back past the mark is not “down”.
    x.scrolled(s, { x: 0, y: 300 }, { x: 0, y: 100 }, view);
    expect(x.screen).toBe(s);
    x.scrolled(s, { x: 0, y: 150 }, { x: 0, y: 250 }, view);
    expect(x.screen).toBe(down);
  });

  it('layer appeared: was outside the viewport and scrolled into it', () => {
    const { doc, s, seen, go, session } = screens();
    const card = doc.create('RECTANGLE', s, { name: 'Карточка', transform: [1, 0, 0, 0, 1, 1200], width: 390, height: 100 });
    doc.set(card, { reactions: [{ trigger: { type: 'ON_SCROLL', scroll: 'IN_VIEW', offset: 0, direction: 'ANY' }, actions: go(seen) }] satisfies Reaction[] });
    const x = session();
    x.scrolled(s, { x: 0, y: 0 }, { x: 0, y: 300 }, view);
    expect(x.screen).toBe(s);
    x.scrolled(s, { x: 0, y: 300 }, { x: 0, y: 500 }, view);
    expect(x.screen).toBe(seen);
  });

  it('a layer inside a nested scrolling frame uses that frame\'s scroll, not the screen\'s', () => {
    const { doc, s, down, go, session } = screens();
    const list = doc.create('FRAME', s, { name: 'Список', width: 390, height: 300, overflowDirection: 'VERTICAL' });
    const item = doc.create('RECTANGLE', list, { name: 'Пункт', width: 390, height: 40 });
    doc.set(item, { reactions: [{ trigger: { type: 'ON_SCROLL', scroll: 'OFFSET', offset: 100, direction: 'ANY' }, actions: go(down) }] satisfies Reaction[] });
    const x = session();
    x.scrolled(s, { x: 0, y: 0 }, { x: 0, y: 400 }, view);
    expect(x.screen).toBe(s);
    x.scrolled(list, { x: 0, y: 0 }, { x: 0, y: 120 }, { w: 390, h: 300 });
    expect(x.screen).toBe(down);
  });
});

describe('double and right click, hover together with click', () => {
  it('double click and right click have their own reactions; a single click does not trigger them', () => {
    const { doc, session, a, b, sheet } = setup();
    const card = doc.create('RECTANGLE', a, { name: 'Карточка', width: 100, height: 100 });
    doc.set(card, {
      reactions: [
        { trigger: { type: 'ON_DOUBLE_CLICK' }, actions: [{ type: 'NODE', destinationId: b, navigation: 'NAVIGATE', transition: null }] },
        { trigger: { type: 'ON_RIGHT_CLICK' }, actions: [{ type: 'NODE', destinationId: sheet, navigation: 'OVERLAY', transition: null }] },
      ] satisfies Reaction[],
    });
    session.begin();
    expect(session.wantsDoubleClick([a, card])).toBe(true);
    expect(session.wantsDoubleClick([a])).toBe(false);
    session.click([a, card]);
    expect(session.screen).toBe(a);
    expect(session.rightClick([a, card])).toBe(true);
    expect(session.overlays.map((o) => o.id)).toEqual([sheet]);
    session.doubleClick([a, card]);
    expect(session.screen).toBe(b);
    expect(session.rightClick([b])).toBe(false);
  });

  it('“while hovering” and “click” on one button: the variant from the click stays after the pointer leaves', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Прототип' });
    const sync = new DesignSync(doc);
    doc.onChange((ops: Op[], origin: string) => {
      sync.observe(ops);
      if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
      if (origin === 'local' || origin === 'layout' || origin === 'prototype') doc.amend(() => sync.propagate(ops));
    });
    const { screen, button, def, hov, sel } = doc.transact(() => {
      const screen = doc.create('FRAME', page, { name: 'Экран', width: 390, height: 800 });
      const def = doc.create('COMPONENT', page, { name: 'State=Default', width: 120, height: 40, transform: [1, 0, 0, 0, 1, 1000] });
      const hov = doc.create('COMPONENT', page, { name: 'State=Hover', width: 120, height: 40, transform: [1, 0, 200, 0, 1, 1000] });
      const sel = doc.create('COMPONENT', page, { name: 'State=Selected', width: 120, height: 40, transform: [1, 0, 400, 0, 1, 1000] });
      combineAsVariants(doc, [def, hov, sel], page);
      doc.set(def, { reactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: hov, navigation: 'CHANGE_TO', transition: null }] }] satisfies Reaction[] });
      doc.set(hov, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: sel, navigation: 'CHANGE_TO', transition: null }] }] satisfies Reaction[] });
      const button = instantiate(doc, def, screen, [1, 0, 20, 0, 1, 700]);
      doc.set(page, { flowStartingPoints: [{ nodeId: screen, name: 'Поток' }] });
      return { screen, button, def, hov, sel };
    });
    const session = new PrototypeSession(doc, page, { emit: () => {}, setTimer: () => () => {} });
    session.begin();
    session.hover([screen, button]);
    expect(doc.get(button, 'componentId')).toBe(hov);
    session.click([screen, button]);
    expect(doc.get(button, 'componentId')).toBe(sel);
    session.hover([screen]);
    expect(doc.get(button, 'componentId')).toBe(sel);
    // Without a click, leaving still restores the original variant.
    const other = new PrototypeSession(doc, page, { emit: () => {}, setTimer: () => () => {} });
    doc.transact(() => doc.set(button, { componentId: def }));
    other.begin();
    other.hover([screen, button]);
    expect(doc.get(button, 'componentId')).toBe(hov);
    other.hover([screen]);
    expect(doc.get(button, 'componentId')).toBe(def);
  });
});

describe('flow\'s own device', () => {
  it('presenting from the start of a flow uses its device; without a flow — the page\'s device', () => {
    const { doc, page, session, a, b } = setup();
    const phone = { type: 'PRESET' as const, presetIdentifier: 'iPhone 16', size: { width: 393, height: 852 }, rotation: 'NONE' as const };
    doc.set(page, { flowStartingPoints: [{ nodeId: a, name: 'Телефон', device: phone }, { nodeId: b, name: 'Как у страницы' }] });
    session.begin(a);
    expect(session.flow?.name).toBe('Телефон');
    expect(session.flowDevice).toEqual(phone);
    session.begin(b);
    expect(session.flow?.name).toBe('Как у страницы');
    expect(session.flowDevice).toBeNull();
  });
});

describe('text input in the presentation', () => {
  it('the value goes into the field\'s variable; “Text input” fires on Enter or on every change', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const { field, screen, next, email } = doc.transact(() => {
      const coll = createCollection(doc, 'Форма');
      const email = createVariable(doc, 'email', coll, 'STRING', '');
      const screen = doc.create('FRAME', page, { name: 'Вход', width: 400, height: 300 });
      const next = doc.create('FRAME', page, { name: 'Дальше', width: 400, height: 300, transform: [1, 0, 500, 0, 1, 0] });
      const field = doc.create('TEXT', screen, { name: 'Поле', characters: 'Почта', prototypeInput: { variableId: email } });
      doc.set(field, {
        reactions: [{ trigger: { type: 'ON_TEXT_INPUT', submit: true }, actions: [{ type: 'NODE', destinationId: next, navigation: 'NAVIGATE', transition: null }] }] satisfies Reaction[],
      });
      doc.set(page, { flowStartingPoints: [{ nodeId: screen, name: 'Поток' }] });
      return { field, screen, next, email };
    });
    const session = new PrototypeSession(doc, page, { emit: () => {}, setTimer: () => () => {} });
    session.begin();
    session.input(field, 'a@b', false);
    expect(Object.values(doc.get(email, 'valuesByMode')!)[0]).toBe('a@b');
    expect(session.screen).toBe(screen);
    session.input(field, 'a@b.c', true);
    expect(Object.values(doc.get(email, 'valuesByMode')!)[0]).toBe('a@b.c');
    expect(session.screen).toBe(next);
  });
});

describe('sound in the prototype', () => {
  it('the “Sound” action is a presentation event with a hash and volume', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const events: SessionEvent[] = [];
    const { screen, btn } = doc.transact(() => {
      const screen = doc.create('FRAME', page, { name: 'Экран', width: 400, height: 300 });
      const btn = doc.create('RECTANGLE', screen, { name: 'Кнопка', width: 100, height: 40 });
      doc.set(btn, { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'SOUND', soundHash: 'abc123', volume: 0.5 }] }] satisfies Reaction[] });
      doc.set(page, { flowStartingPoints: [{ nodeId: screen, name: 'Поток' }] });
      return { screen, btn };
    });
    const session = new PrototypeSession(doc, page, { emit: (e) => events.push(e), setTimer: () => () => {} });
    session.begin();
    session.click([screen, btn]);
    expect(events.find((e) => e.type === 'sound')).toEqual({ type: 'sound', hash: 'abc123', volume: 0.5 });
  });
});

// Filling a design with data from CSV or JSON (MFP extension). Each record is one copy (a grid
// repeat cell or one of the selected layers). A record field goes into the copy's layer with the same
// name (case-insensitive; “#name” or “{name}” also work):
//   - text — the layer's new text;
//   - not text and a color value “#rgb”, “#rrggbb”, “#rrggbbaa” — the color of the first solid fill;
//   - the value “/hide” — the layer is hidden; any other value shows the field's layer.
// An empty text value is an empty string.

import type { Document, Paint, Props } from '@mfp/core';

export interface DataTable {
  columns: string[];
  rows: Record<string, string>[];
}

/** Parse text: JSON (an array of objects or an object with the first such array) or CSV/TSV. */
export function parseData(text: string): DataTable | null {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return null;
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      return fromJson(JSON.parse(t));
    } catch {
      return null;
    }
  }
  return parseCsv(t);
}

function fromJson(v: unknown): DataTable | null {
  let list: unknown = v;
  if (list && !Array.isArray(list) && typeof list === 'object') list = Object.values(list as object).find(Array.isArray);
  if (!Array.isArray(list)) return null;
  const columns: string[] = [];
  const rows = list.map((item) => {
    const row: Record<string, string> = {};
    if (item && typeof item === 'object') {
      for (const [k, val] of Object.entries(item as object)) {
        if (!columns.includes(k)) columns.push(k);
        row[k] = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
      }
    } else {
      if (!columns.includes('value')) columns.push('value');
      row.value = String(item ?? '');
    }
    return row;
  });
  return { columns, rows };
}

/** CSV per RFC 4180: quotes, “""”, line breaks inside quotes; separator — , ; or tab (from the first line). */
export function parseCsv(text: string): DataTable | null {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim()));
  if (nonEmpty.length < 1) return null;
  const columns = nonEmpty[0]!.map((c, i) => c.trim() || `col${i + 1}`);
  const rows = nonEmpty.slice(1).map((r) => Object.fromEntries(columns.map((col, i) => [col, r[i] ?? ''])));
  return { columns, rows };
}

/** Layer name → field name: case-insensitive, without a leading “#” and curly braces. */
export function fieldKey(name: string): string {
  return name
    .trim()
    .replace(/^#/, '')
    .replace(/^\{(.*)\}$/, '$1')
    .trim()
    .toLowerCase();
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Color “#rgb”, “#rgba”, “#rrggbb”, “#rrggbbaa” → RGBA 0–1; not a color — null. */
export function hexColor(v: string): { r: number; g: number; b: number; a: number } | null {
  const m = HEX.exec(v.trim());
  if (!m) return null;
  let s = m[1]!;
  if (s.length <= 4) s = [...s].map((c) => c + c).join('');
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) : 1 };
}

/** Layers of a copy (the copy itself and all descendants) whose names are table fields. */
export function boundLayers(doc: Document, root: string, columns: readonly string[]): Map<string, string[]> {
  const keys = new Map(columns.map((c) => [fieldKey(c), c]));
  const out = new Map<string, string[]>();
  const visit = (id: string) => {
    const col = keys.get(fieldKey(doc.get(id, 'name') ?? ''));
    if (col) out.set(col, [...(out.get(col) ?? []), id]);
    for (const k of doc.children(id)) visit(k);
  };
  visit(root);
  return out;
}

/** Layer edits for a field value (null — nothing to change). */
export function valueProps(doc: Document, id: string, value: string): Props | null {
  if (value.trim() === '/hide') return doc.get(id, 'visible') === false ? null : { visible: false };
  const props: Props = {};
  // The data controls the field layer's visibility: a value is present — it is shown.
  if (doc.get(id, 'visible') === false) props.visible = true;
  if (doc.type(id) === 'TEXT') {
    if ((doc.get(id, 'characters') ?? '') !== value) props.characters = value;
  } else {
    const c = hexColor(value);
    if (c) {
      const fills = [...((doc.get(id, 'fills') ?? []) as Paint[])];
      const i = fills.findIndex((p) => p.type === 'SOLID');
      const solid: Paint = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a, visible: true } as Paint;
      if (i >= 0) fills[i] = { ...fills[i]!, ...solid } as Paint;
      else fills.unshift(solid);
      props.fills = fills;
    }
  }
  return Object.keys(props).length ? props : null;
}

/**
 * Fill copies with records in order (fewer copies — extra records are unused). The caller opens the
 * transaction. Returns how many layers were changed and which fields found a layer.
 */
export function fillTargets(doc: Document, targets: readonly string[], table: DataTable): { changed: number; matched: string[] } {
  let changed = 0;
  const matched = new Set<string>();
  targets.forEach((root, i) => {
    const row = table.rows[i];
    if (!row) return;
    for (const [col, ids] of boundLayers(doc, root, table.columns)) {
      matched.add(col);
      for (const id of ids) {
        const p = valueProps(doc, id, row[col] ?? '');
        if (!p) continue;
        doc.set(id, p);
        changed++;
      }
    }
  });
  return { changed, matched: table.columns.filter((c) => matched.has(c)) };
}

import type { NodeType, Paint, Props } from './types.ts';
import { deepFreeze } from './intern.ts';

const IDENTITY = [1, 0, 0, 0, 1, 0] as [number, number, number, number, number, number];
const WHITE: Paint = { type: 'SOLID', color: { r: 1, g: 1, b: 1 } };
const GREY: Paint = { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } };
const BLACK: Paint = { type: 'SOLID', color: { r: 0, g: 0, b: 0 } };

const COMMON: Props = {
  layoutGrow: 0,
  layoutAlign: 'INHERIT',
  layoutPositioning: 'AUTO',
  constraints: { horizontal: 'MIN', vertical: 'MIN' },
  gridRowAnchorIndex: -1,
  gridColumnAnchorIndex: -1,
  gridRowSpan: 1,
  gridColumnSpan: 1,
  gridChildHorizontalAlign: 'AUTO',
  gridChildVerticalAlign: 'AUTO',
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'PASS_THROUGH',
  transform: IDENTITY,
  width: 100,
  height: 100,
  effects: [],
  isMask: false,
  maskType: 'ALPHA',
  description: '',
  componentPropertyReferences: {},
  fillStyleId: '',
  strokeStyleId: '',
  effectStyleId: '',
  gridStyleId: '',
  textStyleId: '',
  boundVariables: {},
  explicitVariableModes: {},
  reactions: [],
  scrollBehavior: 'SCROLLS',
  exportSettings: [],
};

const SHAPE: Props = {
  ...COMMON,
  fills: [GREY],
  strokes: [],
  strokeWeight: 1,
  strokeAlign: 'INSIDE',
  strokeJoin: 'MITER',
  dashPattern: [],
  strokeStartCap: 'NONE',
  strokeEndCap: 'NONE',
  strokeMiterLimit: 4,
  cornerRadius: 0,
  cornerSmoothing: 0,
};

/** Containers that support auto layout. */
const AUTO_LAYOUT: Props = {
  layoutMode: 'NONE',
  itemSpacing: 0,
  counterAxisSpacing: null,
  paddingLeft: 0,
  paddingRight: 0,
  paddingTop: 0,
  paddingBottom: 0,
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  primaryAxisSizingMode: 'AUTO',
  counterAxisSizingMode: 'FIXED',
  layoutWrap: 'NO_WRAP',
  counterAxisAlignContent: 'AUTO',
  gridRowSizes: [],
  gridColumnSizes: [],
  gridRowGap: 0,
  gridColumnGap: 0,
};



/** Default values for each node type (nodes store only the differences). */
/** A frame in a prototype: scrolling and overlay presentation (defaults). */
const OVERLAY: Props = {
  overflowDirection: 'NONE',
  overlayPositionType: 'CENTER',
  overlayBackground: { type: 'NONE' },
  overlayBackgroundInteraction: 'NONE',
};

export const DEFAULTS: Record<NodeType, Props> = deepFreeze({
  DOCUMENT: { name: 'Document' },
  PAGE: { name: 'Page', backgrounds: [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.96 } }], flowStartingPoints: [], prototypeDevice: { type: 'PRESENTATION' }, prototypeBackgrounds: [{ type: 'SOLID', color: { r: 0.12, g: 0.12, b: 0.12 } }] },
  FRAME: { ...SHAPE, ...AUTO_LAYOUT, ...OVERLAY, name: 'Frame', fills: [WHITE], clipsContent: true },
  GROUP: { ...COMMON, name: 'Group', fills: [], strokes: [] },
  SECTION: { ...COMMON, name: 'Section', fills: [WHITE] },
  RECTANGLE: { ...SHAPE, name: 'Rectangle' },
  ELLIPSE: { ...SHAPE, name: 'Ellipse', arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 } },
  LINE: { ...SHAPE, name: 'Line', height: 0, fills: [], strokes: [BLACK], strokeAlign: 'CENTER' },
  POLYGON: { ...SHAPE, name: 'Polygon', pointCount: 3 },
  STAR: { ...SHAPE, name: 'Star', pointCount: 5, innerRadius: 0.382 },
  VECTOR: { ...SHAPE, name: 'Vector', strokeAlign: 'CENTER' },
  SLICE: { ...COMMON, name: 'Slice', fills: [], strokes: [], exportSettings: [{ format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 1 } }] },
  TEXT: {
    ...COMMON,
    name: 'Text',
    fills: [BLACK],
    strokes: [],
    characters: '',
    fontSize: 12,
    fontName: { family: 'Inter', style: 'Regular' },
    textAlignHorizontal: 'LEFT',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    textAlignVertical: 'TOP',
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    textDecorationStyle: 'SOLID',
    textDecorationThickness: { unit: 'AUTO' },
    textDecorationColor: 'AUTO',
    textDecorationOffset: { unit: 'AUTO' },
    textDecorationSkipInk: true,
    fontVariations: [],
    hyperlink: null,
    openTypeFeatures: {},
    listType: 'NONE',
    indentation: 0,
    textRuns: [],
    paragraphIndent: 0,
    paragraphSpacing: 0,
    listSpacing: 0,
    hangingPunctuation: false,
    hangingList: false,
    textTruncation: 'DISABLED',
    maxLines: null,
    leadingTrim: 'NONE',
    textWrap: 'AUTO',
    width: 0,
    height: 0,
  },
  COMPONENT: { ...SHAPE, ...AUTO_LAYOUT, ...OVERLAY, name: 'Component', fills: [WHITE], clipsContent: true, componentPropertyDefinitions: {} },
  COMPONENT_SET: { ...SHAPE, ...AUTO_LAYOUT, name: 'Component Set', fills: [], clipsContent: false, componentPropertyDefinitions: {} },
  INSTANCE: { ...SHAPE, ...AUTO_LAYOUT, ...OVERLAY, name: 'Instance', fills: [WHITE], clipsContent: true, componentProperties: {} },
  STYLE: {
    name: 'Style',
    description: '',
    styleType: 'PAINT',
    fills: [],
    effects: [],
    layoutGrids: [],
    fontSize: 12,
    fontName: { family: 'Inter', style: 'Regular' },
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    paragraphSpacing: 0,
    paragraphIndent: 0,
    listSpacing: 0,
    leadingTrim: 'NONE',
    openTypeFeatures: {},
  },
  VARIABLE_COLLECTION: { name: 'Collection', description: '', modes: [], defaultModeId: '' },
  VARIABLE: { name: 'Variable', description: '', resolvedType: 'COLOR', valuesByMode: {}, scopes: ['ALL_SCOPES'], codeSyntax: {}, hiddenFromPublishing: false },
  BOOLEAN_OPERATION: { ...SHAPE, name: 'Boolean', booleanOperation: 'UNION' },
  COMMENT: { name: 'Comment', comment: { author: '', text: '', created: 0 } },
});

/** Types that can have children. */
export const CONTAINER_TYPES = new Set<NodeType>(['DOCUMENT', 'PAGE', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'BOOLEAN_OPERATION', 'VARIABLE_COLLECTION', 'COMMENT']);

/** Pages the user sees (the internal resources page is not among them). */
export function userPages(doc: { root: string; children(id: string): readonly string[]; get(id: string, key: 'internal'): boolean | undefined }): string[] {
  return doc.children(doc.root).filter((p) => !doc.get(p, 'internal'));
}

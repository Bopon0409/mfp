// MFP document model types.
//
// Data shapes of fills, effects, etc. are compatible with Figma's public Plugin API
// (MIT typings @figma/plugin-typings): this simplifies .fig import and the plugin
// compatibility layer. Transforms are stored internally as a flat affine matrix.

export type NodeType =
  | 'DOCUMENT'
  | 'PAGE'
  | 'FRAME'
  | 'GROUP'
  | 'SECTION'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'LINE'
  | 'POLYGON'
  | 'STAR'
  | 'VECTOR'
  | 'TEXT'
  | 'COMPONENT'
  | 'COMPONENT_SET'
  | 'INSTANCE'
  | 'BOOLEAN_OPERATION'
  /** Slice: an export area (not drawn itself). */
  | 'SLICE'
  /** Style (color, text, effects, grid) — on the internal resources page. */
  | 'STYLE'
  /** Variable collection with modes and its variables — in the same place. */
  | 'VARIABLE_COLLECTION'
  | 'VARIABLE'
  /** Comment: the thread is on the internal comments page, replies are its children (comments.ts). */
  | 'COMMENT';

/** Affine matrix [a, b, c, d, e, f]: x' = a·x + b·y + c, y' = d·x + e·y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBA extends RGB {
  a: number;
}

/** Layer label color (MFP extension): names, not values — the UI theme picks the shade. */
export type LayerLabel = 'RED' | 'ORANGE' | 'YELLOW' | 'GREEN' | 'BLUE' | 'VIOLET' | 'GRAY';

export type BlendMode =
  | 'PASS_THROUGH'
  | 'NORMAL'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'LINEAR_BURN'
  | 'COLOR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'LINEAR_DODGE'
  | 'COLOR_DODGE'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY';

interface PaintBase {
  visible?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  /** Paint color from a variable (like boundVariables on SolidPaint in Plugin API); a gradient — from a composite variable (MFP extension). */
  boundVariables?: { color?: VariableAlias; gradient?: VariableAlias };
}

/** Variable reference (like VariableAlias in Plugin API). */
export interface VariableAlias {
  type: 'VARIABLE_ALIAS';
  id: string;
}

/** Expression (our extension): “{Spacing/base} * 2”, “alpha({Brand/primary}, 0.5)”. */
export interface VariableExpression {
  type: 'EXPRESSION';
  expression: string;
}

/** Composite “Gradient” variable (MFP extension; like the gradient token in DTCG): stop color is a value or a reference. */
export interface GradientVariableValue {
  type: 'GRADIENT';
  gradientType: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  /** Linear gradient angle, degrees — as in CSS (90 — left to right). */
  angle: number;
  stops: { position: number; color: RGBA | VariableAlias }[];
}

/** Composite “Shadows” variable (like the shadow token in DTCG): one or more, inner ones — inner. */
export interface ShadowVariableValue {
  type: 'SHADOWS';
  shadows: { inner?: boolean; color: RGBA | VariableAlias; x: number; y: number; blur: number; spread: number }[];
}

/** Composite “Typography” variable (like the typography token in DTCG): font, style and size are a value or a reference. */
export interface TypographyVariableValue {
  type: 'TYPOGRAPHY';
  fontFamily: string | VariableAlias;
  fontStyle: string | VariableAlias;
  fontSize: number | VariableAlias;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
}

/** Variable value in a mode: color, number, string, boolean, reference to another variable, expression or composite (MFP extension). */
export type VariableValue = boolean | number | string | RGBA | VariableAlias | VariableExpression | GradientVariableValue | ShadowVariableValue | TypographyVariableValue;

/** Variable collection mode (light, dark, brand…). */
export interface VariableMode {
  modeId: string;
  name: string;
  /** Extended collection mode: which parent mode it extends. */
  parentModeId?: string;
}

/**
 * Component property (like ComponentPropertyDefinitions in Plugin API). The property key is
 * “name#id” for boolean, text and instance swap properties, and the name for variants.
 */
export interface ComponentPropertyDefinition {
  type: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP' | 'VARIANT' | 'SLOT';
  /** Default: boolean, text, component id (swap) or variant value; empty for a slot. */
  defaultValue: string | boolean;
  /** Variant: values in order (as in the variant grid). */
  variantOptions?: string[];
  /** Instance swap and slot: preferred components and sets (ids). */
  preferredValues?: string[];
  /** Slot: how many items can be placed (0 — unlimited). */
  minChildren?: number;
  maxChildren?: number;
  description?: string;
}

/** Which node fields inside the component are set by properties (property keys). */
export interface ComponentPropertyReferences {
  visible?: string;
  characters?: string;
  mainComponent?: string;
  /** The frame is a slot: in an instance its content can be changed (added, removed, reordered). */
  slot?: string;
}

// ---------- Prototypes ----------

export type TriggerType = 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'ON_DRAG' | 'AFTER_TIMEOUT' | 'MOUSE_ENTER' | 'MOUSE_LEAVE' | 'MOUSE_UP' | 'MOUSE_DOWN' | 'ON_KEY_DOWN' | 'ON_MEDIA_HIT' | 'ON_MEDIA_END' | 'ON_SCROLL' | 'ON_DOUBLE_CLICK' | 'ON_RIGHT_CLICK' | 'ON_TEXT_INPUT';

/** Trigger: click, hover (“while hovering”), press, drag, delay, mouse enter and leave, key. */
export type Trigger =
  | { type: 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'ON_DRAG' | 'ON_MEDIA_END' }
  /** Double and right click (MFP extension). A single click on the same layer waits to see whether a second one follows. */
  | { type: 'ON_DOUBLE_CLICK' | 'ON_RIGHT_CLICK' }
  | { type: 'AFTER_TIMEOUT'; timeout: number }
  | { type: 'MOUSE_ENTER' | 'MOUSE_LEAVE' | 'MOUSE_UP' | 'MOUSE_DOWN'; delay: number }
  | { type: 'ON_KEY_DOWN'; device: 'KEYBOARD' | 'XBOX_ONE' | 'PS4' | 'SWITCH_PRO' | 'UNKNOWN_CONTROLLER'; keyCodes: number[] }
  | { type: 'ON_MEDIA_HIT'; mediaHitTime: number }
  /**
   * Scroll (MFP extension): on the layer's nearest scrollable ancestor (or the screen itself).
   * OFFSET — scrolled by offset pixels (DOWN — down or right, UP — back, ANY —
   * either way); IN_VIEW — the layer entered the visible area.
   */
  | { type: 'ON_SCROLL'; scroll: 'OFFSET' | 'IN_VIEW'; offset: number; direction: 'DOWN' | 'UP' | 'ANY' }
  /** Input in a field (MFP extension): on an input-field layer; submit — on Enter, otherwise on every change. */
  | { type: 'ON_TEXT_INPUT'; submit: boolean };

/**
 * Input field in playback (MFP extension): the layer (or the first text in it) is edited in playback
 * as a real field; the value goes into a string variable (it can be bound to text and checked in conditions).
 */
export interface PrototypeInput {
  variableId?: string;
  kind?: 'TEXT' | 'PASSWORD' | 'EMAIL' | 'NUMBER' | 'MULTILINE';
  /** Placeholder in an empty field; none — the layer text before input. */
  placeholder?: string;
}

/** Transition curve: presets, custom cubic Bézier, springs (presets and custom). */
export interface Easing {
  /** HOLD — animation keys only: the value holds until the next key, then jumps. */
  type: 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_AND_OUT' | 'LINEAR' | 'EASE_IN_BACK' | 'EASE_OUT_BACK' | 'EASE_IN_AND_OUT_BACK' | 'CUSTOM_CUBIC_BEZIER' | 'GENTLE' | 'QUICK' | 'BOUNCY' | 'SLOW' | 'CUSTOM_SPRING' | 'HOLD';
  easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number };
  /**
   * Spring: physical (mass, stiffness, damping) or, if bounce is set (0…1
   * Motion), — bounciness at the transition duration: 0 — no overshoot, higher — stronger oscillation.
   */
  easingFunctionSpring?: { mass: number; stiffness: number; damping: number; initialVelocity: number; bounce?: number };
}

export type TransitionDirection = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';

/** Transition: dissolve, morph (SMART_ANIMATE), scroll; move in, slide in, push — with a direction. */
export type Transition =
  | { type: 'DISSOLVE' | 'SMART_ANIMATE' | 'SCROLL_ANIMATE'; easing: Easing; duration: number }
  | { type: 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT'; direction: TransitionDirection; matchLayers: boolean; easing: Easing; duration: number };

/** Where a node action leads: navigate, swap overlay, open overlay, scroll to, change variant. */
export type Navigation = 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO' | 'CHANGE_TO';

/** Value for variable actions (like VariableData in Plugin API): a value, a reference or an expression. */
export interface PrototypeValue {
  type: 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR' | 'VARIABLE_ALIAS' | 'EXPRESSION';
  resolvedType?: 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR';
  value?: boolean | number | string | RGBA | VariableAlias | { expressionFunction: string; expressionArguments: PrototypeValue[] };
}

/** Action (like Action in Plugin API). */
export type PrototypeAction =
  | { type: 'BACK' | 'CLOSE' }
  | { type: 'URL'; url: string; openInNewTab?: boolean }
  | {
      type: 'NODE';
      destinationId: string | null;
      navigation: Navigation;
      transition: Transition | null;
      preserveScrollPosition?: boolean;
      overlayRelativePosition?: { x: number; y: number };
      resetScrollPosition?: boolean;
      resetInteractiveComponents?: boolean;
    }
  | { type: 'SET_VARIABLE'; variableId: string | null; variableValue?: PrototypeValue }
  | { type: 'SET_VARIABLE_MODE'; variableCollectionId: string | null; variableModeId: string | null }
  | { type: 'CONDITIONAL'; conditionalBlocks: { condition?: PrototypeValue; actions: PrototypeAction[] }[] }
  | {
      type: 'UPDATE_MEDIA_RUNTIME';
      destinationId: string | null;
      mediaAction: 'PLAY' | 'PAUSE' | 'TOGGLE_PLAY_PAUSE' | 'MUTE' | 'UNMUTE' | 'TOGGLE_MUTE_UNMUTE' | 'SKIP_FORWARD' | 'SKIP_BACKWARD' | 'SKIP_TO';
      amountToSkip?: number;
      newTimestamp?: number;
    }
  /** Sound (MFP extension): a file in storage by hash (like video), volume 0…1. */
  | { type: 'SOUND'; soundHash: string | null; name?: string; volume?: number };

/** Reaction: a trigger and actions in order. */
export interface Reaction {
  trigger: Trigger | null;
  actions: PrototypeAction[];
}

/** Flow starting point on a page. */
export interface FlowStartingPoint {
  nodeId: string;
  name: string;
  description?: string;
  /** Custom flow device (MFP extension); none — the page device. */
  device?: PrototypeDevice;
}

/** Presentation device: none (screen size), preset, custom, presentation (fit to window). */
export interface PrototypeDevice {
  type: 'NONE' | 'PRESET' | 'CUSTOM' | 'PRESENTATION';
  size?: { width: number; height: number };
  presetIdentifier?: string;
  rotation?: 'NONE' | 'CCW_90';
}

/**
 * Ellipse arc (like ArcData in Plugin API): angles in radians clockwise from “3 o'clock”,
 * innerRadius — inner radius ratio (0 — a sector, larger — a ring).
 */
export interface ArcData {
  startingAngle: number;
  endingAngle: number;
  innerRadius: number;
}

/**
 * Layer export setting (like ExportSettings in Plugin API): format, size (scale, width or
 * height — for PNG and JPG), file name suffix; for SVG — outlined text and layer ids.
 */
export interface ExportSetting {
  /** WEBP and AVIF — MFP extension (not in Figma). */
  format: 'PNG' | 'JPG' | 'WEBP' | 'AVIF' | 'SVG' | 'PDF';
  suffix?: string;
  /** JPG, WEBP, AVIF quality: 1–100 (MFP extension; none — the format default). */
  quality?: number;
  constraint?: { type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number };
  /** Contents only (without what is under the layer) — always so for us. */
  contentsOnly?: boolean;
  useAbsoluteBounds?: boolean;
  svgOutlineText?: boolean;
  svgIdAttribute?: boolean;
  svgSimplifyStroke?: boolean;
}

/**
 * Comment (without accounts: the author is the participant's name). A thread also has a location:
 * page, anchor layer and a point in its coordinates (no anchor — in page coordinates), and whether it is resolved.
 */
export interface CommentData {
  author: string;
  /** Author badge color. */
  color?: string;
  text: string;
  /** Creation and edit time, ms since 1970. */
  created: number;
  edited?: number;
  page?: string;
  anchor?: string;
  at?: [number, number];
  /** Point on the page at creation or move — if the anchor no longer exists. */
  pageAt?: [number, number];
  resolved?: boolean;
}

/**
 * Status for development (like devStatus in Plugin API). versionId — the file version at the time of
 * marking: changes are compared against it (our addition).
 */
export interface DevStatus {
  type: 'READY_FOR_DEV' | 'COMPLETED';
  description?: string;
  /** When it was marked, ms since 1970. */
  updated?: number;
  versionId?: string;
}

/**
 * Component-to-code link (like Code Connect): a template in language language, {{Property name}} — the
 * instance property value, {{name}} — the layer name; source — where the component is in code (path or link).
 */
export interface CodeConnect {
  language: string;
  template: string;
  source?: string;
}

/** Layer property pinned in an annotation (the value is shown next to the text). */
export type AnnotationPropertyType =
  | 'width'
  | 'height'
  | 'maxWidth'
  | 'minWidth'
  | 'maxHeight'
  | 'minHeight'
  | 'fills'
  | 'strokes'
  | 'effects'
  | 'strokeWeight'
  | 'cornerRadius'
  | 'textStyleId'
  | 'textAlignHorizontal'
  | 'fontFamily'
  | 'fontStyle'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'itemSpacing'
  | 'padding'
  | 'layoutMode'
  | 'alignItems'
  | 'opacity'
  | 'mainComponent'
  | 'gridRowGap'
  | 'gridColumnGap'
  | 'gridRowCount'
  | 'gridColumnCount'
  | 'gridRowAnchorIndex'
  | 'gridColumnAnchorIndex'
  | 'gridRowSpan'
  | 'gridColumnSpan';

/** Layer annotation (like Annotation in Plugin API): Markdown text, pinned properties, category. */
export interface Annotation {
  labelMarkdown?: string;
  properties?: { type: AnnotationPropertyType }[];
  categoryId?: string;
}

export interface AnnotationCategory {
  id: string;
  label: string;
  color: 'yellow' | 'orange' | 'red' | 'pink' | 'violet' | 'blue' | 'teal' | 'green';
  isPreset: boolean;
}

export type MeasurementSide = 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT';

/** Measurement between the sides of two layers (like Measurement in Plugin API). */
export interface Measurement {
  id: string;
  start: { node: string; side: MeasurementSide };
  end: { node: string; side: MeasurementSide };
  /** INNER — fraction along the first layer; OUTER — this many px outside. */
  offset: { type: 'INNER'; relative: number } | { type: 'OUTER'; fixed: number };
  /** Custom text instead of the number. */
  freeText: string;
}

/** Shadow fields taken from variables. */
export type EffectVariableField = 'color' | 'radius' | 'spread' | 'offsetX' | 'offsetY';

export interface SolidPaint extends PaintBase {
  type: 'SOLID';
  color: RGB;
}

export interface ColorStop {
  position: number;
  color: RGBA;
}

export interface GradientPaint extends PaintBase {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  /** As in Plugin API: [[a, b, c], [d, e, f]]. */
  gradientTransform: [[number, number, number], [number, number, number]];
  gradientStops: ColorStop[];
}

/** Image adjustment, as in Plugin API: each value from −1 to 1, 0 — no change. */
export interface ImageFilters {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}

export interface ImagePaint extends PaintBase {
  type: 'IMAGE';
  filters?: ImageFilters;
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  imageHash: string | null;
  scalingFactor?: number;
  /** For CROP: as in Plugin API, [[a, b, c], [d, e, f]]. */
  imageTransform?: [[number, number, number], [number, number, number]];
  /** Original image width (for choosing the resolution when loading). */
  originalWidth?: number;
  /** Image rotation in degrees, a multiple of 90 (FILL, FIT, TILE), as in Plugin API. */
  rotation?: number;
}

/**
 * Prepared path: an SVG path (M, L, Q, C, Z; space-separated numbers) right in data
 * or a reference to the document geometry table (blob) — identical paths are stored once.
 */
export interface VectorPath {
  windingRule: 'NONZERO' | 'EVENODD';
  data?: string;
  blob?: string;
  /** The path's own fills (a vector network region with its own fill); none — the node's fills. */
  fills?: Paint[];
}

/** Vertex handle mirroring (like HandleMirroring in Plugin API). */
export type HandleMirroring = 'NONE' | 'ANGLE' | 'ANGLE_AND_LENGTH';

/** Vector network vertex (like VectorVertex in Plugin API). */
export interface VectorVertex {
  x: number;
  y: number;
  strokeCap?: StrokeCap;
  strokeJoin?: 'MITER' | 'BEVEL' | 'ROUND';
  cornerRadius?: number;
  handleMirroring?: HandleMirroring;
}

/** Network segment: tangents are relative to its vertices (zero or absent — a straight line). */
export interface VectorSegment {
  start: number;
  end: number;
  tangentStart?: { x: number; y: number };
  tangentEnd?: { x: number; y: number };
}

/** Network region: loops are segment indices in traversal order; its own fills or the node's fills. */
export interface VectorRegion {
  windingRule: 'NONZERO' | 'EVENODD';
  loops: number[][];
  fills?: Paint[];
  fillStyleId?: string;
}

/** Vector network (like VectorNetwork in Plugin API): unlike paths, it can branch. */
export interface VectorNetwork {
  vertices: VectorVertex[];
  segments: VectorSegment[];
  regions?: VectorRegion[];
}

/**
 * Prepared text layout (derived data, while there is no own text engine):
 * glyphs are references to paths in the geometry table (em units, Y axis up),
 * each glyph: [path key, x, baseline y, font size, style index in runs].
 */
export interface TextGlyphs {
  runs: { fills?: Paint[] }[];
  glyphs: [string, number, number, number, number][];
}

/**
 * Video in a fill (like VideoPaint in Plugin API): bytes are in image storage by videoHash;
 * plays muted on the canvas, in playback — according to the layer settings and prototype actions.
 */
export interface VideoPaint extends PaintBase {
  type: 'VIDEO';
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  videoHash: string | null;
  filters?: ImageFilters;
  scalingFactor?: number;
  /** For CROP: as in Plugin API, [[a, b, c], [d, e, f]]. */
  videoTransform?: [[number, number, number], [number, number, number]];
  rotation?: number;
}

/**
 * Lottie in a fill (MFP extension): file bytes (.json or .lottie) are in image storage by
 * lottieHash. Drawn as vectors at any scale; loops on the canvas, in playback follows the
 * layer settings (videoPlayback) and prototype actions, like video. speed — playback speed (1 — normal).
 */
export interface LottiePaint extends PaintBase {
  type: 'LOTTIE';
  scaleMode: 'FILL' | 'FIT' | 'TILE';
  lottieHash: string | null;
  scalingFactor?: number;
  speed?: number;
}

/** 3D model view: rotation around the vertical axis and tilt (degrees), zoom (1 — the model fits). */
export interface ModelCamera {
  yaw: number;
  pitch: number;
  zoom: number;
}

/**
 * 3D model in a fill (MFP extension): glTF bytes (.glb or .gltf with embedded data) are in
 * image storage by modelHash. Rendered by three.js: on the canvas — a still frame (view camera, moment
 * pose of clip clip), in playback the clip plays (layer settings videoPlayback and prototype actions,
 * as for video), orbit — the model can be rotated with the mouse or a finger, autoRotate — it rotates by itself.
 */
export interface Model3DPaint extends PaintBase {
  type: 'MODEL3D';
  modelHash: string | null;
  scaleMode: 'FIT' | 'FILL';
  camera?: ModelCamera;
  /** Animation clip by name; none — the file's first clip; '' — no animation. */
  clip?: string;
  /** Clip moment on the canvas (still frame), seconds. */
  pose?: number;
  lighting?: 'STUDIO' | 'SOFT' | 'CONTRAST';
  orbit?: boolean;
  autoRotate?: boolean;
}

/**
 * Pattern (like PatternPaint in Plugin API): a tile from another layer of the document (the source);
 * editing the source changes all patterns using it. The tile is the source bounds (with rotation),
 * scalingFactor — scale, spacing — gaps as fractions of the tile, hexagonal grids shift every other row
 * (or column) by half a tile.
 */
export interface PatternPaint extends PaintBase {
  type: 'PATTERN';
  sourceNodeId: string;
  tileType: 'RECTANGULAR' | 'HORIZONTAL_HEXAGONAL' | 'VERTICAL_HEXAGONAL';
  scalingFactor: number;
  spacing: { x: number; y: number };
  horizontalAlignment: 'START' | 'CENTER' | 'END';
}

/**
 * Shader fill (MFP extension): SkSL code with half4 main(float2 p), p is a point
 * of the layer. The renderer sets the size and time uniforms; other uniforms are parameters (params, by name).
 */
export interface ShaderPaint extends PaintBase {
  type: 'SHADER';
  code: string;
  /** Native single-pass WGSL fill; no JavaScript from the document is executed. */
  wgsl?: WgslFill;
  /** Imported Figma resource; .fig may contain its reference without executable source. */
  figma?: { reference: unknown; assignments: unknown[]; definition?: unknown };
  /** Parameter values: number — [v], color — [r, g, b, a] (0…1). None — the default from the code. */
  params?: Record<string, number[]>;
  /** The preset shader the code came from (for the label in the panel). */
  preset?: string;
  /** Play the animation (uniform time) in playback; on the canvas — a still frame. Default — yes. */
  animate?: boolean;
}

export interface WgslFill {
  name: string;
  source: string;
  /** Uniform buffer: frame(time seconds, width, height, 0), input dimensions, then these vec4 slots. */
  uniforms: { name: string; label: string; kind: 'float' | 'color'; value: number[]; min?: number; max?: number }[];
}

/**
 * Mesh gradient (MFP extension): colored
 * points anywhere on the layer, colors blend smoothly between them (inverse distances). x, y — fractions
 * of the layer bounds; spread — point strength, a fraction of the larger side of the bounds (default 0.5).
 */
export interface FreeformGradientPaint extends PaintBase {
  type: 'GRADIENT_FREEFORM';
  points: { x: number; y: number; color: RGBA; spread?: number }[];
}

export type Paint = SolidPaint | GradientPaint | FreeformGradientPaint | ImagePaint | VideoPaint | LottiePaint | Model3DPaint | PatternPaint | ShaderPaint;

/**
 * End of an open path (like StrokeCap in Plugin API): none, round, square;
 * arrows — lines, triangle, reversed triangle, circle, diamond.
 */
export type StrokeCap = 'NONE' | 'ROUND' | 'SQUARE' | 'ARROW_LINES' | 'ARROW_EQUILATERAL' | 'TRIANGLE_FILLED' | 'CIRCLE_FILLED' | 'DIAMOND_FILLED';

export interface ShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGBA;
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
  visible: boolean;
  blendMode: BlendMode;
  /** The shadow is visible behind transparent parts of the layer too (default — outside only), as in Plugin API. */
  showShadowBehindNode?: boolean;
  boundVariables?: Partial<Record<EffectVariableField, VariableAlias>>;
}

export interface BlurEffect {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
  visible: boolean;
  boundVariables?: { radius?: VariableAlias };
  /**
   * Progressive blur (blurType PROGRESSIVE in Plugin API): from startRadius at point startOffset
   * to radius at point endOffset; points are fractions of the layer bounds (0–1). None — a regular blur.
   */
  blurType?: 'NORMAL' | 'PROGRESSIVE';
  startRadius?: number;
  startOffset?: { x: number; y: number };
  endOffset?: { x: number; y: number };
}

/**
 * Noise over the layer (like NoiseEffect in Plugin API): one color, two (secondaryColor) or
 * multicolor (opacity); noiseSize — grain size, px; density — fraction of filled grains (0–1).
 */
export interface NoiseEffect {
  type: 'NOISE';
  noiseType: 'MONOTONE' | 'DUOTONE' | 'MULTITONE';
  color: RGBA;
  secondaryColor?: RGBA;
  opacity?: number;
  noiseSize: number;
  density: number;
  blendMode: BlendMode;
  visible: boolean;
  boundVariables?: Partial<Record<string, VariableAlias>>;
}

/** Texture (like TextureEffect): the layer's edges and fill get “grainy”; radius — strength, clipToShape — within the shape. */
export interface TextureEffect {
  type: 'TEXTURE';
  noiseSize: number;
  radius: number;
  clipToShape: boolean;
  visible: boolean;
  boundVariables?: Partial<Record<string, VariableAlias>>;
}

/**
 * Glass (like GlassEffect): the background under the layer refracts at the edges (refraction 0–1 over
 * depth depth, px) and splits into colors (dispersion 0–1), blurred by radius (frosting); the highlight
 * follows the light angle lightAngle (degrees) with strength lightIntensity (0–1).
 */
export interface GlassEffect {
  type: 'GLASS';
  lightIntensity: number;
  lightAngle: number;
  refraction: number;
  depth: number;
  dispersion: number;
  radius: number;
  visible: boolean;
  boundVariables?: Partial<Record<string, VariableAlias>>;
}

/** Shader over the isolated layer, including children. content.eval(p) returns premultiplied RGBA. */
export interface ShaderEffect {
  type: 'SHADER';
  boundVariables?: never;
  code: string;
  params?: Record<string, number[]>;
  preset?: string;
  animate?: boolean;
  visible: boolean;
}

/** Opaque imported effect. Kept in its original stack position until a renderer supports it. */
export interface UnsupportedFigmaEffect {
  type: 'UNSUPPORTED_FIGMA';
  visible: boolean;
  boundVariables?: never;
  originalType: string;
  raw: Record<string, unknown>;
  definition?: unknown;
}

export type Effect = ShadowEffect | BlurEffect | NoiseEffect | TextureEffect | GlassEffect | ShaderEffect | UnsupportedFigmaEffect;

export interface FontName {
  family: string;
  style: string;
}

/** Line height (as in the plugin API): from font metrics, in pixels or as a percentage of font size. */
export type LineHeight = { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };

/** Letter spacing: in pixels or as a percentage of font size. */
export interface LetterSpacing {
  unit: 'PIXELS' | 'PERCENT';
  value: number;
}

/** Link in text (like HyperlinkTarget in Plugin API): a URL or a document node. */
export interface Hyperlink {
  type: 'URL' | 'NODE';
  value: string;
}

/** Underline thickness: from the font, in pixels or as a percentage of font size. */
export type DecorationThickness = { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };
/** Underline offset down from the baseline: from the font, in pixels or as a percentage of font size. */
export type DecorationOffset = DecorationThickness;

/**
 * Stroke width point (variable width): position on the path as a fraction of the total
 * length (0–1, paths in sequence), width to the left (ascent) and right (descent) of the center line, px.
 */
export interface WidthPoint {
  position: number;
  ascent: number;
  descent: number;
}

/** Widget property menu item (usePropertyMenu):. */
export interface WidgetMenuItem {
  itemType: 'action' | 'dropdown' | 'color-selector' | 'toggle' | 'separator' | 'link';
  tooltip?: string;
  propertyName?: string;
  icon?: string;
  options?: { option: string; label?: string; tooltip?: string }[];
  selectedOption?: string;
  isToggled?: boolean;
  href?: string;
}

/**
 * Widget (Figma widget API): a frame whose children are drawn by the widget code in the plugin sandbox.
 * pluginId — the plugin with the widget; state — useSyncedState and useSyncedMap (shared by all participants);
 * menu — the property menu from the last render (shown on the selected widget).
 */
export interface WidgetData {
  pluginId: string;
  name: string;
  state: Record<string, unknown>;
  menu?: WidgetMenuItem[] | null;
}

/**
 * Stroke brush (Draw; the set is our own): stretch (brush shape along the path), scatter
 * (stamps along the path), dynamic (a wavy line). Width — strokeWeight, color — stroke paints.
 */
export interface StrokeBrush {
  type: 'STRETCH' | 'SCATTER' | 'DYNAMIC';
  /** Brush from the set: ink, marker, bristle, pencil, calligraphy; dots, stars, confetti, leaves; dynamic. */
  name: string;
  /** Scatter: step between stamps and cross offset (fractions of width), random size and rotation (0…1). */
  spacing?: number;
  scatter?: number;
  sizeJitter?: number;
  rotationJitter?: number;
  /** Dynamic: waves per 100 px and their amplitude (fraction of width). */
  frequency?: number;
  wiggle?: number;
  /** Random seed (the pattern stays the same). */
  seed?: number;
}

/** Variable font axis and its value (like font-variation-settings in CSS): wght, wdth, slnt, opsz… */
export interface FontVariation {
  axis: string;
  value: number;
}

/** Text properties that part of the text can have (range styles). */
export type TextStyleKey =
  | 'fontName'
  | 'fontSize'
  | 'fills'
  | 'letterSpacing'
  | 'lineHeight'
  | 'textCase'
  | 'textDecoration'
  | 'textDecorationStyle'
  | 'textDecorationThickness'
  | 'textDecorationColor'
  | 'textDecorationOffset'
  | 'textDecorationSkipInk'
  | 'hyperlink'
  | 'openTypeFeatures'
  | 'fontVariations'
  | 'listType'
  | 'indentation'
  | 'textStyleId'
  | 'fillStyleId';

/** Text run formatting — only differences from the node (names match node properties). */
export type TextStyle = Partial<Pick<NodeProps, TextStyleKey>>;

/** Text run: length in UTF-16 code units and its formatting (like StyledTextSegment in Plugin API). */
export interface TextRun {
  length: number;
  style: TextStyle;
}

/** Columns, rows or a grid in a frame (layout guide, like LayoutGrid in the Figma plugin API). */
export type LayoutGrid =
  | {
      pattern: 'COLUMNS' | 'ROWS';
      /** STRETCH — bands across the full width between offset margins; otherwise width sectionSize from an edge or centered. */
      alignment: 'MIN' | 'MAX' | 'STRETCH' | 'CENTER';
      count: number;
      gutterSize: number;
      sectionSize?: number;
      offset?: number;
      visible?: boolean;
      color?: RGBA;
    }
  | { pattern: 'GRID'; sectionSize: number; visible?: boolean; color?: RGBA };

/** Auto layout grid track: fractions of free space (fr), pixels or by content. */
export interface GridTrackSize {
  type: 'FLEX' | 'FIXED' | 'HUG';
  value?: number;
}

/** Layer behavior when the parent is resized. */
export type ConstraintType = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE';
export interface Constraints {
  horizontal: ConstraintType;
  vertical: ConstraintType;
}

/** Page guide: X — a vertical line, Y — horizontal. */
export interface Guide {
  axis: 'X' | 'Y';
  offset: number;
}

/** Node properties. Which properties are meaningful depends on the type (see DEFAULTS). */
export interface NodeProps {
  /** Opt-in rotation in the editor for sections; absent means disabled. */
  sectionRotationEnabled?: boolean;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  /** Position relative to the parent. */
  transform: Matrix;
  /** 3D layer rotation, degrees (see transform3d.ts): around the horizontal and vertical axes. */
  rotateX: number;
  rotateY: number;
  /** 3D: distance to the viewer, px (none — 1000). */
  perspective: number;
  /** 3D: offset toward the viewer, px. */
  translateZ: number;
  width: number;
  height: number;
  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  strokeJoin: 'MITER' | 'BEVEL' | 'ROUND';
  /** Dash: alternating dash and gap lengths, px; empty — a solid line. */
  dashPattern: number[];
  /** Animation: the top-level frame's timeline and the layer's property tracks (see animation.ts). */
  timeline: import('./animation.ts').Timeline;
  /** Motion styles applied to the layer (their keys are in animation). */
  animationStyles: import('./animation.ts').AppliedMotionStyle[];
  animation: import('./animation.ts').AnimTrack[];
  /** Document: custom motion styles (saved from layer tracks). */
  motionStyles: import('./animation.ts').MotionStyle[];
  /** Text: animation by letters, words or lines. */
  textAnimation: import('./animation.ts').TextAnimation;
  /** Timeline pose for text animation (moment, seconds); not stored in the document. */
  textAnimationTime: number;
  /** Layer video in playback: autoplay, loop, muted. None — yes, yes, with sound. */
  videoPlayback: { autoplay?: boolean; loop?: boolean; muted?: boolean };
  /** Variable stroke width: width points along the path (empty — strokeWeight everywhere). */
  variableWidthPoints: WidthPoint[];
  /** Stroke brush (the renderer draws it along the center line; alignment and dashes are ignored). */
  strokeBrush: StrokeBrush;
  /**
   * Path trim: the part of the stroke from start to end is visible — fractions
   * of the path length 0…1 (across all paths in sequence). None — 0 and 1 (the whole stroke).
   */
  pathTrimStart: number;
  pathTrimEnd: number;
  /** Widget frame: plugin, state, property menu. */
  widget: WidgetData;
  /** Layer inside a widget with a handler (onClick): element path in the widget tree. */
  widgetHandler: string;
  /** Widget: an Input element's value (empty — the placeholder is shown); edited on the canvas. */
  widgetInput: string;
  /**
   * Per-side stroke weight (rectangles and frames, as in Plugin API). Not set —
   * all sides use strokeWeight; editing strokeWeight resets them.
   */
  strokeTopWeight: number;
  strokeRightWeight: number;
  strokeBottomWeight: number;
  strokeLeftWeight: number;
  /** Ends of open paths (line, vector): start and end. In Plugin API — a single strokeCap. */
  strokeStartCap: StrokeCap;
  strokeEndCap: StrokeCap;
  /** Miter limit, as in SVG: 4 — corners sharper than 28.96° are beveled. */
  strokeMiterLimit: number;
  /** Corner smoothing (superellipse, as in iOS): 0…1, “iOS” — 0.6. */
  cornerSmoothing: number;
  cornerRadius: number;
  /** Individual corner radii; not set — as cornerRadius. */
  topLeftRadius: number;
  topRightRadius: number;
  bottomRightRadius: number;
  bottomLeftRadius: number;
  /** Frame columns, rows and grid (layout guides). */
  layoutGrids: LayoutGrid[];
  /** Constraints: how the layer behaves when the parent is resized. */
  constraints: Constraints;
  /** Keep proportions when resizing (the lock by W and H). */
  constrainProportions: boolean;
  effects: Effect[];
  isMask: boolean;
  /** Mask: by transparency (ALPHA), by shape (VECTOR) or by luminance (LUMINANCE). */
  maskType: 'ALPHA' | 'VECTOR' | 'LUMINANCE';
  clipsContent: boolean;
  characters: string;
  fontSize: number;
  fontName: FontName;
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  /** Text box sizing: auto, fixed width or fixed size. */
  textAutoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  /**
   * Text in a fixed-size box shrinks until it fits (MFP extension): SHRINK — down to textFitMinSize px (default 6).
   */
  textFit: 'NONE' | 'SHRINK';
  /**
   * Text length limit, characters (MFP extension; request “max and min character on text property” —
   * for UX writers and localization): exceeding it is highlighted on the canvas and in “Design check”,
   * the text is not truncated. Empty — no limit.
   */
  textMaxLength: number;
  textMinLength: number;
  textFitMinSize: number;
  /**
   * Text on a path: an SVG path in node coordinates and the offset of the line start
   * along it; the baseline is on the path. The node bounds are the path bounds.
   */
  textPath: { data: string; offset?: number; startData?: { segment: number; position: number } };
  /** Text layer names follow characters until the user names the layer manually. */
  autoRename: boolean;
  textAlignVertical: 'TOP' | 'CENTER' | 'BOTTOM';
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  /** Underline: solid, wavy, dotted; thickness; color (AUTO — the text color). */
  textDecorationStyle: 'SOLID' | 'WAVY' | 'DOTTED';
  textDecorationThickness: DecorationThickness;
  textDecorationColor: RGBA | 'AUTO';
  /** Underline offset (AUTO — from the font) and skipping descenders (as in CSS). */
  textDecorationOffset: DecorationOffset;
  textDecorationSkipInk: boolean;
  /** Variable font axes (empty — the style as is). */
  fontVariations: FontVariation[];
  /** Link (on the whole text or a run). */
  hyperlink: Hyperlink | null;
  /** OpenType features (tag → on/off), as in Plugin API: liga, tnum, ss01… */
  openTypeFeatures: Record<string, boolean>;
  /** List: bullets or numbering; nesting level (for a paragraph — by its first character). */
  listType: 'NONE' | 'ORDERED' | 'UNORDERED';
  indentation: number;
  /** Range styles: consecutive text runs with differences from the node; the tail without runs is as the node. */
  textRuns: TextRun[];
  /** Paragraph first-line indent, spacing between paragraphs and between list items, px. */
  paragraphIndent: number;
  paragraphSpacing: number;
  listSpacing: number;
  /** Hanging punctuation and hanging list markers. */
  hangingPunctuation: boolean;
  hangingList: boolean;
  /** Truncation “…” and max lines (null — no limit). */
  textTruncation: 'DISABLED' | 'ENDING';
  maxLines: number | null;
  /** Vertical trim: the box by cap height and baseline (CAP_HEIGHT). */
  leadingTrim: 'NONE' | 'CAP_HEIGHT';
  /** Line wrapping: normal, balanced line lengths (BALANCE), no lone word at the end (PRETTY). */
  textWrap: 'AUTO' | 'BALANCE' | 'PRETTY';
  pointCount: number;
  /** Layer export settings (for a slice — PNG 1x by default). */
  exportSettings: ExportSetting[];
  /** Star: inner radius ratio (like innerRadius in Plugin API), 0–1. */
  innerRadius: number;
  /** Ellipse: arc, ring, sector (like arcData in Plugin API). */
  arcData: ArcData;
  /** Instance: its main component. */
  componentId: string;
  /** Instance node: the corresponding main node (edits to the main are copied here). */
  componentRef: string;
  /** Instance node: properties changed manually (the main does not overwrite them). */
  overrides: string[];
  /** Description (components, styles, variables). */
  description: string;
  /** Variant set or a component without a set: its properties. */
  componentPropertyDefinitions: Record<string, ComponentPropertyDefinition>;
  /** Instance: property values set on it (the rest are defaults; a variant is its component). */
  componentProperties: Record<string, string | boolean>;
  /** Component node: visibility, text or a nested component are set by properties. */
  componentPropertyReferences: ComponentPropertyReferences;
  /** Frame detached from an instance: the component id (for the design check). */
  detachedFrom: string;
  /** Nested instance in a component: its properties are shown on instances of the outer component. */
  isExposedInstance: boolean;
  /**
   * Which properties of an exposed nested instance to show on instances of the outer component
   * and in what order (property keys of its component); none — all, in definition order.
   */
  exposedProperties?: string[];
  /** Style: what it stores. Values are in regular properties (fills, effects, layoutGrids, text properties). */
  styleType: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  /** Style on a layer (like *StyleId in Plugin API); empty — its own values. Style values are copied into the layer. */
  fillStyleId: string;
  strokeStyleId: string;
  textStyleId: string;
  effectStyleId: string;
  gridStyleId: string;
  /** Library key of a style, component or variable from a Figma file (for updates and links). */
  key: string;
  /** Variable collection: modes and the default mode. */
  modes: VariableMode[];
  defaultModeId: string;
  /**
   * Collection extension: the parent.
   * Variables and modes are the parent's; its own values are in variableOverrides (variable → mode → value).
   */
  extendsCollection: string;
  variableOverrides: Record<string, Record<string, VariableValue>>;
  /** Variable: type, values by mode, where it can be applied, code names. Composite ones (MFP extension) — gradient, shadows, typography. */
  resolvedType: 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR' | 'GRADIENT' | 'SHADOW' | 'TYPOGRAPHY';
  /** Page: protection — editable by the file owners and the listed people (server user ids). */
  pageProtection: { editors: string[] };
  /** Library asset: its version signature in the source at import (used to detect what changed). */
  librarySig: string;
  /** Identity of an imported clipboard dependency; never match foreign resources by name. */
  clipboardSource: { origin: string; signature: string; id: string; modes?: Record<string, string> };
  valuesByMode: Record<string, VariableValue>;
  scopes: string[];
  codeSyntax: { WEB?: string; ANDROID?: string; iOS?: string };
  hiddenFromPublishing: boolean;
  /** Layer fields from variables (field → variable); variable values are copied into the fields. */
  boundVariables: Record<string, VariableAlias>;
  /** Collection mode on a frame or page (collection → mode); descendants use the nearest ancestor's. */
  explicitVariableModes: Record<string, string>;
  /** Internal page (styles, variables, library mains): it is not in the page list. */
  internal: boolean;
  /** Hidden page holding motifs whose visible source was deleted. */
  patternArchive: boolean;
  /** Original node ID resolved by pattern paints after deletion. */
  preservedPatternSource: string;
  /** Internal comments page (together with internal). */
  commentsPage: boolean;
  /** Comment or reply (a COMMENT node). */
  comment: CommentData;
  /** Developer mode: layer status, its annotations; on the document — annotation categories, on a page — measurements. */
  devStatus: DevStatus | null;
  annotations: Annotation[];
  annotationCategories: AnnotationCategory[];
  measurements: Measurement[];
  /** Component or variant set: code link (code-connect.ts). */
  codeConnect: CodeConnect[];
  /** Asset from a connected library: its name (updates and disconnecting use it). */
  library: string;
  /** On the document: connected team libraries (library file id → name and version). */
  teamLibraries: Record<string, { name: string; version: number }>;
  /** On the document: root font size (1 rem), px — for rem units in fields and variables (none — 16). */
  rootFontSize: number;
  /**
   * On a number variable: the value unit, as in CSS (none — pixels or a plain number).
   * REM — × the document root font size; PERCENT — percent (line height and letter
   * spacing — of the font size); MULTIPLIER — unitless: line height as a multiple of the font size.
   */
  unit: 'REM' | 'PERCENT' | 'MULTIPLIER';
  /** Prototype: layer reactions (trigger → actions). */
  reactions: Reaction[];
  /** Prototype: the layer is an input field in playback (MFP extension). */
  prototypeInput: PrototypeInput;
  /** Frame content scrolling in a prototype. */
  overflowDirection: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH';
  /** Layer in a scrolling frame: scrolls, fixed, “sticky”. */
  scrollBehavior: 'SCROLLS' | 'FIXED' | 'STICKY_SCROLLS';
  /** Frame as an overlay: where to show it, background dimming, close on click outside. */
  overlayPositionType: 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT' | 'MANUAL';
  overlayBackground: { type: 'NONE' } | { type: 'SOLID_COLOR'; color: RGBA };
  overlayBackgroundInteraction: 'NONE' | 'CLOSE_ON_CLICK_OUTSIDE';
  /** Page: flow starting points, presentation device and background. */
  flowStartingPoints: FlowStartingPoint[];
  /** Document: the file cover layer (thumbnail in “Files”; setFileThumbnailNodeAsync in the plugin API). */
  thumbnailNodeId: string;
  /** Development links: Storybook, repository, issue, documentation. */
  devResources: { name: string; url: string }[];
  prototypeDevice: PrototypeDevice;
  prototypeBackgrounds: Paint[];
  /** Boolean operation on children (on a BOOLEAN_OPERATION node). */
  booleanOperation: 'UNION' | 'INTERSECT' | 'SUBTRACT' | 'EXCLUDE';
  /** Plugin data: pluginId → key → value. */
  pluginData: Record<string, Record<string, string>>;
  sharedPluginData: Record<string, Record<string, string>>;
  /** Page background. */
  backgrounds: Paint[];
  /** Page folder in the page list (MFP extension): pages with the same folder name are grouped. */
  pageFolder: string;
  /** Colored layer label: a stripe in the layer list, the frame name color on the canvas (MFP extension). */
  labelColor: LayerLabel;
  /** Document: saved canvas views — page, center and zoom (MFP extension). */
  savedViews: { id: string; name: string; pageId: string; x: number; y: number; zoom: number }[];
  /** Document: formatting of new text — font, size, spacing, color, style (MFP extension). */
  defaultTextStyle: Partial<NodeProps>;
  /** Document: formatting of new shapes — fill, stroke, corner radius, effects (MFP extension). */
  defaultShapeStyle: Partial<NodeProps>;
  /** Free distort: bounds corners (TL, TR, BR, BL) go to these points, x and y in turn, fractions of width and height (MFP extension). */
  distort: number[];
  /** Frame repeated as a grid (MFP extension, like Repeat Grid in Adobe XD): cells are a main component and its instances. */
  repeatGrid: { columns: number; rows: number; gapX: number; gapY: number };
  /** Document: length units in fields, rulers and labels (MFP extension). None — px. */
  documentUnits: { unit: 'px' | 'mm' | 'cm' | 'in' | 'pt'; dpi: number };
  /** Page guides. */
  guides: Guide[];
  /**
   * Derived geometry (for example, imported from .fig): fill and stroke paths,
   * text paths. geometrySize — the node size the paths were computed at;
   * if the node was stretched, the paths are scaled.
   */
  vectorPaths: VectorPath[];
  /**
   * Path center lines for the stroke (import: from the vector network; open ones without Z).
   * Not set — the stroke is built from vectorPaths.
   */
  centerPaths: VectorPath[];
  /**
   * The vector's vector network — the source of truth for editing (a key in the geometry table, compact
   * JSON, see vector-network.ts). Fill paths and center lines are derived from it.
   */
  vectorNetwork: { blob?: string; data?: string };
  strokePaths: VectorPath[];
  textGlyphs: TextGlyphs;
  geometrySize: { width: number; height: number };

  // ---------- Auto layout (names and values —) ----------
  /** Child layout: none, row, column, grid. */
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  /** Absent in older documents: preserve legacy layout. */
  layoutVersion: 'LEGACY' | 'LATEST';
  /** Grid: row and column tracks, gaps. */
  gridRowSizes: GridTrackSize[];
  gridColumnSizes: GridTrackSize[];
  gridRowGap: number;
  gridColumnGap: number;
  /** Grid child: cell (zero-based; −1 — in order), how many rows and columns it spans, alignment in the cell. */
  gridRowAnchorIndex: number;
  gridColumnAnchorIndex: number;
  gridRowSpan: number;
  gridColumnSpan: number;
  gridChildHorizontalAlign: 'AUTO' | 'MIN' | 'CENTER' | 'MAX';
  gridChildVerticalAlign: 'AUTO' | 'MIN' | 'CENTER' | 'MAX';
  itemSpacing: number;
  /** Spacing between rows when wrapping; null — as itemSpacing. */
  counterAxisSpacing: number | null;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  /** SPACE_* — auto spacing: between, around, evenly. */
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'SPACE_AROUND' | 'SPACE_EVENLY';
  counterAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  /** Size along an axis: FIXED — set, AUTO — by content (“hug”). */
  primaryAxisSizingMode: 'FIXED' | 'AUTO';
  counterAxisSizingMode: 'FIXED' | 'AUTO';
  layoutWrap: 'NO_WRAP' | 'WRAP';
  counterAxisAlignContent: 'AUTO' | 'SPACE_BETWEEN';
  /** Auto layout child: 1 — fill along the main axis. */
  layoutGrow: number;
  /** Auto layout child: STRETCH — fill along the cross axis. */
  layoutAlign: 'INHERIT' | 'STRETCH' | 'MIN' | 'CENTER' | 'MAX';
  /** Auto layout child: ABSOLUTE — out of flow, in its own position. */
  layoutPositioning: 'AUTO' | 'ABSOLUTE';
  /**
   * Auto layout child: width (height) is a percentage of the parent's inner area, like width: 50% in CSS
   * (MFP extension). width / height are then the size computed by the layout.
   */
  widthPercent?: number;
  heightPercent?: number;
  /** Size limits as a percentage of the parent (MFP extension, like min-width: 30% in CSS); take precedence over pixel limits. */
  minWidthPercent: number | null;
  maxWidthPercent: number | null;
  minHeightPercent: number | null;
  maxHeightPercent: number | null;
  /** Stacking order: the first layer in the flow is on top (“Canvas stacking”). */
  itemReverseZIndex: boolean;
  /** Children's strokes take up space in the layout. */
  strokesIncludedInLayout: boolean;
  /** Size limits (on auto layout frames and their children); null — no limit. */
  minWidth: number | null;
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;
}

export type PropName = keyof NodeProps;
export type Props = Partial<NodeProps>;

export interface NodeRecord {
  id: string;
  type: NodeType;
  parent: string | null;
  /** Fractional order index among siblings (smaller — lower in the layer stack). */
  index: string;
  props: Props;
}

/** Document change operations: the basis of sync, undo and CRDT. */
export type Op =
  | { op: 'create'; id: string; type: NodeType; parent: string; index: string; props: Props }
  | { op: 'set'; id: string; props: Props }
  | { op: 'move'; id: string; parent: string; index: string }
  | { op: 'delete'; id: string }
  /** Geometry table entry (append-only; the key is the content hash). */
  | { op: 'blob'; key: string; data: string };

export interface Snapshot {
  version: 1;
  root: string;
  nodes: NodeRecord[];
  /** Geometry table: key → SVG path. */
  blobs?: Record<string, string>;
}

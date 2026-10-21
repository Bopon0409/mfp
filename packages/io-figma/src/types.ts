// Minimal types for a decoded fig-kiwi message.
// The full schema comes from the file; only the fields we read are described here.
// Everything else is accessible through the index signature and preserved on import.

export interface FigGuid {
  sessionID: number;
  localID: number;
}

export interface FigParentIndex {
  guid: FigGuid;
  /** Fractional order index among siblings (a string compared lexicographically). */
  position: string;
}

export interface FigVector {
  x: number;
  y: number;
}

export interface FigColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigMatrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

/** Geometry precomputed by Figma: index into message.blobs with path commands. */
export interface FigPath {
  windingRule?: 'NONZERO' | 'ODD' | string;
  commandsBlob?: number;
  styleID?: number;
}

export interface FigImageRef {
  hash?: Uint8Array;
  name?: string;
  dataBlob?: number;
}

/** Reference to a variable, style or variable set: local (guid) or from a library (asset key). */
export interface FigAssetRef {
  guid?: FigGuid;
  assetRef?: { key?: string; version?: string };
}

/** Variable value or a field binding to a variable (VariableData). */
export interface FigVariableData {
  value?: {
    boolValue?: boolean;
    textValue?: string;
    floatValue?: number;
    alias?: FigAssetRef;
    colorValue?: FigColor;
    [field: string]: unknown;
  };
  dataType?: string;
  resolvedDataType?: string;
}

export interface FigPaint {
  /** Runtime-only prototype dissolve; never written into document paints. */
  crossfade?: { from: FigPaint; to: FigPaint; progress: number };
  customEffectId?: { assetRef?: { key?: string; version?: string }; guid?: FigGuid };
  componentPropAssignments?: unknown[];
  /** Color from a variable. */
  colorVar?: FigVariableData;
  type?: string;
  color?: FigColor;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
  stops?: { color: FigColor; position: number }[];
  /** Freeform gradient (type GRADIENT_FREEFORM, our own): points as fractions of the bounds, color, strength. */
  freeform?: { x: number; y: number; color: FigColor; spread?: number }[];
  transform?: FigMatrix;
  image?: FigImageRef;
  /** Video fill (type VIDEO): video file hash. */
  video?: FigImageRef;
  /** Lottie fill (type LOTTIE, our own): animation file hash and speed. */
  lottie?: FigImageRef & { speed?: number };
  /** 3D model fill (type MODEL3D, our own): glTF file hash and display settings. */
  model?: FigImageRef & { camera?: { yaw: number; pitch: number; zoom: number }; clip?: string; pose?: number; lighting?: string; orbit?: boolean; autoRotate?: boolean; keyed?: boolean };
  imageScaleMode?: string;
  rotation?: number;
  scale?: number;
  originalImageWidth?: number;
  originalImageHeight?: number;
  /** Pattern (type PATTERN): source layer (document id), grid, scale, spacing as tile fractions, alignment. */
  pattern?: { source: string; tileType: string; scale: number; spacing: { x: number; y: number }; align: string };
  /** Shader (type SHADER): SkSL code, parameters by uniform name, whether to play the animation. */
  shader?: { code: string; params: Record<string, number[]>; animate: boolean; wgsl?: import('@mfp/core').WgslFill };
  /** Image adjustment: each value from −1 to 1. */
  paintFilter?: { exposure?: number; contrast?: number; vibrance?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number };
}

export interface FigEffect {
  /** MFP shader effect, applied to the isolated layer and its children. */
  shader?: { code: string; params: Record<string, number[]>; animate: boolean };
  colorVar?: FigVariableData;
  radiusVar?: FigVariableData;
  spreadVar?: FigVariableData;
  xVar?: FigVariableData;
  yVar?: FigVariableData;
  type?: string;
  offset?: FigVector;
  radius?: number;
  spread?: number;
  visible?: boolean;
  color?: FigColor;
  blendMode?: string;
  showShadowBehindNode?: boolean;
  /** Progressive blur: PROGRESSIVE — from startRadius at startOffset to radius at endOffset (bounds fractions). */
  blurOpType?: string;
  startOffset?: FigVector;
  endOffset?: FigVector;
  startRadius?: number;
  /** Noise (NOISE) and texture (GRAIN): grain size, density, color modes, random seed. */
  noiseType?: string;
  noiseSize?: FigVector;
  density?: number;
  secondaryColor?: FigColor;
  opacity?: number;
  seed?: number;
  clipToShape?: boolean;
  /** Glass (GLASS): highlight (angle, strength), refraction (strength, depth), chromatic dispersion. */
  specularAngle?: number;
  specularIntensity?: number;
  refractionIntensity?: number;
  refractionRadius?: number;
  chromaticAberration?: number;
}

export interface FigGlyph {
  commandsBlob?: number;
  position?: FigVector;
  styleID?: number;
  fontSize?: number;
  firstCharacter?: number;
  advance?: number;
  rotation?: number;
}

export interface FigDerivedTextData {
  layoutSize?: FigVector;
  glyphs?: FigGlyph[];
  [field: string]: unknown;
}

export interface FigTextData {
  characters?: string;
  characterStyleIDs?: number[];
  styleOverrideTable?: FigNodeChange[];
  glyphs?: FigGlyph[];
  [field: string]: unknown;
}

export interface FigSymbolData {
  symbolID?: FigGuid;
  symbolOverrides?: FigNodeChange[];
  uniformScaleFactor?: number;
}

export interface FigNodeChange {
  guid?: FigGuid;
  guidPath?: { guids?: FigGuid[] };
  parentIndex?: FigParentIndex;
  type?: string;
  name?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  phase?: string;
  size?: FigVector;
  transform?: FigMatrix;
  fillPaints?: FigPaint[];
  strokePaints?: FigPaint[];
  fillGeometry?: FigPath[];
  strokeGeometry?: FigPath[];
  effects?: FigEffect[];
  mask?: boolean;
  maskType?: string;
  frameMaskDisabled?: boolean;
  styleID?: number;
  textData?: FigTextData;
  derivedTextData?: FigDerivedTextData;
  symbolData?: FigSymbolData;
  derivedSymbolData?: FigNodeChange[];
  overriddenSymbolID?: FigGuid;
  [field: string]: unknown;
}

export interface FigBlob {
  bytes: Uint8Array;
}

export interface FigMessage {
  type?: string;
  nodeChanges?: FigNodeChange[];
  blobs?: FigBlob[];
  [field: string]: unknown;
}

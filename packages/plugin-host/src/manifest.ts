// Plugin manifest in Figma format (manifest.json).

/** Quick action parameter (actions menu): the plugin suggests values as the user types. */
export interface ManifestParameter {
  name: string;
  key: string;
  description?: string;
  /** A custom value not from the suggestions may be entered. */
  allowFreeform?: boolean;
  optional?: boolean;
}

/** Plugin menu item: a command, a submenu or a separator. */
export interface ManifestMenuItem {
  name?: string;
  command?: string;
  menu?: ManifestMenuItem[];
  separator?: boolean;
  parameters?: ManifestParameter[];
  /** false — the command can also run without parameters (from the menu). */
  parameterOnly?: boolean;
}

export interface PluginManifest {
  name: string;
  id: string;
  api: string;
  main: string;
  ui?: string | Record<string, string>;
  editorType?: string[];
  documentAccess?: 'dynamic-page';
  networkAccess?: { allowedDomains: string[]; reasoning?: string; devAllowedDomains?: string[] };
  permissions?: string[];
  menu?: ManifestMenuItem[];
  parameters?: ManifestParameter[];
  parameterOnly?: boolean;
  capabilities?: string[];
  /** Codegen plugin (capabilities: ["codegen"]): languages for the developer mode code panel. */
  codegenLanguages?: { label: string; value: string }[];
  codegenPreferences?: unknown[];
  /** Widget (Figma widget API): the code registers a component; on the canvas it is a widget node. */
  containsWidget?: boolean;
  widgetApi?: string;
}

/** The plugin is a widget (inserted onto the canvas rather than run). */
export const isWidget = (m: PluginManifest) => m.containsWidget === true;

/** Plugin command: path in its menu, parameters. Without a menu — a single command with an empty name. */
export interface PluginCommand {
  command: string;
  /** Item names from the root of the plugin menu (without the plugin's own name). */
  path: string[];
  parameters?: ManifestParameter[];
  parameterOnly: boolean;
}

/** Codegen plugin: shows code in the developer mode Inspect panel. */
export const isCodegen = (m: PluginManifest) => !!m.capabilities?.includes('codegen');

/** All plugin commands (submenus expanded). */
export function pluginCommands(m: PluginManifest): PluginCommand[] {
  if (!m.menu?.length) return [{ command: '', path: [], parameters: m.parameters, parameterOnly: m.parameterOnly !== false }];
  const out: PluginCommand[] = [];
  const walk = (items: ManifestMenuItem[], path: string[]) => {
    for (const it of items) {
      if (it.separator || !it.name) continue;
      if (it.menu) walk(it.menu, [...path, it.name]);
      else out.push({ command: it.command ?? '', path: [...path, it.name], parameters: it.parameters, parameterOnly: it.parameterOnly !== false });
    }
  };
  walk(m.menu, []);
  return out;
}

function checkParameters(list: unknown, where: string, warnings: string[]): ManifestParameter[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) {
    warnings.push(`${where}: parameters должен быть массивом`);
    return undefined;
  }
  const out: ManifestParameter[] = [];
  for (const p of list as Record<string, unknown>[]) {
    if (!p || typeof p.name !== 'string' || typeof p.key !== 'string') {
      warnings.push(`${where}: у параметра нужны name и key`);
      continue;
    }
    out.push({
      name: p.name,
      key: p.key,
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(p.allowFreeform ? { allowFreeform: true } : {}),
      ...(p.optional ? { optional: true } : {}),
    });
  }
  return out;
}

function checkMenu(items: unknown, warnings: string[], depth = 0): ManifestMenuItem[] | undefined {
  if (items === undefined) return undefined;
  if (!Array.isArray(items) || depth > 8) {
    warnings.push('menu: ожидался массив пунктов');
    return undefined;
  }
  return (items as Record<string, unknown>[]).map((it) => {
    if (it?.separator) return { separator: true };
    const name = typeof it?.name === 'string' ? it.name : '';
    if (!name) warnings.push('menu: у пункта нет name');
    if (Array.isArray(it.menu)) return { name, menu: checkMenu(it.menu, warnings, depth + 1) ?? [] };
    return {
      name,
      command: typeof it.command === 'string' ? it.command : '',
      ...(it.parameters !== undefined ? { parameters: checkParameters(it.parameters, `menu «${name}»`, warnings) } : {}),
      ...(it.parameterOnly === false ? { parameterOnly: false } : {}),
    };
  });
}

/** Validates and normalizes manifest.json; reports what we do not support yet. */
export function parseManifest(json: unknown): { manifest: PluginManifest; warnings: string[] } {
  if (!json || typeof json !== 'object') throw new Error('manifest.json: ожидался объект');
  const m = json as Record<string, unknown>;
  const warnings: string[] = [];
  for (const field of ['name', 'id', 'api', 'main'] as const) {
    if (typeof m[field] !== 'string' || !m[field]) throw new Error(`manifest.json: нет поля "${field}"`);
  }
  const editorType = Array.isArray(m.editorType) ? (m.editorType as string[]) : ['figma'];
  if (!editorType.includes('figma') && !editorType.includes('dev')) {
    warnings.push(`editorType ${JSON.stringify(editorType)}: поддерживается только "figma"`);
  }
  if (Array.isArray(m.permissions) && (m.permissions as string[]).includes('payments')) {
    warnings.push('permissions: payments не поддерживается');
  }
  const caps = Array.isArray(m.capabilities) ? (m.capabilities as string[]).filter((c) => c !== 'codegen') : [];
  if (caps.length) warnings.push(`capabilities ${JSON.stringify(caps)} пока не поддерживаются`);
  const manifest: PluginManifest = { ...(m as unknown as PluginManifest), editorType };
  const menu = checkMenu(m.menu, warnings);
  if (menu) manifest.menu = menu;
  const parameters = checkParameters(m.parameters, 'manifest', warnings);
  if (parameters) manifest.parameters = parameters;
  return { manifest, warnings };
}

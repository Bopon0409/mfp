// Entry point: the editor or a prototype presentation tab (?player). First — the interface language (i18n).
import { initI18n } from './i18n/index.ts';

await initI18n();
if (new URLSearchParams(location.search).has('player')) await import('./player/main.ts');
else await import('./main.ts');

export {};

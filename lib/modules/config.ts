/** Configuração por organização. Valores ausentes ou inválidos falham fechados. */
export interface ModulesState { academia: boolean }
export function lerModulos(settings: unknown): ModulesState {
  const value = settings as { modules?: { academia?: unknown } } | null;
  return { academia: value?.modules?.academia === true };
}

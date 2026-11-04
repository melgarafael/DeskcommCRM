/** Opt-in estritamente booleano por organização; legado permanece desligado. */
export function fotosProgressivasConfig(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const catalogo = (settings as Record<string, unknown>).catalogo;
  return (
    !!catalogo &&
    typeof catalogo === "object" &&
    !Array.isArray(catalogo) &&
    (catalogo as Record<string, unknown>).fotos_progressivas === true
  );
}

export function mesclarFotosProgressivas(
  settings: unknown,
  habilitado: boolean,
): Record<string, unknown> {
  const atual =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const catalogo =
    atual.catalogo && typeof atual.catalogo === "object" && !Array.isArray(atual.catalogo)
      ? (atual.catalogo as Record<string, unknown>)
      : {};
  return { ...atual, catalogo: { ...catalogo, fotos_progressivas: habilitado } };
}

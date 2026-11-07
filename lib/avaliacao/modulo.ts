export const MODULO_AVALIACAO_NAO_INSTALADO =
  "O módulo de agenda de avaliação não está instalado nesta instalação. Peça ao administrador " +
  "para instalar em Configurações da instalação › Módulos.";

export function moduloAvaliacaoNaoInstalado(error: { code?: string } | null): boolean {
  return error?.code === "42P01";
}

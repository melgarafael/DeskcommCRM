export const MODULO_AVALIACAO_NAO_INSTALADO =
  "O módulo de agenda de avaliação não está instalado nesta instalação. Peça ao administrador " +
  "para instalar em Configurações da instalação › Módulos.";

/**
 * `42P01` — tabela ausente no Postgres (provisionadora ainda não rodou).
 * `PGRST205` — tabela existe, mas o PostgREST ainda não a tem no schema cache
 * (módulo acabou de ser instalado nesta instância). Nos dois casos a ação certa
 * é a mesma mensagem de módulo, não um 500 cru.
 */
export function moduloAvaliacaoNaoInstalado(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

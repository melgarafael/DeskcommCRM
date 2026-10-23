import { somarPermissoes } from "../permissoes";

/**
 * QUEM recebe um aviso (docs/agencia/SPEC-avisos.md, A6). Uma função só, para
 * nenhuma fase decidir do seu jeito.
 *
 *  - aviso de uma tarefa → todos os responsáveis dela (duas pessoas designadas,
 *    as duas avisadas);
 *  - aviso GERAL (prazo da trilha, fim do mês de preparação) → quem tem
 *    `avisos.gerais`, e o dono sempre.
 *
 * Só membro ATIVO recebe. Pura: quem chama traz as linhas.
 */
export type AlvoDoAviso = { tipo: "membros"; ids: readonly string[] } | { tipo: "gerais" };

export interface MembroCandidato {
  id: string;
  user_id: string | null;
  situacao: string;
  funcoes: ReadonlyArray<{ ativa: boolean; permissoes: readonly string[] }>;
}

export function destinatariosDoAviso(
  alvo: AlvoDoAviso,
  membros: readonly MembroCandidato[],
  /** `user_id` de quem é platform admin `full` — o dono. */
  donos: ReadonlySet<string>,
): string[] {
  const ativos = membros.filter((m) => m.situacao === "ativo");
  if (alvo.tipo === "membros") {
    const pedidos = new Set(alvo.ids);
    return ativos.filter((m) => pedidos.has(m.id)).map((m) => m.id);
  }
  return ativos
    .filter((m) => (m.user_id !== null && donos.has(m.user_id)) || somarPermissoes(m.funcoes).has("avisos.gerais"))
    .map((m) => m.id);
}

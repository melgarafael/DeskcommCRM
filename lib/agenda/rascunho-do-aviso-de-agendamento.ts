/**
 * O rascunho do formulário de Agenda › Avisos, e a regra que liga o grupo à
 * conexão que envia.
 *
 * Um grupo do WhatsApp só existe para a conexão que está nele. Se a conexão
 * que envia muda — trocou o seletor, ou ligou/desligou "usar o número do aviso
 * de caso" —, o grupo escolhido antes era de outra conexão e sairia por uma
 * que não o enxerga: a RPC só confere a forma `…@g.us` e o aviso falharia em
 * silêncio a cada envio. Por isso a mudança de conexão zera o grupo.
 */

/** O `Select` não aceita valor vazio: este é o "nenhum grupo". */
export const SEM_GRUPO = "sem-grupo";

export interface RascunhoDoAvisoDeAgendamento {
  usaNumeroDoCaso: boolean;
  canal: string;
  telefone: string;
  /** `SEM_GRUPO` = nenhum grupo. */
  grupo: string;
  ligado: boolean;
}

/** O aviso de caso como a tela o vê; `null` quando ainda não tem número. */
export interface AvisoDeCasoDoRascunho {
  channel_session_id: string | null;
}

/** A conexão pela qual o aviso sai com este rascunho, ou `null` se nenhuma. */
export function conexaoQueEnviaDoRascunho(
  rascunho: RascunhoDoAvisoDeAgendamento,
  avisoDeCaso: AvisoDeCasoDoRascunho | null,
): string | null {
  if (rascunho.usaNumeroDoCaso && avisoDeCaso !== null) return avisoDeCaso.channel_session_id;
  return rascunho.canal || null;
}

/** Aplica a mudança e zera o grupo quando a conexão que envia deixa de ser a mesma. */
export function mudarRascunhoDoAviso(
  anterior: RascunhoDoAvisoDeAgendamento,
  mudanca: Partial<RascunhoDoAvisoDeAgendamento>,
  avisoDeCaso: AvisoDeCasoDoRascunho | null,
): RascunhoDoAvisoDeAgendamento {
  const proximo = { ...anterior, ...mudanca };
  const trocouConexao =
    conexaoQueEnviaDoRascunho(anterior, avisoDeCaso) !==
    conexaoQueEnviaDoRascunho(proximo, avisoDeCaso);
  return trocouConexao ? { ...proximo, grupo: SEM_GRUPO } : proximo;
}

/**
 * Aviso, SEM bloquear: o número não começa com +55 numa organização do Brasil.
 * Número de fora do país é válido; o aviso só pergunta, porque o engano comum é
 * esquecer o 55. Organização de outro país (exemplo sem +55) não vê o aviso.
 */
export function numeroPareceDeForaDoBrasil(telefone: string, telefoneExemplo: string): boolean {
  if (!telefoneExemplo.startsWith("+55")) return false;
  const digitos = telefone.replace(/\D/g, "");
  return digitos.length >= 2 && !digitos.startsWith("55");
}

/** O que falta para o botão "Receber avisos" destravar; `null` = nada falta. */
export type OQueFaltaParaLigar = "conexao_e_numero" | "conexao" | "numero" | null;

export function oQueFaltaParaLigar(fatos: {
  usaNumeroDoCaso: boolean;
  conexaoOferecida: boolean;
  telefoneOk: boolean;
}): OQueFaltaParaLigar {
  if (fatos.usaNumeroDoCaso) return null;
  if (!fatos.conexaoOferecida && !fatos.telefoneOk) return "conexao_e_numero";
  if (!fatos.conexaoOferecida) return "conexao";
  if (!fatos.telefoneOk) return "numero";
  return null;
}

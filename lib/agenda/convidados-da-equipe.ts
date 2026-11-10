import { ehUuid } from "@/lib/inbox/rascunho-sugerido";

/**
 * CONVIDADOS DA EQUIPE — as réguas que não dependem de banco (#4006).
 *
 * O compromisso passa a aceitar pessoas da organização além do responsável e do
 * e-mail digitado à mão. A decisão de QUEM entra e de quem é recusado é regra
 * pura; quem lê o banco (membership, e-mail do convite) mora em
 * `lib/agenda/google/convidados-da-equipe.ts`.
 *
 * ─── Por que a lista tem teto ──────────────────────────────────────────────
 *
 * `attendees` vai no corpo do evento e cada convidado recebe e-mail. Um array
 * sem teto vindo de uma chamada de API é um convite em massa — e o Google
 * recusa o evento INTEIRO quando um dos endereços está malformado, então o
 * custo do exagero não é "um convidado a mais", é o compromisso não existir.
 */
export const MAXIMO_DE_CONVIDADOS_DA_EQUIPE = 20;

/**
 * A lista canônica: só UUID, sem repetidos, com teto.
 *
 * A forma é conferida ANTES do teto: entrada que não é id não ocupa vaga de quem
 * é, e não chega ao `.in()` de uma coluna uuid, onde derrubaria a leitura inteira.
 * A rota já recusa id malformado no schema; aqui a lista pode vir de outra fonte.
 *
 * A deduplicação aqui é a mesma que o Google exige no `attendees` (e-mail
 * repetido = evento recusado inteiro). Repetir cedo evita depender de a tela
 * ter feito a conta.
 */
export function normalizarConvidadosDaEquipe(
  ids: readonly string[] | null | undefined,
): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const bruto of ids ?? []) {
    const id = typeof bruto === "string" ? bruto.trim().toLowerCase() : "";
    if (!ehUuid(id) || vistos.has(id)) continue;
    vistos.add(id);
    saida.push(id);
    if (saida.length >= MAXIMO_DE_CONVIDADOS_DA_EQUIPE) break;
  }
  return saida;
}

/**
 * Separa o que pode virar convite do que não pode.
 *
 * ⚠️ A recusa é por LISTA, não por "ignora o resto". Convidado de outra
 * organização (ou de nenhuma) tem de voltar como recusa explícita: aceitar em
 * silêncio faria a tela dizer "salvo" enquanto o convite nunca existiria — e o
 * silêncio é justamente o defeito que a issue #4006 descreve.
 */
export function separarConvidadosDaEquipe(
  ids: readonly string[] | null | undefined,
  membrosDaOrganizacao: ReadonlySet<string>,
): { aceitos: string[]; recusados: string[] } {
  const aceitos: string[] = [];
  const recusados: string[] = [];
  for (const id of normalizarConvidadosDaEquipe(ids)) {
    if (membrosDaOrganizacao.has(id)) aceitos.push(id);
    else recusados.push(id);
  }
  return { aceitos, recusados };
}

/**
 * A agenda de uma pessoa é o que ela atende E aquilo a que foi chamada: a mesma
 * regra do recorte `?owner_user_id=` em `lib/agenda/consulta.ts`, para a tela e a
 * rota não discordarem de quem aparece.
 */
export function estaNaAgendaDe(
  compromisso: { responsavelId?: string | null; convidadosDaEquipe?: string[] },
  pessoaId: string,
): boolean {
  return (
    compromisso.responsavelId === pessoaId ||
    (compromisso.convidadosDaEquipe ?? []).includes(pessoaId)
  );
}

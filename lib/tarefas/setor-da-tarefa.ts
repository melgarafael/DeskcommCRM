/**
 * DE ONDE VEM O SELO DE SETOR DA TAREFA (#4883) — uma decisão, dois leitores.
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * O chip da tela de Tarefas mostrava o PRIMEIRO setor de quem tem a tarefa
 * (`atendentes[i].sector_ids[0]`). Quem atende mais de um setor ficava com
 * TODAS as tarefas com o mesmo selo: um vendedor cujo primeiro setor é
 * "Viagens Nacionais" via esse selo numa tarefa de cliente que pediu Peru,
 * enquanto a CONVERSA desse cliente estava em "Viagens Internacionais" (setor
 * que a IA gravou, #3881). A equipe lia o selo como o tipo do atendimento e
 * concluía que o cadastro estava errado.
 *
 * O filtro "Setor" tinha a mesma doença por outro caminho: ele casava com
 * `crm_tasks.assigned_to` → `attendant_sector_members`, ou seja, com o setor de
 * QUEM TEM a tarefa. Selo e filtro discordavam do que a tela mostrava.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * O setor da tarefa é o de ONDE ELA NASCEU, nesta ordem:
 *
 *   1. `conversa`    — o setor da conversa vinculada à tarefa;
 *   2. `negocio`     — sem conversa: o setor do negócio (o da conversa ligada
 *                      ao card, ver `lib/tarefas/setores-da-tarefa.ts`);
 *   3. `responsavel` — só sem nenhum dos dois: o setor de quem tem a tarefa.
 *
 * O terceiro degrau continua existindo porque tarefa avulsa é caso real, mas
 * ele vem MARCADO: `origem: "responsavel"` é o que faz o selo se explicar
 * ("Setor do responsável — …"), em vez de mentir com a mesma cara dos outros.
 *
 * ─── Por que função pura ────────────────────────────────────────────────────
 *
 * Selo e filtro perguntam a MESMA coisa. Duas implementações divergem na
 * primeira mudança de vocabulário — e a divergência aqui é muda: a lista
 * mostraria "Internacionais" e o filtro por "Internacionais" não a traria. A
 * rota anexa `setor` a cada tarefa com esta função e filtra com `tarefaNoSetor`,
 * que chama esta mesma função. O cliente não decide nada: ele desenha o que
 * veio do servidor.
 */

/** Quem respondeu o setor da tarefa. O terceiro é o fallback, e ele se declara. */
export type OrigemDoSetorDaTarefa = "conversa" | "negocio" | "responsavel";

/** O que o selo desenha e o que o filtro compara. */
export interface SetorDaTarefa {
  id: string;
  origem: OrigemDoSetorDaTarefa;
}

/**
 * As três fontes, já resolvidas por quem lê o banco. `null`/ausente = aquela
 * fonte não respondeu (conversa sem fila, negócio sem conversa, tarefa sem
 * responsável).
 */
export interface FontesDoSetor {
  conversa?: string | null;
  negocio?: string | null;
  responsavel?: string | null;
}

/**
 * O setor que a tarefa MOSTRA — a única régua. Devolve `null` quando nenhuma
 * das três fontes responde: sem setor não há selo, e inventar um seria pior do
 * que não mostrar nada.
 */
export function setorDaTarefa(fontes: FontesDoSetor): SetorDaTarefa | null {
  if (fontes.conversa) return { id: fontes.conversa, origem: "conversa" };
  if (fontes.negocio) return { id: fontes.negocio, origem: "negocio" };
  if (fontes.responsavel) return { id: fontes.responsavel, origem: "responsavel" };
  return null;
}

/**
 * O filtro "Setor" da tela — a MESMA pergunta do selo, com um id na mão.
 *
 * `setorId` vazio = sem filtro (a tela abre em "Todos os setores"), e aí toda
 * tarefa passa. Fora isso, passa quem EXIBE aquele setor: a tarefa de um membro
 * do setor cuja conversa está em outro setor NÃO entra, e a tarefa de quem não
 * é do setor mas cuja conversa está nele ENTRA.
 */
export function tarefaNoSetor(
  fontes: FontesDoSetor,
  setorId: string | null | undefined,
): boolean {
  if (!setorId) return true;
  return setorDaTarefa(fontes)?.id === setorId;
}

/**
 * POR QUE O AGENTE PUBLICADO NÃO SERVE PARA ESTA CAMPANHA — em função pura (#4118).
 *
 * ─── O defeito que este módulo tira do lugar ────────────────────────────────
 *
 * `validateConfig` recusava a campanha com UMA frase para DUAS causas:
 *
 *   1. `crm_move_lead_stage` fora de `tool_ids` — resolve-se na aba "Conversa
 *      com o cliente", ligando "Mover oportunidade de etapa";
 *   2. o funil da campanha fora de `pipeline_ids` — resolve-se na aba
 *      "Organiza o sistema", em "Em que negócios ele pode mexer".
 *
 * A frase ("Publique o agente com a ferramenta de mover negócios e acesso ao
 * funil escolhido") mandava fazer AS DUAS sempre. Quem ligava o pacote "Vender
 * e mover o funil" na aba de conversa — 21 de 22 capacidades, no relato da
 * comunidade — lia o aviso e concluía que já tinha feito o que ele pedia: o que
 * faltava era o funil, marcado em OUTRA aba, e a tela não dizia isso.
 *
 * ─── Por que a frase mora aqui, e não no `if` ──────────────────────────────
 *
 * Porque a decisão é uma tabela: quais capacidades faltam → qual frase. Um
 * `if` de três ramos dentro de `validateConfig` repetiria o erro que a issue
 * cobra (mensagem separada por condição sem lugar para testá-las uma a uma);
 * aqui cada ramo tem caso próprio e o texto pode ser comparado com o dicionário
 * (PT/ES) sem abrir o banco.
 *
 * O CÓDIGO CRU do que faltou acompanha a recusa em `faltando` e vai para o log
 * (`validateConfig`): a frase fala o rótulo que a tela mostra, a telemetria
 * fala `crm_move_lead_stage` e o uuid do funil.
 */

/** A capacidade que a campanha exige do agente publicado (catálogo: `funil.ts`). */
export const FERRAMENTA_DE_MOVER = "crm_move_lead_stage";

export const MSG_SEM_FERRAMENTA_MOVER =
  "O agente publicado não pode mover oportunidade de etapa. Ligue 'Mover oportunidade de etapa' na aba Conversa com o cliente e publique o agente de novo.";

export const MSG_SEM_FUNIL =
  "O agente publicado não tem acesso ao funil desta campanha. Marque o funil em Agente › Organiza o sistema › 'Em que negócios ele pode mexer' e publique o agente de novo.";

export const MSG_SEM_FERRAMENTA_E_FUNIL =
  "O agente publicado não pode mover oportunidade de etapa e não tem acesso ao funil desta campanha. Ligue 'Mover oportunidade de etapa' na aba Conversa com o cliente, marque o funil em Organiza o sistema › 'Em que negócios ele pode mexer' e publique o agente de novo.";

/** Qual das duas capacidades faltou. É o código que a telemetria registra. */
export type CodigoDaRecusaDoAgente =
  | "sem_ferramenta_mover"
  | "sem_funil"
  | "sem_ferramenta_e_funil";

export interface RecusaDoAgente {
  codigo: CodigoDaRecusaDoAgente;
  /** A frase da tela — chave do dicionário PT/ES (`lib/i18n/dicionario.ts`). */
  mensagem: string;
  /** O que faltou em nome cru (`crm_move_lead_stage`, `pipeline:<uuid>`). */
  faltando: string[];
}

/**
 * A recusa do agente publicado, ou `null` quando ele atende à campanha.
 *
 * Lista ausente (`null`/`undefined`) conta como vazia: é o agente sem nenhuma
 * capacidade publicada, e falhar fechado é o certo para quem vai disparar
 * mensagem em nome da empresa.
 */
export function recusaDoAgente(entrada: {
  toolIds: readonly string[] | null | undefined;
  pipelineIds: readonly string[] | null | undefined;
  pipelineId: string;
}): RecusaDoAgente | null {
  const temFerramenta = Boolean(entrada.toolIds?.includes(FERRAMENTA_DE_MOVER));
  const temFunil = Boolean(entrada.pipelineIds?.includes(entrada.pipelineId));
  if (temFerramenta && temFunil) return null;

  const faltando: string[] = [];
  if (!temFerramenta) faltando.push(FERRAMENTA_DE_MOVER);
  if (!temFunil) faltando.push(`pipeline:${entrada.pipelineId}`);

  if (!temFerramenta && !temFunil) {
    return { codigo: "sem_ferramenta_e_funil", mensagem: MSG_SEM_FERRAMENTA_E_FUNIL, faltando };
  }
  if (!temFerramenta) {
    return { codigo: "sem_ferramenta_mover", mensagem: MSG_SEM_FERRAMENTA_MOVER, faltando };
  }
  return { codigo: "sem_funil", mensagem: MSG_SEM_FUNIL, faltando };
}

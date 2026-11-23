/**
 * O QUE FAZER COM OS NEGÓCIOS DE UM FUNIL QUE VAI SAIR DA LISTA (#4802, item 3).
 *
 * Arquivar sempre pôde ser feito com negócio dentro: o funil sai da lista, para de
 * receber card novo e o histórico continua apontando para ele. O que faltava era a
 * ESCOLHA — o dono da operação arquivava no escuro, sem saber quantos negócios
 * ficariam presos num funil que ele não vê mais, e não tinha como levá-los de uma
 * vez (o card a card existia, um por um, pelo quadro).
 *
 * Este módulo é a parte DECIDÍVEL: qual etapa recebe o lote, quando recusar, e qual
 * é a contagem que a confirmação mostra. Quem fala com o banco é a rota
 * `app/api/v1/pipelines/[id]/negocios/route.ts` — e ela NÃO escreve `stage_id` por
 * conta própria: o movimento vai pelo mesmo `fn_mover_leads_em_lote` que o lote do
 * quadro usa (o seed da onda proíbe um segundo caminho de movimento de negócio).
 *
 * ⚠️ AS DUAS ESCOLHAS QUE APAGAM SÃO DIFERENTES, e a diferença é a única coisa que
 * impede a operação de virar perda de dado:
 *
 *   - `transferir` NÃO apaga nada: `crm_leads.pipeline_id`/`stage_id` mudam — só
 *     dos negócios EM ANDAMENTO (doc de decisão 400, opção B; ganhos e perdidos
 *     ficam no funil de origem) — e o negócio continua o mesmo registro, com o mesmo id, a mesma timeline
 *     (`crm_lead_activities`) e as mesmas conversas do contato.
 *   - `remover` apaga as LINHAS de `crm_leads` — é o que tira o negócio da
 *     estrutura dos funis. Contatos, conversas e histórico continuam existindo:
 *     `crm_leads.contact_id` é `ON DELETE SET NULL` (o contato não morre com o
 *     negócio) e `crm_lead_activities.lead_id` passou a ser `ON DELETE SET NULL`
 *     na migration desta fatia (9466) — antes era `ON DELETE CASCADE`, e apagar o
 *     negócio levava a timeline comercial junto, em silêncio. A linha que não tem
 *     contato continua sendo apagada com o negócio (gatilho da 9466): sem contato
 *     nem negócio, a anonimização da LGPD não a alcançaria.
 */

/** O que o usuário escolheu na confirmação. `cancelar` nunca chega aqui: é a ausência de pedido. */
export type Escolha = "transferir" | "remover";

/** O funil como a regra precisa vê-lo — o MESMO recorte de `lerFunis`. */
export interface FunilConhecido {
  id: string;
  name: string;
  is_archived: boolean;
}

/** A etapa como a regra precisa vê-la. */
export interface EtapaConhecida {
  id: string;
  name: string;
  pipeline_id: string;
  /** `numeric` chega como string pelo PostgREST. */
  position: number | string;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
}

export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string; codigo: string };

/**
 * A etapa em que o lote aterrissa quando o usuário escolhe só o FUNIL (escolha a
 * da issue: "transferir todos para outro funil").
 *
 * ⚠️ É A PRIMEIRA ETAPA DE ENTRADA, NUNCA "a primeira da lista". Etapa de ganho ou
 * de perda fecha o negócio: mandar o lote para lá encerraria N negócios de uma vez
 * — a pior forma de "transferir". Arquivada também não serve: ela não está no
 * quadro e não recebe card.
 *
 * Ordenada por `position`, com o id como desempate: duas etapas podem empatar na
 * posição (o produto herda isso do índice fracionário), e sem desempate a mesma
 * chamada escolheria etapas diferentes em duas execuções.
 */
export function etapaDeEntrada(etapas: EtapaConhecida[]): EtapaConhecida | null {
  const candidatas = etapas
    .filter((e) => !e.is_archived && !e.is_won && !e.is_lost)
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return candidatas[0] ?? null;
}

/**
 * Valida o pedido de transferência e devolve a ETAPA de destino.
 *
 * Recusas, na ordem em que o usuário consegue resolvê-las:
 *   1. destino igual à origem — não é transferência;
 *   2. destino inexistente nesta organização (mesma resposta de funil apagado, para
 *      não vazar existência de outro tenant);
 *   3. destino arquivado — é destino que não recebe card;
 *   4. etapa escolhida que não é do destino — o `select` da tela pode estar velho;
 *   5. destino sem etapa de entrada (funil de quadro morto).
 *
 * A etapa escolhida é RESPEITADA, não substituída pela de entrada: é literalmente o
 * que o item (b) da issue pede, e trocá-la pela primeira do destino faria o card
 * aterrissar em outro lugar sem ninguém saber.
 */
export function validarDestinoDaTransferencia(input: {
  origemId: string;
  destinoId: string;
  etapaId?: string | null;
  funis: FunilConhecido[];
  /** Etapas do funil de DESTINO — quem chama lê só as dele. */
  etapasDoDestino: EtapaConhecida[];
}): Resultado<{ destino: FunilConhecido; etapa: EtapaConhecida }> {
  if (input.destinoId === input.origemId) {
    return {
      ok: false,
      codigo: "pipeline_unchanged",
      erro: "O negócio já está neste funil — escolha OUTRO para receber os negócios.",
    };
  }

  const destino = input.funis.find((f) => f.id === input.destinoId);
  if (!destino) {
    return {
      ok: false,
      codigo: "not_found",
      erro: "O funil de destino não está mais na sua lista. Recarregue a página e escolha outro.",
    };
  }
  if (destino.is_archived) {
    return {
      ok: false,
      codigo: "pipeline_archived",
      erro: "«{nome}» está arquivado e não recebe negócio. Tire-o do arquivo ou escolha outro funil.",
    };
  }

  if (input.etapaId) {
    const escolhida = input.etapasDoDestino.find((e) => e.id === input.etapaId);
    if (!escolhida) {
      return {
        ok: false,
        codigo: "stage_not_found",
        erro: "A etapa escolhida não é de «{nome}» ou não existe mais. Recarregue a página e escolha de novo.",
      };
    }
    if (escolhida.is_archived) {
      return {
        ok: false,
        codigo: "stage_archived",
        erro: "A etapa «{etapa}» está arquivada e não recebe negócio. Escolha outra.",
      };
    }
    if (escolhida.is_won || escolhida.is_lost) {
      return {
        ok: false,
        codigo: "stage_closes_deal",
        erro:
          "«{etapa}» é etapa de fechamento: transferir para lá encerraria TODOS os negócios " +
          "de uma vez. Escolha uma etapa de andamento.",
      };
    }
    return { ok: true, valor: { destino, etapa: escolhida } };
  }

  const entrada = etapaDeEntrada(input.etapasDoDestino);
  if (!entrada) {
    return {
      ok: false,
      codigo: "pipeline_without_entry_stage",
      erro: "«{nome}» não tem etapa de andamento para receber os negócios. Crie uma etapa nele primeiro.",
    };
  }
  return { ok: true, valor: { destino, etapa: entrada } };
}

/** O que a auditoria registra — por operação, com os números medidos. */
export interface ResumoDaOperacao {
  escolha: Escolha;
  origem_pipeline_id: string;
  destino_pipeline_id: string | null;
  destino_stage_id: string | null;
  /** Quantos o banco tinha ANTES desta chamada. */
  negocios_antes: number;
  /** Quantos saíram da origem — medido DEPOIS, no banco. */
  movidos: number;
  /** Quantos ainda apontam para a origem depois da escrita (0 no caso feliz). */
  restantes: number;
}

export function resumoDaOperacao(input: ResumoDaOperacao): ResumoDaOperacao {
  return {
    ...input,
    // Nunca negativo, nunca maior que o de antes: se a conta fugir dos limites, é
    // escrita concorrente e o número grande só confundiria quem audita.
    movidos: Math.max(0, Math.min(input.movidos, input.negocios_antes)),
  };
}

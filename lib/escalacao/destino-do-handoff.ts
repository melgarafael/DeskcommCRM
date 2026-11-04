/**
 * AO PASSAR A CONVERSA PARA UMA PESSOA, ENTREGAR A QUEM É O DONO — o item 3 da
 * #3804.
 *
 * ─── O problema ────────────────────────────────────────────────────────────
 *
 * Numa agência de viagens, a Andreia vende e o card vai para o pós-venda com
 * ela como responsável. Quando o cliente volta a falar e a IA passa o
 * atendimento a um humano, a conversa ia para uma pessoa FIXA (a mesma para a
 * equipe toda) ou para o rodízio — a venda da Andreia caía no colo de outra
 * pessoa, que não sabe o que foi combinado. Nem a conversa fica com quem tem o
 * contexto, nem o número do pós-venda fica com quem vendeu.
 *
 * ─── A decisão: a MESMA configuração e a MESMA função do #3822 ─────────────
 *
 * A ação `assign_owner` já resolveu esta pergunta para o NEGÓCIO: a regra pode
 * pedir `{ modo: "destino", destinos, fallback }`, e `resolverDestinoDoAtribuir`
 * (`lib/automation/destino-do-atribuir`) anda a cadeia — responsável do negócio
 * → dono da carteira do contato — devolvendo QUEM decidiu (`motivo`) e o que foi
 * tentado antes (`descartes`). Aqui não há segunda função nem segunda ordem: o
 * handoff lê a MESMA forma de configuração e chama a MESMA função.
 *
 *   `organizations.settings.atendimento.destino_do_handoff`
 *     `{ modo: "destino", destinos: [...], fallback: { modo: "fixo"|"rodizio" } }`
 *
 * É jsonb (`settings` já existe em toda organização): este item NÃO precisou de
 * migration. E o valor é o MESMO objeto que a ação de atribuir aceita — quem
 * salva uma regra de automação reconhece o payload.
 *
 * ─── Sem configuração, nada muda ───────────────────────────────────────────
 *
 * Chave ausente, `modo` diferente de `destino`, valor torto: a função devolve
 * `sem_configuracao` e NÃO faz leitura de negócio, nem de contato, nem escrita
 * nenhuma. O comportamento de hoje — pessoa fixa do rodízio de roteamento, ou a
 * conversa na fila da Central — continua byte a byte.
 *
 * ─── O vínculo é o do #3822, não um novo ───────────────────────────────────
 *
 * Quem a cadeia devolve passa pela régua de `lib/automation/vinculo-do-destino`
 * (membro ativo, não `viewer`). Recusado entra em `recusados`, e a cadeia
 * continua de onde parou — igualzinho ao executor da ação de atribuir.
 *
 * ─── Ninguém qualificado não é silêncio ────────────────────────────────────
 *
 * O `fallback` decide: pessoa fixa (atribuição direta) ou rodízio (a conversa
 * entra na distribuição do canal, `fn_request_channel_routing` — a mesma porta
 * que o handoff da IA já usa quando não há ninguém elegível). Se nem o fallback
 * servir, o desfecho é `sem_destino` e o caminho de hoje segue: a conversa fica
 * na fila humana com o aviso na Central. Nunca "atribuiu a ninguém e ninguém
 * soube".
 *
 * ─── Quem entrega: só a IA ─────────────────────────────────────────────────
 *
 * `ORIGENS_EM_QUE_A_IA_ENTREGA` exclui `caso_escalado`, que é o "Assumir eu" de
 * uma PESSOA na tela de casos: ali quem decidiu passar foi gente, e reatribuir
 * por cima seria trocar o dono da conversa pelas costas de quem está nela. Além
 * disso, conversa que já tem dono humano nunca é tocada — a IA não rouba
 * atendimento de pessoa.
 *
 * ─── I/O fica nas PORTAS ───────────────────────────────────────────────────
 *
 * A decisão (esta função) não fala com banco. Os dois motores do repo têm
 * clientes diferentes — `pg.Pool` no engine, supabase-js no motor do CRM —, e
 * cada um entrega uma `PortaDaEntrega`. As duas fazem as mesmas perguntas e a
 * mesma escrita (`fn_conversation_assign` com `reason = 'handoff'`, a porta
 * única da atribuição, que grava o evento da linha do tempo na mesma
 * transação). A REGRA — ordem, descarte, recusa por vínculo, fallback — existe
 * uma vez só, aqui.
 */
import {
  resolverDestinoDoAtribuir,
  type ContatoDoDestino,
  type ConversaDoDestino,
  type Descarte,
  type MotivoDoDestino,
  type NegocioDoDestino,
} from "@/lib/automation/destino-do-atribuir";
import type { VinculoDoDestino } from "@/lib/automation/vinculo-do-destino";
import type { OrigemDaPassagem } from "@/lib/escalacao/passagem";

/**
 * A chave da configuração, em `organizations.settings` (jsonb — sem migration).
 *
 * `atendimento` é a árvore das decisões de atendimento da organização, e o nome
 * da folha diz o que ela decide: para QUEM vai a conversa quando a IA a passa
 * para uma pessoa. A forma do VALOR é a da ação `assign_owner` (#3822).
 */
export const CHAVE_DO_DESTINO_DO_HANDOFF = "destino_do_handoff";

/** A árvore de `settings` onde a chave mora. */
export const ARVORE_DO_DESTINO_DO_HANDOFF = "atendimento";

/**
 * As origens em que a IA (ou um agente externo) decidiu passar a conversa.
 *
 * `caso_escalado` fica de fora de propósito: é o "Assumir eu" da tela de casos,
 * uma PESSOA escrevendo por que está escalando. Ali o dono da conversa é
 * decisão de quem está nela, não da configuração.
 */
export const ORIGENS_EM_QUE_A_IA_ENTREGA: readonly OrigemDaPassagem[] = [
  "pedido_explicito",
  "opt_out_provavel",
  "ferramenta_do_modelo",
  "teto_de_gasto",
  "sentimento",
  "mcp_externo",
  "runtime_nativo",
  "legado_pedido",
  "legado_juridico",
  "legado_etapa",
  "legado_confianca",
  "legado_teto",
];

/** A IA decidiu esta passagem? (ausente = não; o caminho congelado não declara origem) */
export function origemDaIA(origem: OrigemDaPassagem | null | undefined): boolean {
  return origem !== null && origem !== undefined && ORIGENS_EM_QUE_A_IA_ENTREGA.includes(origem);
}

/** Um objeto de verdade (não array, não null) ou `null`. */
function registro(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * A configuração de destino do handoff, ou `null` quando não há.
 *
 * Só `modo: "destino"` liga o comportamento novo. Qualquer outra coisa —
 * ausente, `fixo`, `rodizio`, string de uma versão futura — é "não
 * configurado", e não configurado significa o handoff de hoje. Escolher o
 * destino é ato explícito de quem administra a organização; um jsonb torto não
 * pode entregar conversa a ninguém.
 */
export function configDoDestinoDoHandoff(settings: unknown): Record<string, unknown> | null {
  const arvore = registro(registro(settings)?.[ARVORE_DO_DESTINO_DO_HANDOFF]);
  const config = registro(arvore?.[CHAVE_DO_DESTINO_DO_HANDOFF]);
  if (!config) return null;
  return config.modo === "destino" ? config : null;
}

/**
 * A conversa como as portas a entregam. Só o que a decisão lê.
 *
 * `contact_id` nulo é conversa órfã: não há negócio nem carteira a procurar, e o
 * fallback é quem decide.
 */
export type ConversaDaEntrega = {
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
  contact_id: string | null;
};

/**
 * O QUE a decisão precisa do mundo. Cada motor entrega a sua implementação —
 * `pg.Pool` no engine, supabase-js no motor do CRM —, e nenhuma das duas pensa:
 * elas respondem a pergunta e executam a escrita que a decisão mandou.
 */
export type PortaDaEntrega = {
  /** A linha de `organizations.settings` (qualquer coisa; quem lê é a função acima). */
  lerSettings(organizationId: string): Promise<unknown>;
  /** A conversa que está sendo passada — `null` quando ela não existe (mais). */
  lerConversa(organizationId: string, conversationId: string): Promise<ConversaDaEntrega | null>;
  /**
   * O negócio do contato — o ABERTO mais recente. É a linha que
   * `resolverDestinoDoAtribuir` lê como "responsável do negócio".
   */
  lerNegocioDoContato(organizationId: string, contactId: string): Promise<NegocioDoDestino>;
  /** O contato — a linha que a resolução lê como `carteira_user_id`. */
  lerContato(organizationId: string, contactId: string): Promise<ContatoDoDestino>;
  /** A régua de vínculo (`lib/automation/vinculo-do-destino`), pela porta do motor. */
  conferirVinculo(organizationId: string, userId: string): Promise<VinculoDoDestino>;
  /** Atribui a conversa a `userId`. `null` = gravou; texto = o erro do banco. */
  atribuir(organizationId: string, conversationId: string, userId: string): Promise<string | null>;
  /** Põe a conversa na distribuição do canal (rodízio). Texto = o erro do banco. */
  enfileirarNoRodizio(organizationId: string, conversationId: string): Promise<string | null>;
};

/** Por que NÃO houve entrega. Nenhum destes é erro: são o desfecho do caminho. */
export type MotivoDaNaoEntrega =
  | "sem_configuracao"
  | "origem_humana"
  | "conversa_com_dono"
  | "sem_conversa"
  | "sem_destino"
  | "vinculo_indeterminado"
  | "falha_ao_atribuir"
  | "falha_ao_enfileirar";

export type DesfechoDaEntrega =
  | {
      entregue: true;
      /** `null` só no rodízio: quem escolhe é a distribuição do canal. */
      user_id: string | null;
      motivo: MotivoDoDestino;
      descartes: Descarte[];
    }
  | {
      entregue: false;
      motivo: MotivoDaNaoEntrega;
      descartes: Descarte[];
      erro?: string;
    };

/** Quantas voltas a cadeia pode dar (dois destinos + o fallback de pessoa fixa). */
const LIMITE_DA_CADEIA = 4;

/**
 * A conversa já é de uma PESSOA? `assignee_kind = 'agent'` é a IA atendendo (o
 * `assigned_to_user_id` ali é o agente, não um atendente), e conversa sem dono é
 * exatamente a que a IA está passando.
 *
 * Linha antiga com dono e `assignee_kind` nulo conta como pessoa: na dúvida, não
 * se toma a conversa de ninguém.
 */
function temDonoHumano(conversa: ConversaDaEntrega): boolean {
  return conversa.assigned_to_user_id !== null && conversa.assignee_kind !== "agent";
}

/**
 * A entrega ao dono — a decisão inteira, sem banco.
 *
 * Devolve SEMPRE um desfecho: o handoff já aconteceu quando isto roda, e uma
 * exceção aqui não pode derrubar a passagem. Quem chama decide o que fazer com
 * o desfecho (aqui: uma linha de log).
 */
export async function entregarAoDonoDoHandoff(
  porta: PortaDaEntrega,
  ids: {
    organizationId: string;
    conversationId: string;
    /** Por onde a passagem entrou. `null`/ausente = caminho que não declara. */
    origem: OrigemDaPassagem | null | undefined;
  },
): Promise<DesfechoDaEntrega> {
  // 1. Quem decidiu passar? Um atendente humano escalando ("Assumir eu") não
  //    reatribui a própria conversa por configuração.
  if (!origemDaIA(ids.origem)) return { entregue: false, motivo: "origem_humana", descartes: [] };

  // 2. A organização quer isto? Sem a chave, NADA é lido daqui para baixo e o
  //    handoff é o de hoje.
  const config = configDoDestinoDoHandoff(await porta.lerSettings(ids.organizationId));
  if (!config) return { entregue: false, motivo: "sem_configuracao", descartes: [] };

  // 3. A conversa. Com dono humano, a IA não rouba atendimento de pessoa.
  const conversa = await porta.lerConversa(ids.organizationId, ids.conversationId);
  if (!conversa) return { entregue: false, motivo: "sem_conversa", descartes: [] };
  if (temDonoHumano(conversa)) return { entregue: false, motivo: "conversa_com_dono", descartes: [] };

  // 4. As linhas que a resolução lê. Conversa órfã não tem nenhuma das duas.
  const [negocio, contato] = conversa.contact_id
    ? await Promise.all([
        porta.lerNegocioDoContato(ids.organizationId, conversa.contact_id),
        porta.lerContato(ids.organizationId, conversa.contact_id),
      ])
    : [null, null];

  // 5. A cadeia: resolver → conferir vínculo → recusar e resolver de novo.
  const recusados: string[] = [];
  for (let tentativa = 0; tentativa < LIMITE_DA_CADEIA; tentativa += 1) {
    const destino = resolverDestinoDoAtribuir(
      negocio,
      contato,
      config,
      recusados,
      conversa as ConversaDoDestino,
    );

    if (destino.user_id) {
      const vinculo = await porta.conferirVinculo(ids.organizationId, destino.user_id);
      if ("indeterminado" in vinculo) {
        // Não sabemos se a pessoa pode receber. Não é "não pode": não atribuímos
        // e dizemos por quê — entregar por cima de uma falha de leitura seria
        // escolher no escuro.
        return {
          entregue: false,
          motivo: "vinculo_indeterminado",
          descartes: destino.descartes,
          erro: vinculo.indeterminado,
        };
      }
      if (!vinculo.ok) {
        recusados.push(destino.user_id);
        continue;
      }
      const erro = await porta.atribuir(ids.organizationId, ids.conversationId, destino.user_id);
      if (erro !== null) {
        return { entregue: false, motivo: "falha_ao_atribuir", descartes: destino.descartes, erro };
      }
      return {
        entregue: true,
        user_id: destino.user_id,
        motivo: destino.motivo,
        descartes: destino.descartes,
      };
    }

    if (destino.motivo === "fallback_rodizio") {
      const erro = await porta.enfileirarNoRodizio(ids.organizationId, ids.conversationId);
      if (erro !== null) {
        return { entregue: false, motivo: "falha_ao_enfileirar", descartes: destino.descartes, erro };
      }
      return {
        entregue: true,
        user_id: null,
        motivo: "fallback_rodizio",
        descartes: destino.descartes,
      };
    }

    // Ninguém qualificado e o fallback não serve (a pessoa fixa saiu da equipe).
    // O caminho de hoje segue: a conversa fica na fila humana, com o aviso da
    // Central. Não é sucesso calado — o desfecho carrega a trilha.
    return { entregue: false, motivo: "sem_destino", descartes: destino.descartes };
  }

  return { entregue: false, motivo: "sem_destino", descartes: [] };
}

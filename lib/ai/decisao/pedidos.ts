/**
 * OS PEDIDOS DO CLIENTE, PERGUNTADOS AO JEV — pedir para falar com uma pessoa,
 * e pedir para parar de receber mensagens. As duas tarefas `cascata`.
 *
 * Hoje quem percebe os dois pedidos é uma REGRA, sem IA: a detecção de pedido
 * explícito de pessoa e as palavras de passagem do agente (no turno), e
 * `lib/opt-out/deteccao.ts` (na entrada da mensagem, que bloqueia, e no turno,
 * que para de responder). Ela é precisa e estreita: medido, a de pessoa pegou 0
 * de 5 pedidos em linguagem natural ("alguém de verdade", "chama o dono"), em
 * que o Jev deu de 0,94 a 0,99.
 *
 * ═══ A CASCATA É ESTRUTURAL ═══
 *
 * O Jev só é perguntado onde a regra de hoje disse NÃO (`pedidosAPerguntar`):
 * a pergunta do pedido que a regra já pegou nem sai. Por isso o rótulo de hoje
 * gravado ao lado do dele é sempre `nao`, e o cartão não mostra concordância —
 * mostra quantos pedidos ele percebeu que a regra deixou passar. Quem roda a
 * regra é quem chama (`workers/ai-sentiment-worker.pedidos.ts`): a de pessoa
 * mora no agent-engine, e o que este módulo executa não pode importar de lá
 * (`tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`).
 *
 * ═══ SÓ ONDE O TURNO RODARIA ═══
 *
 * Perguntar numa conversa em que o agente nem responderia (ninguém atende o
 * número, ou só um agente pausado; o atendimento delegado a um sistema de
 * fora; uma pessoa no comando, contato bloqueado, grupo) contaria "pedidos
 * percebidos" que ninguém deixou passar — a regra de hoje nem é consultada lá.
 * É `turnoRodaria`, com os fatos lidos por quem chama.
 *
 * ═══ UMA CHAMADA SÓ PARA AS DUAS, E SEPARADA DA DO CLIMA ═══
 *
 * As duas perguntas vão juntas numa chamada PRÓPRIA. No pacote do clima, uma
 * recusa do fornecedor a uma pergunta nova derrubaria a medição do clima, que
 * já decide em produção em parte das empresas — observar não pode custar o que
 * já funciona. O disjuntor da conta (chave, crédito, limite de taxa) é o mesmo
 * das outras tarefas; o da pergunta recusada é desta chamada.
 *
 * ═══ "AVISAR A EQUIPE" — O QUE O ESTADO DECIDINDO FAZ AQUI ═══
 *
 * Observando, ele só grava. Na tarefa que a empresa pôs em "Avisar a equipe"
 * (o estado `decidindo`), o pedido percebido abre UM aviso na Central por
 * conversa e pedido (`avisarAEquipe`), com o botão "Abrir a conversa" — e é
 * tudo o que muda. O aviso não repete o que o cliente escreveu: a Central é
 * lida pela organização inteira, e a conversa só por quem a enxerga; a frase
 * fica na conversa, onde o botão leva quem pode lê-la. Ele fecha sozinho
 * (gatilhos da migration 0426) quando a conversa é passada a uma pessoa por
 * qualquer caminho — alguém assume, a passagem da regra, do clima ou do
 * próprio modelo, ou ela é encerrada —, o de parar de receber também quando o
 * contato é bloqueado; ou no "Marcar resolvido".
 *
 * ═══ O QUE ELE NUNCA FAZ ═══
 *
 * Não passa a conversa, não cala, não bloqueia, não responde — em estado
 * nenhum. Grava uma linha por pergunta em `jev_observacoes`, uma por chamada em
 * `llm_calls` e, avisando, o aviso. Sai só o que o cliente digitou na
 * mensagem, passado pelo `scrubMessage` (o aceite em vigor: cada mensagem,
 * sozinha). Nunca lança.
 */
import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { scrubMessage } from "@/lib/sentry/scrub";
import type { createAdminClient } from "@/lib/supabase/admin";

import { MODELO_DO_JEV, type FalhaDaDecisao, type Pergunta, type Resposta } from "./cliente";
import type { ConfigDoJev, EstadoQuePergunta } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { decidirNoPonto, type DependenciasDoPonto } from "./ponto";
import {
  estadoEfetivoDaTarefa,
  PEDIDOS_DO_CLIENTE,
  TAREFA_DO_PEDIDO_DE_HUMANO,
  TAREFA_DO_PEDIDO_PARA_PARAR,
} from "./tarefas";
import { codigoDoErroDoJev } from "./textos";

type Admin = ReturnType<typeof createAdminClient>;

export const TAREFAS_DOS_PEDIDOS = [TAREFA_DO_PEDIDO_DE_HUMANO, TAREFA_DO_PEDIDO_PARA_PARAR] as const;
export type IdDoPedido = (typeof TAREFAS_DOS_PEDIDOS)[number]["id"];

/**
 * A probabilidade a partir da qual o Jev diz "é um pedido". Alto de propósito:
 * "Doy de baja la pauta?" (dar baixa numa pauta, não sair da lista) deu 0,79, e
 * é um NEGATIVO deliberado da regra de descadastro. Os pedidos de pessoa em
 * linguagem natural medidos ficaram entre 0,94 e 0,99, e os negativos em até
 * 0,40 — 0,9 separa os dois com folga dos dois lados.
 */
export const CORTE_DO_PEDIDO = 0.9;

/** Por construção a regra de hoje disse não: é só onde o Jev é perguntado. */
const A_REGRA_DISSE_NAO = "nao";

const PERGUNTAS: Record<IdDoPedido, Pergunta> = {
  humano: {
    tipo: "noul",
    instrucao:
      "A ÚLTIMA mensagem do cliente pede para ser atendido por uma pessoa, e não pelo assistente automático, em qualquer idioma?",
    criterios: {
      true: "Pede para falar com uma pessoa, um atendente, o dono, o gerente ou alguém de verdade, ou diz que não quer falar com robô.",
      false: "Qualquer outra coisa: pergunta, pedido, reclamação ou elogio, sem pedir para falar com uma pessoa.",
    },
  },
  opt_out: {
    tipo: "noul",
    instrucao: "A ÚLTIMA mensagem do cliente pede para parar de receber mensagens desta empresa, em qualquer idioma?",
    criterios: {
      true: "Pede para não ser mais contatado: parar de mandar mensagens, sair da lista, descadastrar, não receber mais nada.",
      false:
        "Qualquer outra coisa — inclusive parar ou sair em outro sentido, como parar uma dor, sair mais cedo ou dar baixa num pedido.",
    },
  },
};

/**
 * O aviso de cada pedido na Central, em "Avisar a equipe". O texto é de quem
 * decide o que fazer, e não repete o que o cliente escreveu (ver o cabeçalho).
 * Gravado no idioma da organização: a Central mostra título e corpo como vieram.
 *
 * O corpo só afirma o que segue verdade enquanto o aviso fica aberto: ele não
 * diz com quem a conversa está, nem que nada foi bloqueado, nem "na última
 * mensagem" — depois de aberto, uma pessoa pode assumir, a regra pode pegar a
 * mensagem seguinte e outras mensagens chegam.
 */
export const AVISOS_DOS_PEDIDOS = {
  humano: {
    kind: "jev_pedido_de_humano",
    titulo: "Um cliente parece pedir para falar com uma pessoa",
    corpo:
      "O Jev percebeu, numa mensagem do cliente, um pedido para falar com uma pessoa que a regra de hoje não reconheceu. Abra a conversa e confira se alguém da equipe já assumiu — o Jev não passa a conversa sozinho.",
  },
  opt_out: {
    kind: "jev_parar_de_receber",
    titulo: "Um cliente parece pedir para parar de receber mensagens",
    corpo:
      "O Jev percebeu, numa mensagem do cliente, um pedido para parar de receber mensagens que a regra de hoje não reconheceu. Abra a conversa e confira. Se o cliente quer mesmo parar de receber mensagens, assuma o atendimento para o assistente parar de responder e peça que ele responda PARAR — é assim que o contato fica bloqueado. O Jev nunca bloqueia ninguém.",
  },
} as const satisfies Record<IdDoPedido, { kind: InboxKind; titulo: string; corpo: string }>;

/** O que a regra de hoje já pegou nesta mensagem. Quem chama roda a regra. */
export type RegraPegou = Readonly<Record<IdDoPedido, boolean>>;

/** O que o turno do agente olha antes de responder — lido por quem chama. */
export interface FatosDoTurno {
  /**
   * A organização delegou o atendimento a um sistema de fora
   * (`settings.ai_dispatch_mode = 'external'`, spec 14): o dreno descarta o
   * turno antes de tudo, e a regra de hoje nunca roda.
   */
  atendimentoExterno: boolean;
  /**
   * O número da conversa tem quem a atenda, e não pausado: o MESMO portão do
   * dreno do agent-engine (`haQuemAtendaASessao`,
   * `lib/ai/agents/quem-atende-a-sessao.ts`), sem os agentes pausados. Onde o
   * dreno diz não, ele pula o turno; onde só há pausado, o turno sai na pausa —
   * nos dois, a regra de hoje nem roda.
   */
  sessaoTemQuemAtenda: boolean;
  /**
   * A elegibilidade do turno deixa a IA responder nesta conversa
   * (`decidirElegibilidade`, `lib/ai/elegibilidade/gate.ts`): sem pessoa no
   * comando, sem silêncio, sem a trava da lista do canal.
   */
  iaPodeResponder: boolean;
  /** O contato já foi bloqueado — pelo STOP do próprio cliente, o único caminho do bloqueio no produto. */
  contatoBloqueado: boolean;
  /**
   * O contato foi passado a uma pessoa, ou QUALQUER conversa dele está com o
   * robô calado (`isLeadInHandoff`): o turno vira no-op, e a elegibilidade
   * desta conversa não vê a outra.
   */
  contatoComUmaPessoa: boolean;
  /** Conversa de grupo: o agente nunca atende grupo. */
  grupo: boolean;
}

/** Só onde o turno do agente rodaria o Jev é perguntado — ver o cabeçalho. */
export function turnoRodaria(f: FatosDoTurno): boolean {
  return (
    !f.atendimentoExterno &&
    f.sessaoTemQuemAtenda &&
    f.iaPodeResponder &&
    !f.contatoBloqueado &&
    !f.contatoComUmaPessoa &&
    !f.grupo
  );
}

export interface PedidoAPerguntar {
  id: IdDoPedido;
  estado: EstadoQuePergunta;
  pergunta: Pergunta;
}

/**
 * A cascata: só a tarefa que roda, e só onde a regra de hoje disse não. Lista
 * vazia = nenhuma chamada.
 */
export function pedidosAPerguntar(config: ConfigDoJev, regraPegou: RegraPegou): PedidoAPerguntar[] {
  return TAREFAS_DOS_PEDIDOS.flatMap((tarefa) => {
    const estado = estadoEfetivoDaTarefa(config, tarefa);
    return estado === "desligada" || regraPegou[tarefa.id] ? [] : [{ id: tarefa.id, estado, pergunta: PERGUNTAS[tarefa.id] }];
  });
}

/** "sim" quando o Jev passa do corte. */
export function rotuloDoPedido(noul: number): "sim" | "nao" {
  return noul >= CORTE_DO_PEDIDO ? "sim" : "nao";
}

/** A probabilidade de "sim", ou `null` quando a resposta não é uma. */
function probabilidadeDoSim(resposta: Resposta | undefined): number | null {
  if (resposta?.tipo !== "noul") return null;
  return Number.isFinite(resposta.noul) && resposta.noul >= 0 && resposta.noul <= 1 ? resposta.noul : null;
}

export interface EntradaDosPedidos {
  organizationId: string;
  conversationId: string;
  messageId: string;
  contactId: string | null;
  /** O agente que atende — a linha de custo vai para a conta dele em Uso de IA. */
  agentId: string | null;
  /** O que o cliente digitou. Só isso sai, e passado pelo `scrubMessage`. */
  mensagem: string;
  /** O idioma da organização — o do aviso na Central. */
  idioma: Idioma;
  config: ConfigDoJev;
  regraPegou: RegraPegou;
  turno: FatosDoTurno;
}

export interface PedidoRespondido {
  id: IdDoPedido;
  estado: EstadoQuePergunta;
  /** A probabilidade de "é um pedido", de 0 a 1. */
  noul: number;
  rotulo: "sim" | "nao";
}

/** O que uma mensagem rendeu — a entrada de `avisarAEquipe`. */
export interface PedidosObservados {
  entrada: EntradaDosPedidos;
  /** Vazio quando nada foi perguntado ou ele não respondeu. */
  respondidos: PedidoRespondido[];
  /**
   * A observação desta mensagem foi gravada AGORA. Falso no retry do dreno
   * sobre a mesma mensagem (23505): a primeira execução já decidiu o aviso, e
   * uma segunda reabriria o que alguém acabou de resolver.
   */
  nova: boolean;
}

/**
 * Pergunta e grava. O aviso de "Avisar a equipe" é o passo seguinte
 * (`avisarAEquipe`), que quem chama dá depois de saber o que o clima da mesma
 * mensagem fez. Nunca lança.
 */
export async function observarPedidos(
  admin: Admin,
  e: EntradaDosPedidos,
  deps: DependenciasDoPonto = {},
): Promise<PedidosObservados> {
  const nada: PedidosObservados = { entrada: e, respondidos: [], nova: false };
  try {
    if (e.mensagem.trim() === "" || !turnoRodaria(e.turno)) return nada;
    const aPerguntar = pedidosAPerguntar(e.config, e.regraPegou);
    if (aPerguntar.length === 0) return nada;

    const alvo = { organizationId: e.organizationId, tarefa: PEDIDOS_DO_CLIENTE.purpose };
    if (!podeTentar(alvo)) return nada;

    const perguntas: { [id in IdDoPedido]?: Pergunta } = {};
    for (const p of aPerguntar) perguntas[p.id] = p.pergunta;
    const r = await decidirNoPonto(
      { organizationId: e.organizationId, estado: scrubMessage(e.mensagem), perguntas },
      deps,
    );
    if (!r.ok) {
      registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
      if (r.motivo !== "sem_credencial") {
        logger.warn("Jev não respondeu sobre os pedidos do cliente; nada muda no atendimento", {
          organization_id: e.organizationId,
          motivo: r.motivo,
        });
      }
      if (r.exigeAcao) await gravarFalhaQuePedeAcao(admin, e, r);
      return nada;
    }

    const respondidos = aPerguntar.flatMap(({ id, estado }) => {
      const noul = probabilidadeDoSim(r.respostas[id]);
      return noul === null ? [] : [{ id, estado, noul, rotulo: rotuloDoPedido(noul) }];
    });
    if (respondidos.length < aPerguntar.length) {
      registrarFalha(alvo, "resposta_ilegivel", Date.now());
      logger.warn("Jev respondeu a um pedido do cliente fora de uma probabilidade", {
        organization_id: e.organizationId,
      });
    } else {
      registrarSucesso(alvo);
    }
    const nova = await gravar(admin, e, respondidos, r);
    return { entrada: e, respondidos, nova };
  } catch (erro) {
    logger.warn("Jev não pôde ser perguntado sobre os pedidos do cliente", {
      organization_id: e.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return nada;
  }
}

/**
 * Uma linha por pergunta em `jev_observacoes` (sem texto) e uma por chamada em
 * `llm_calls` (o custo, em Execuções). Pelo cliente admin, a pilha do worker:
 * são duas escritas, e não um comando só como no `pg.Pool` do turno — a de
 * custo sai mesmo quando a outra falha, porque a chamada custou. Devolve se a
 * observação entrou agora (ver `PedidosObservados.nova`).
 */
async function gravar(
  admin: Admin,
  e: EntradaDosPedidos,
  respondidos: readonly PedidoRespondido[],
  r: { modelo: string; latenciaMs: number; uso: { tokensDeEntrada: number; tokensDeSaida: number } },
): Promise<boolean> {
  let nova = false;
  if (respondidos.length > 0) {
    const { error } = await admin.from("jev_observacoes").insert(
      respondidos.map((p) => ({
        organization_id: e.organizationId,
        tarefa: p.id,
        estado: p.estado,
        conversation_id: e.conversationId,
        message_id: e.messageId,
        rotulo_jev: p.rotulo,
        probabilidade_jev: p.noul,
        rotulo_atual: A_REGRA_DISSE_NAO,
        modelo: r.modelo,
        latencia_ms: r.latenciaMs,
      })),
    );
    // 23505: o retry do dreno perguntou de novo sobre a MESMA mensagem. A
    // primeira resposta fica; o custo da segunda entra abaixo, porque houve.
    // Só o 23505 diz "não é nova": a observação que falhou por outro motivo
    // (um erro de rede, um tempo esgotado) não tem retry que a recupere, e o
    // Jev disse o que disse — o aviso ainda sai.
    nova = error === null || error.code !== "23505";
    if (error && error.code !== "23505") {
      logger.warn("resposta do Jev sobre os pedidos do cliente não foi gravada", {
        organization_id: e.organizationId,
        erro: error.message.slice(0, 200),
      });
    }
  }
  const { error: custoErr } = await admin.from("llm_calls").insert({
    organization_id: e.organizationId,
    contact_id: e.contactId,
    agent_id: e.agentId,
    purpose: PEDIDOS_DO_CLIENTE.purpose,
    provider: "typesafe",
    model: `typesafe/${r.modelo}`,
    input_tokens: r.uso.tokensDeEntrada,
    output_tokens: r.uso.tokensDeSaida,
    // Fracionário: a centavo por chamada, o Jev custaria ~600x o preço real.
    // Versão sem preço na tabela sai `null`, nunca o preço de outra.
    cost_cents: costCents(r.modelo, {
      inputTokens: r.uso.tokensDeEntrada,
      outputTokens: r.uso.tokensDeSaida,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    latency_ms: r.latenciaMs,
    status: "ok",
    // Observando, a resposta dele só fica registrada. Avisando a equipe, é ela
    // que decide se o aviso abre — o atendimento segue com a regra de hoje.
    origem_da_escolha: respondidos.some((p) => p.estado === "decidindo") ? "jev" : "jev_observacao",
  });
  if (custoErr) {
    logger.warn("custo do Jev nos pedidos do cliente não foi gravado", {
      organization_id: e.organizationId,
      erro: custoErr.message.slice(0, 200),
    });
  }
  return nova;
}

/** O que o clima da MESMA mensagem fez, dito por quem mediu (o worker). */
export interface OClimaDaMensagem {
  /** Emitiu o alerta que passa a conversa a uma pessoa (`ai.sentiment_alert`). */
  chamouUmaPessoa: boolean;
}

/**
 * A conversa no momento do aviso, lida por quem chama logo antes de ele abrir
 * (`aConversaAgora`, na cola do worker: as colunas que calam a conversa não se
 * leem num módulo do Jev). As duas perguntas são as do gatilho da 0426, que
 * fecharia o aviso se ele já existisse.
 */
export interface AConversaAgora {
  /** Uma pessoa ficou com ela, ou ela foi encerrada: os dois avisos nasceriam já atendidos. */
  assumidaOuEncerrada: boolean;
  /** Passada a uma pessoa depois da mensagem, ou com o robô calado: o de falar com uma pessoa nasceria já atendido. */
  passadaAUmaPessoa: boolean;
}

/**
 * "Avisar a equipe": cada pedido percebido (passou do corte) numa tarefa em
 * `decidindo` abre UM aviso na Central por conversa e pedido. Nunca lança.
 *
 * Não avisa:
 *  - no retry do dreno sobre a mesma mensagem (`nova` falso): a primeira
 *    execução já decidiu, e reabrir o que alguém resolveu seria ruído;
 *  - o pedido de pessoa, quando o clima da mesma mensagem já chamou uma pessoa:
 *    a conversa está indo para a equipe por outro caminho, e o aviso diria o
 *    que a Central já diz. A observação fica gravada do mesmo jeito;
 *  - o pedido que a conversa já atendeu enquanto o Jev e o clima respondiam
 *    (`lerAConversa`, só quando há o que avisar): o gatilho da 0426 fecharia o
 *    aviso, mas disparou antes de ele existir.
 *
 * Um aviso por conversa e pedido é do BANCO: o índice único da 0426 em
 * (organização, kind, conversa), sem status. A escrita é um insert, e o 23505
 * dele quer dizer "este aviso já existe" — o pedido novo o reabre, como o
 * `routing_unassigned` faz (em SQL, pelo `on conflict` que o PostgREST não
 * sabe apontar para um índice parcial).
 *
 * O pedido novo põe o aviso na data de AGORA (`created_at`), aberto ou
 * reaberto: a Central ordena e data os avisos por ela ("há 2 meses"), e o aviso
 * existe para o cliente que está esperando agora. Para estes dois kinds,
 * `created_at` é "quando o pedido mais recente chegou": nenhum gatilho o
 * congela, e os outros leitores da coluna (a evolução conta só `handoff`; o
 * relatório de LGPD, só os da agenda) não leem estes kinds.
 */
export async function avisarAEquipe(
  admin: Admin,
  o: PedidosObservados,
  clima: OClimaDaMensagem,
  lerAConversa: () => Promise<AConversaAgora | null>,
): Promise<void> {
  if (!o.nova) return;
  const e = o.entrada;
  const aAvisar = o.respondidos.filter(
    (p) => p.estado === "decidindo" && p.rotulo === "sim" && !(p.id === "humano" && clima.chamouUmaPessoa),
  );
  if (aAvisar.length === 0) return;
  // `null`: não deu para ler, e o aviso abre (é informação; ver `aConversaAgora`).
  const conversa = await lerAConversa().catch(() => null);
  for (const p of aAvisar) {
    if (conversa?.assumidaOuEncerrada === true) continue;
    if (p.id === "humano" && conversa?.passadaAUmaPessoa === true) continue;
    const aviso = AVISOS_DOS_PEDIDOS[p.id];
    const texto = { title: traduzir(aviso.titulo, e.idioma), body: traduzir(aviso.corpo, e.idioma) };
    try {
      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: e.organizationId,
        kind: aviso.kind,
        severity: "warn",
        ...texto,
        ref_kind: "conversation",
        ref_id: e.conversationId,
      });
      if (error === null) continue;
      if (error.code !== "23505") {
        logger.warn("aviso do pedido do cliente na Central não foi gravado", {
          organization_id: e.organizationId,
          erro: error.message.slice(0, 200),
        });
        continue;
      }
      const { error: erroAoReabrir } = await admin
        .from("agent_inbox_items")
        .update({ status: "open", resolved_at: null, created_at: new Date().toISOString(), ...texto })
        .eq("organization_id", e.organizationId)
        .eq("kind", aviso.kind)
        .eq("ref_kind", "conversation")
        .eq("ref_id", e.conversationId);
      if (erroAoReabrir) {
        logger.warn("aviso do pedido do cliente na Central não foi reaberto", {
          organization_id: e.organizationId,
          erro: erroAoReabrir.message.slice(0, 200),
        });
      }
    } catch (erro) {
      logger.warn("aviso do pedido do cliente na Central falhou", {
        organization_id: e.organizationId,
        erro: erro instanceof Error ? erro.name : typeof erro,
      });
    }
  }
}

/**
 * A falha que pede ação (chave recusada, sem crédito, pergunta recusada) vira
 * linha de erro em Execuções — é dela que o cartão tira a "Última falha", com o
 * nome desta chamada. A mesma forma da do turno (`./pool.ts`), pela outra pilha.
 */
async function gravarFalhaQuePedeAcao(admin: Admin, e: EntradaDosPedidos, falha: FalhaDaDecisao): Promise<void> {
  const { error } = await admin.from("llm_calls").insert({
    organization_id: e.organizationId,
    contact_id: e.contactId,
    agent_id: e.agentId,
    purpose: PEDIDOS_DO_CLIENTE.purpose,
    provider: "typesafe",
    model: `typesafe/${MODELO_DO_JEV}`,
    input_tokens: 0,
    output_tokens: 0,
    cost_cents: 0,
    latency_ms: falha.latenciaMs ?? null,
    status: "erro",
    error_code: codigoDoErroDoJev(falha.motivo),
    http_status: falha.status,
    origem_da_escolha: "jev_observacao",
  });
  if (error) {
    logger.warn("falha do Jev nos pedidos do cliente não foi gravada", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}

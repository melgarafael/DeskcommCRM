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
 * regra é quem chama (`workers/ai-sentiment-worker.ts`): a de pessoa mora no
 * agent-engine, e o que este módulo executa não pode importar de lá
 * (`tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`).
 *
 * ═══ SÓ ONDE O TURNO RODARIA ═══
 *
 * Perguntar numa conversa em que o agente nem responderia (sem agente no ar,
 * com uma pessoa no comando, contato bloqueado, grupo) contaria "pedidos
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
 * ═══ O QUE ELE NUNCA FAZ ═══
 *
 * Não passa a conversa, não cala, não bloqueia, não responde. Nesta versão ele
 * só grava: uma linha por pergunta em `jev_observacoes` e uma por chamada em
 * `llm_calls`. Sai só o que o cliente digitou na mensagem, passado pelo
 * `scrubMessage` (o aceite em vigor: cada mensagem, sozinha). Nunca lança.
 */
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
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

/** O que a regra de hoje já pegou nesta mensagem. Quem chama roda a regra. */
export type RegraPegou = Readonly<Record<IdDoPedido, boolean>>;

/** O que o turno do agente olha antes de responder — lido por quem chama. */
export interface FatosDoTurno {
  /** Um agente NO AR atende a conversa (`agenteAtende`, `lib/ai/agents/no-ar.ts`). */
  agenteAtende: boolean;
  /**
   * A elegibilidade do turno deixa a IA responder (`decidirElegibilidade`,
   * `lib/ai/elegibilidade/gate.ts`): sem pessoa no comando, sem silêncio, sem a
   * trava da lista do canal.
   */
  iaPodeResponder: boolean;
  /** O contato já foi bloqueado pela regra de descadastro (ou por uma pessoa). */
  contatoBloqueado: boolean;
  /** Conversa de grupo: o agente nunca atende grupo. */
  grupo: boolean;
}

/** Só onde o turno do agente rodaria o Jev é perguntado — ver o cabeçalho. */
export function turnoRodaria(f: FatosDoTurno): boolean {
  return f.agenteAtende && f.iaPodeResponder && !f.contatoBloqueado && !f.grupo;
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

/**
 * Pergunta e grava. Devolve o que ele respondeu — vazio quando nada foi
 * perguntado (fora do turno, regra já pegou, tarefas pausadas) ou quando ele
 * não respondeu. Nunca lança.
 */
export async function observarPedidos(
  admin: Admin,
  e: EntradaDosPedidos,
  deps: DependenciasDoPonto = {},
): Promise<PedidoRespondido[]> {
  try {
    if (e.mensagem.trim() === "" || !turnoRodaria(e.turno)) return [];
    const aPerguntar = pedidosAPerguntar(e.config, e.regraPegou);
    if (aPerguntar.length === 0) return [];

    const alvo = { organizationId: e.organizationId, tarefa: PEDIDOS_DO_CLIENTE.purpose };
    if (!podeTentar(alvo)) return [];

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
      return [];
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
    await gravar(admin, e, respondidos, r);
    return respondidos;
  } catch (erro) {
    logger.warn("Jev não pôde ser perguntado sobre os pedidos do cliente", {
      organization_id: e.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return [];
  }
}

/**
 * Uma linha por pergunta em `jev_observacoes` (sem texto) e uma por chamada em
 * `llm_calls` (o custo, em Execuções). Pelo cliente admin, a pilha do worker:
 * são duas escritas, e não um comando só como no `pg.Pool` do turno — a de
 * custo sai mesmo quando a outra falha, porque a chamada custou.
 */
async function gravar(
  admin: Admin,
  e: EntradaDosPedidos,
  respondidos: readonly PedidoRespondido[],
  r: { modelo: string; latenciaMs: number; uso: { tokensDeEntrada: number; tokensDeSaida: number } },
): Promise<void> {
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
    // Ele só observa: quem decide o atendimento é a regra de hoje.
    origem_da_escolha: "jev_observacao",
  });
  if (custoErr) {
    logger.warn("custo do Jev nos pedidos do cliente não foi gravado", {
      organization_id: e.organizationId,
      erro: custoErr.message.slice(0, 200),
    });
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

/**
 * OS PEDIDOS DO CLIENTE, DO LADO DO WORKER DE CLIMA — a cola entre o Jev
 * (`lib/ai/decisao/pedidos.ts`) e o que só o worker lê: a REGRA DE HOJE e os
 * fatos do turno do agente.
 *
 * Mora fora de `lib/ai/decisao` porque a regra de hoje mora no agent-engine, e
 * o que o Jev executa não pode importar de lá. Mas é código que o Jev executa:
 * a cerca `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts` varre este
 * arquivo inteiro — nenhuma escrita na mensagem, na conversa ou no contato, e
 * do agent-engine só os LEITORES nomeados lá (a detecção de pedido explícito,
 * as palavras de passagem, `isLeadInHandoff`, o corpo da mensagem como o turno
 * o lê). Quem lê não passa nem bloqueia.
 *
 * ═══ A REGRA DE HOJE, como o turno a aplica (`regraDeHoje`) ═══
 *
 * Sobre TODAS as mensagens do cliente ainda sem resposta, e não só esta: o
 * turno roda a regra sobre cada uma delas (`inboundsPendentes.some`), porque o
 * dreno junta a rajada num turno só. "quero falar com um atendente" seguido de
 * "por favor, alguém de verdade" é UM pedido que a regra pegou — a 2ª mensagem
 * não é um que ela deixou passar. O conjunto é o do turno
 * (`mensagensDoClienteSemResposta`).
 *
 * - pessoa: a detecção de pedido explícito, as palavras de passagem de QUALQUER
 *   agente que pode atender a conversa (`palavrasDeQuemPodeAtender`, normalizadas
 *   como o turno as lê), e o descadastro, pedido ou provável — no turno, o
 *   provável também cala o agente e passa a conversa a uma pessoa;
 * - parar de receber: `lib/opt-out/deteccao.ts`, pedido ou provável.
 *
 * ═══ ONDE O TURNO RODARIA ═══
 *
 * A organização não delegou o atendimento a um sistema de fora (o modo
 * `external` da spec 14, que o dreno descarta antes de tudo); o portão do dreno
 * (`haQuemAtendaASessao`, a mesma função que ele chama) com quem atenda NÃO
 * PAUSADO — pausar pela tela mantém a versão publicada, e o turno sai na pausa
 * antes da regra; a elegibilidade desta conversa (lida por quem chama); o
 * contato não bloqueado e sem conversa nenhuma com uma pessoa
 * (`isLeadInHandoff`, o no-op do turno); e fora de grupo.
 *
 * DECLARADO, não espelhado: o dreno também cede o turno ao follow-up de
 * retorno (`deveCederTurnoAoRetorno`, `lib/agent-engine/edge/crm/drain.ts`) —
 * o cliente que volta depois de uma sequência de follow-up é atendido pelo
 * follow-up, e a regra de hoje não roda naquela mensagem. É raro, a pergunta
 * lê o estado dos enrollments do contato (outra pilha), e ali o aviso ainda
 * ajuda: o Jev pode contar um pedido nessa mensagem.
 *
 * Leitura que falha pesa para NÃO perguntar: sem saber se a regra pegou ou se o
 * turno rodaria, o Jev não opina. Nunca rejeita.
 */
import { matchesHandoffKeyword, palavrasDePassagem } from "@/lib/agent-engine/agent/agent-config";
import { detectHumanHandoffRequest, isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { corpoDaMensagem, type CorpoDaMensagemRow } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { haQuemAtendaASessao, palavrasDeQuemPodeAtender } from "@/lib/ai/agents/quem-atende-a-sessao";
import type { ConfigDoJev } from "@/lib/ai/decisao/config";
import {
  observarPedidos,
  type AConversaAgora,
  type PedidosObservados,
  type RegraPegou,
} from "@/lib/ai/decisao/pedidos";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;
type Db = Parameters<typeof haQuemAtendaASessao>[0];

/**
 * O que a regra de hoje já pegou nas mensagens do cliente ainda sem resposta
 * (esta inclusa), com as palavras de passagem de quem pode atender: pegou se
 * QUALQUER uma casa — como o turno a aplica.
 */
export function regraDeHoje(mensagens: readonly string[], palavras: readonly string[]): RegraPegou {
  const descadastro = mensagens.some((m) => ehPedidoDeOptOut(m) || ehOptOutProvavel(m));
  return {
    humano:
      descadastro || mensagens.some((m) => detectHumanHandoffRequest(m) || matchesHandoffKeyword(m, palavras)),
    opt_out: descadastro,
  };
}

/**
 * O que o cliente escreveu desde a última resposta do nosso lado — o conjunto
 * que o turno lê (`inboundsNaoRespondidos` sobre o histórico de
 * `getLeadContext`), com o MESMO critério: o atendimento em vigor (a inbound da
 * revisão e da demanda atuais da conversa, a outbound desde o início do
 * atendimento), o corte na última outbound pela mesma ordem (`sent_at`, `id`),
 * a mensagem vazia fora, e o corpo composto por `corpoDaMensagem` — a
 * transcrição de um áudio, quando há. Da mais antiga para a mais nova. A
 * paridade com o turno é provada contra um Postgres em
 * `tests/invariants/jev-regra-da-rajada-le-o-que-o-turno-le.test.ts`.
 *
 * ponytail: sem a janela do agente (`history_message_window`, 20 por padrão) e
 * sem o corte por tokens do contexto — ler MAIS mensagens que o turno só pode
 * fazer a regra pegar mais, o lado de não perguntar. O teto de 50 é de custo:
 * um agente com janela maior que isso E mais de 50 mensagens sem resposta é o
 * limite conhecido (a regra olharia menos que o turno).
 */
export async function mensagensDoClienteSemResposta(
  db: Db,
  organizationId: string,
  conversationId: string,
): Promise<string[]> {
  const { rows } = await db.query<CorpoDaMensagemRow>(
    `select m.type, m.body, m.media_url, m.media_storage_path, m.media_derived_text
       from messages m
       join conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
      where m.organization_id = $1 and m.conversation_id = $2 and m.direction = 'inbound'
        and m.service_revision = c.service_revision
        and m.demanda_id is not distinct from c.current_demanda_id
        and not exists (
          select 1 from messages o
           where o.organization_id = $1 and o.conversation_id = $2 and o.direction = 'outbound'
             and o.sent_at >= c.service_started_at
             and (o.sent_at, o.id) > (m.sent_at, m.id)
        )
      order by m.sent_at desc, m.id desc
      limit 50`,
    [organizationId, conversationId],
  );
  return rows
    .reverse()
    .map(corpoDaMensagem)
    .filter((corpo) => corpo.trim() !== "");
}

export interface MensagemDoCliente {
  organizationId: string;
  messageId: string;
  conversationId: string | null;
  /** O número da conversa (`conversations.channel_session_id`). */
  sessaoId: string | null;
  contactId: string | null;
  grupo: boolean;
  /** A elegibilidade DESTA conversa (`permite`), que o worker já leu. */
  iaPodeResponder: boolean;
  /** A organização delegou o atendimento a um sistema de fora (`ai_dispatch_mode = 'external'`). */
  atendimentoExterno: boolean;
  /** O agente que o worker resolveu, para a linha de custo — não decide se o turno roda. */
  agentId: string | null;
  config: ConfigDoJev;
  mensagem: string;
  idioma: Idioma;
}

/**
 * Lê a regra e os fatos, e pergunta (`observarPedidos`). `null` quando nada
 * foi lido — fora do turno pelos fatos que o worker já tem, ou uma leitura que
 * falhou. O aviso é o passo seguinte, de quem chama (`avisarAEquipe`).
 */
export async function perguntarOsPedidosDoCliente(
  admin: Admin,
  c: MensagemDoCliente,
): Promise<PedidosObservados | null> {
  try {
    if (
      c.conversationId === null ||
      c.contactId === null ||
      c.grupo ||
      !c.iaPodeResponder ||
      c.atendimentoExterno
    ) {
      return null;
    }
    const conversationId = c.conversationId;
    const contactId = c.contactId;
    const pool = getRequestPool();
    const [contato, comUmaPessoa, haQuem, palavras, semResposta] = await Promise.all([
      admin
        .from("contacts")
        .select("is_blocked")
        .eq("organization_id", c.organizationId)
        .eq("id", contactId)
        .maybeSingle(),
      isLeadInHandoff(pool, c.organizationId, contactId),
      c.sessaoId === null ? null : haQuemAtendaASessao(pool, c.organizationId, c.sessaoId, { ignorarPausados: true }),
      palavrasDeQuemPodeAtender(pool, c.organizationId, c.sessaoId, conversationId).then(palavrasDePassagem),
      mensagensDoClienteSemResposta(pool, c.organizationId, conversationId),
    ]);
    return await observarPedidos(admin, {
      organizationId: c.organizationId,
      conversationId,
      messageId: c.messageId,
      contactId,
      agentId: c.agentId,
      mensagem: c.mensagem,
      idioma: c.idioma,
      config: c.config,
      // Esta mensagem entra sempre: é dela que o Jev é perguntado.
      regraPegou: regraDeHoje([...semResposta, c.mensagem], palavras),
      turno: {
        atendimentoExterno: c.atendimentoExterno,
        sessaoTemQuemAtenda: haQuem === true,
        iaPodeResponder: c.iaPodeResponder,
        contatoBloqueado: contato.error !== null || contato.data?.is_blocked !== false,
        contatoComUmaPessoa: comUmaPessoa,
        grupo: c.grupo,
      },
    });
  } catch (erro) {
    logger.warn("[ai-sentiment-worker] os pedidos do cliente não foram perguntados ao Jev", {
      organization_id: c.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

/**
 * A conversa AGORA, lida logo antes de o aviso de "Avisar a equipe" abrir: o
 * aviso é gravado depois do clima (segundos), e nesse meio a conversa pode ter
 * ido para uma pessoa — o turno da rajada passou, alguém assumiu. O gatilho da
 * 0426 que fecharia o aviso já disparou quando ele ainda não existia, então o
 * aviso que nascesse ali ficaria aberto sobre um pedido já atendido. As
 * condições são as do gatilho: fora dos estados abertos, os dois; com uma
 * pessoa (`assigned_to_user_id`), passada a uma pessoa depois desta mensagem
 * (`last_handoff_at`) ou com o robô calado, só o de falar com uma pessoa — o
 * de parar de receber pede que a equipe assuma E peça o PARAR, e segue valendo
 * com a conversa assumida.
 *
 * O silêncio durável é o literal `'infinity'`, que o supabase-js devolve como
 * texto: lido como infinito, como `normalizarInstante`
 * (`lib/ai/elegibilidade/gate.ts`) o lê — `Date.parse` daria NaN, e o robô
 * calado para sempre pareceria falando. ponytail: a leitura dele numa linha, e
 * não o import: o módulo dele alcança `lib/channels`, que a cerca desta cola
 * (`tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`) reprova. Mover
 * `normalizarInstante` para um módulo sem esse import é o passo, se um terceiro
 * leitor aparecer.
 *
 * `null` quando não deu para ler — e aí o aviso abre: é informação, e perder o
 * pedido de um cliente esperando é pior que um aviso a mais, que o gatilho e o
 * "Marcar resolvido" fecham. Sobra a janela entre esta leitura e o insert
 * (milissegundos): uma passagem gravada exatamente ali deixa o aviso aberto.
 */
export async function aConversaAgora(
  admin: Admin,
  organizationId: string,
  conversationId: string,
  /** Quando a mensagem entrou (`messages.created_at`, o relógio do banco, como `last_handoff_at`). */
  recebidaEm: string | null,
): Promise<AConversaAgora | null> {
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("assigned_to_user_id, status, bot_silenced_until, last_handoff_at")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error !== null || data === null) return null;
    const c = data as {
      assigned_to_user_id: string | null;
      status: string;
      bot_silenced_until: string | null;
      last_handoff_at: string | null;
    };
    const abertos: readonly string[] = OPEN_LOAD_STATUSES;
    const caladoAte =
      c.bot_silenced_until === null
        ? null
        : c.bot_silenced_until === "infinity"
          ? Number.POSITIVE_INFINITY
          : Date.parse(c.bot_silenced_until);
    const passadaEm = c.last_handoff_at === null ? null : Date.parse(c.last_handoff_at);
    return {
      encerrada: !abertos.includes(c.status),
      comUmaPessoa:
        c.assigned_to_user_id !== null ||
        (caladoAte !== null && caladoAte > Date.now()) ||
        (passadaEm !== null && recebidaEm !== null && passadaEm >= Date.parse(recebidaEm)),
    };
  } catch {
    return null;
  }
}

/**
 * OS PEDIDOS DO CLIENTE DITOS EM ÁUDIO — a cola da transcrição (#2233).
 *
 * ─── O DEFITO ───────────────────────────────────────────────────────────────
 *
 * Um "não quero mais receber mensagem" FALADO chega ao CRM como `body` vazio:
 * a transcrição é gravada depois, pelo worker de mídia, e os dois caminhos que
 * decidem sobre o pedido nunca a enxergam. O que grava `is_blocked` roda na
 * INGESTÃO (`lib/channels/pos-entrada.ts`), com o texto que o canal entregar —
 * num áudio sem legenda, nada; e a cascata da onda 3 pergunta ao Jev na
 * `message.received`, cujo corpo também está vazio. No Brasil boa parte das
 * respostas do WhatsApp é áudio: o pedido existia, o sistema não via.
 *
 * ─── O QUE ESTE ARQUIVO FAZ ─────────────────────────────────────────────────
 *
 * Quando o worker de mídia conclui a transcrição de um ÁUDIO DO CLIENTE
 * (`media_derived_status = 'ready'`), a MESMA cascata da onda 3 roda sobre o
 * transcrito, aqui, fora do caminho do turno (nenhuma latência de resposta):
 *
 *   1. a regra de hoje — `ehPedidoDeOptOut` / `ehOptOutProvavel` de
 *      `lib/opt-out/deteccao.ts` e `detectHumanHandoffRequest` do agent-engine;
 *   2. só onde ela disse não, a tarefa de pedidos do Jev
 *      (`lib/ai/decisao/pedidos.ts`), com os mesmos cortes (pessoa 0,9,
 *      parar 0,8) e o mesmo `estado` que a empresa escolheu.
 *
 * A cascata em si mora em `perguntarOsPedidosDoCliente` (a cola do worker de
 * clima), que recebe o transcrito como `mensagem`: é a MESMA função, o mesmo
 * portão e as mesmas leituras — só muda quem a chama e o texto que ela lê.
 *
 * ─── A DIFERENÇA DE POLÍTICA, E ELA É O PONTO ───────────────────────────────
 *
 * Sobre texto TRANSCRITO ninguém bloqueia. Nem a regra grava `is_blocked` (o
 * único escritor disso continua sendo o STOP do cliente, na entrada da
 * mensagem), nem o Jev passa, cala ou responde — as duas camadas só ABREM o
 * aviso da Central (`jev_parar_de_receber` / `jev_pedido_de_humano`, o kind do
 * #1747, que fica aberto até o bloqueio, o encerramento ou "Marcar resolvido").
 * O falso positivo aqui é pior que em texto: soma o erro da transcrição ao da
 * regex, e o bloqueio corta todo envio ao contato (before-send, funil,
 * follow-up, campanha) até um admin desfazê-lo à mão
 * (`app/api/v1/contacts/[id]/unblock`, regra W-02). Quem silencia é a pessoa,
 * como diz o cabeçalho de `lib/opt-out/deteccao.ts`: o ambíguo escala, não
 * bloqueia.
 *
 * ─── O DENOMINADOR É O DO #1747 ─────────────────────────────────────────────
 *
 * Mesmo portão de capacidade (há quem atenda o número), elegibilidade e
 * "contato não bloqueado": `perguntarOsPedidosDoCliente` lê tudo isso e
 * devolve `null` quando algum fecha — e sem `turnoRodaria` não abre nem o aviso
 * da regra. Grupo fica de fora, mensagem já anonimizada também (a lição do
 * #2191: a gravação da transcrição já recusa a linha redigida, e este caminho
 * só roda depois dela), e áudio do PRÓPRIO ATENDENTE (`sent_via` de humano) é
 * ignorado lá no worker.
 *
 * ─── O QUE NUNCA ACONTECE AQUI ──────────────────────────────────────────────
 *
 * Nenhuma escrita em mensagem, conversa ou contato — só o aviso na Central.
 * E a transcrição nunca sai deste arquivo: não vai para log, nem para
 * `jev_observacoes`, nem para o corpo do aviso (o texto do aviso é fixo, em
 * `AVISOS_DA_REGRA`); ela só sai para o provedor de decisão, na chamada do
 * Jev, passada pelo `scrubMessage` — a finalidade nova que a issue declara no
 * aceite. Falha aqui vira log sem conteúdo e nunca derruba a derivação: o
 * áudio já virou texto, que é o que importava.
 */
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import {
  avisarAEquipe,
  avisarPelaRegra,
  turnoRodaria,
  type IdDoPedido,
  type PedidosObservados,
} from "@/lib/ai/decisao/pedidos";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { aiDispatchModeSchema } from "@/lib/schemas/settings";
import type { createAdminClient } from "@/lib/supabase/admin";
import { aConversaAgora, perguntarOsPedidosDoCliente } from "@/workers/ai-sentiment-worker.pedidos";

type Admin = ReturnType<typeof createAdminClient>;

export interface PedidoFalado {
  organizationId: string;
  messageId: string;
  conversationId: string;
  /** A transcrição do áudio — o único texto que entra aqui, e que nunca sai em log. */
  transcricao: string;
  /** Quando a mensagem entrou (`messages.created_at`, como em `aConversaAgora`). */
  recebidaEm: string | null;
}

/**
 * A regra de hoje sobre o TRANSCRITO, um pedido por vez.
 *
 * Por que não reusar `regraDeHoje`: ela devolve `humano` também quando o que a
 * regra pegou foi o descadastro (no turno, o descadastro cala e passa), e aqui
 * os dois pedidos abrem avisos DIFERENTES — abrir o dos dois porque um só
 * casou seria a Central afirmando um pedido que ninguém fez.
 *
 * As três funções são as da issue: o inequívoco e o provável do
 * `deteccao.ts`, e a detecção de pedido explícito de pessoa. As palavras de
 * passagem do atendente (`matchesHandoffKeyword`) ficam de fora de propósito:
 * elas são vocabulário de QUEM ATENDE, escrito pela empresa, e valem no turno;
 * sobre transcrição de áudio, o que se ouve é a fala do CLIENTE.
 *
 * O controle clássico cabe aqui: "tem como parar a dor depois da extração?"
 * transcrita não é nada — é o caso que o `deteccao.ts` existe para não bloquear.
 */
export function pedidosQueARegraViuNaTranscricao(transcricao: string): IdDoPedido[] {
  const ids: IdDoPedido[] = [];
  if (ehPedidoDeOptOut(transcricao) || ehOptOutProvavel(transcricao)) ids.push("opt_out");
  if (detectHumanHandoffRequest(transcricao)) ids.push("humano");
  return ids;
}

/**
 * A cascata da onda 3 sobre a transcrição de um áudio do cliente. Nunca lança.
 *
 * `null` lido como "nada foi perguntado" — porta fechada (fora do turno) ou
 * leitura que falhou, e aí o silêncio é o lado seguro: sem saber se o turno
 * rodaria, não se opina.
 */
export async function avaliarPedidosFalados(admin: Admin, p: PedidoFalado): Promise<void> {
  try {
    const { data: conversa } = await admin
      .from("conversations")
      .select("id, channel_session_id, contact_id, is_group, active_ai_agent_id")
      .eq("id", p.conversationId)
      .eq("organization_id", p.organizationId)
      .maybeSingle();
    if (conversa === null) return;

    const { data: org } = await admin
      .from("organizations")
      .select("settings, locale")
      .eq("id", p.organizationId)
      .maybeSingle();
    const settings = (org as { settings?: unknown; locale?: string | null } | null)?.settings ?? null;
    const locale = (org as { locale?: string | null } | null)?.locale ?? null;

    // Fail-closed como no worker de clima: sem saber se a IA pode responder
    // nesta conversa, não se pergunta nem se avisa.
    const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
      organizationId: p.organizationId,
      conversationId: p.conversationId,
      agora: new Date(),
      ttlMs: ttlDaAutorizacaoMs(process.env),
    });

    const linha = conversa as {
      channel_session_id: string | null;
      contact_id: string | null;
      is_group: boolean | null;
      active_ai_agent_id: string | null;
    };

    const observados: PedidosObservados | null = await perguntarOsPedidosDoCliente(admin, {
      organizationId: p.organizationId,
      messageId: p.messageId,
      conversationId: p.conversationId,
      sessaoId: linha.channel_session_id,
      contactId: linha.contact_id,
      grupo: linha.is_group === true,
      iaPodeResponder: elegib?.permite === true,
      atendimentoExterno: aiDispatchModeSchema.parse(
        (settings as { ai_dispatch_mode?: unknown } | null)?.ai_dispatch_mode,
      ) === "external",
      // O agente ATIVO da conversa é quem paga a linha de custo em Uso de IA.
      // O worker de clima resolve o agente pela publicação da sessão; aqui a
      // leitura seria mais pesada que a decisão, e `active_ai_agent_id` é
      // justamente o que o resolvedor escolhe primeiro — `null` quando não há.
      agentId: linha.active_ai_agent_id,
      config: lerConfigDoJev(settings),
      // É o TRANSCRITO que o Jev lê, e a regra de hoje roda sobre ele junto
      // (`regraDeHoje` acrescenta esta mensagem ao conjunto da rajada).
      mensagem: p.transcricao,
      idioma: normalizarIdioma(locale),
    });
    if (observados === null) return;

    const lerAConversa = (): ReturnType<typeof aConversaAgora> =>
      aConversaAgora(admin, p.organizationId, p.conversationId, p.recebidaEm);

    // O MESMO portão para as duas camadas: onde o turno não rodaria, nem a
    // regra avisa nem o Jev é perguntado.
    if (turnoRodaria(observados.entrada.turno)) {
      await avisarPelaRegra(
        admin,
        {
          organizationId: p.organizationId,
          conversationId: p.conversationId,
          idioma: observados.entrada.idioma,
        },
        pedidosQueARegraViuNaTranscricao(p.transcricao),
        lerAConversa,
      );
    }
    // O clima desta mensagem não correu (o corpo do áudio chega vazio na
    // `message.received`): ninguém chamou uma pessoa pelo caminho dele.
    await avisarAEquipe(admin, observados, { chamouUmaPessoa: false }, lerAConversa);
  } catch (erro) {
    // Sem a transcrição no log: nome do erro basta para saber onde olhar, e o
    // áudio já está gravado como texto — é o que a derivação existia para isso.
    logger.warn("[media-derive] os pedidos ditos no áudio não foram avaliados", {
      organization_id: p.organizationId,
      message_id: p.messageId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
}

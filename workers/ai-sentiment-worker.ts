/**
 * ai-sentiment-worker — classifies the sentiment of inbound messages.
 *
 * Consumes `message.received` events (parallel to ai-response-worker).
 * Uses `anthropic/claude-haiku-4-5` via Vercel AI Gateway with generateObject
 * and a strict Zod schema so the result is always typed.
 *
 * Com o Jev (System One) ligado em `organizations.settings.jev`, ele mede
 * primeiro — ver o bloco "O Jev primeiro" no meio do arquivo.
 *
 * Design principles (CLAUDE.md):
 * - Service-role admin client bypasses RLS → EVERY query filters `organization_id`
 *   programmatically from the trusted event_log row, never from user input.
 * - Any failure is swallowed (try/catch global) so the bot path in
 *   ai-response-worker keeps running unaffected.
 * - `console.log` is forbidden — only `console.warn`/`console.error` with prefix.
 */

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { resolverAgenteDaConversa } from "@/lib/ai/agents/agente-da-conversa";
import { computeCost } from "@/lib/ai/cost";
import { MODELO_DO_JEV, type MotivoComRede } from "@/lib/ai/decisao/cliente";
import { medirClima, type ClimaMedido } from "@/lib/ai/decisao/clima";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { falhasSeguidas } from "@/lib/ai/decisao/disjuntor";
import { CHAVES_DO_CLIMA, type MotorDoClima } from "@/lib/ai/decisao/metadados-do-clima";
import { AVISO_DO_JEV, avisoDoJevNaCentral, codigoDoErroDoJev } from "@/lib/ai/decisao/textos";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logInvocation, type LogInvocationInput } from "@/lib/ai/log-invocation";
import { DEFAULT_SENTIMENT_THRESHOLD, SENTIMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts/sentiment";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

const SENTIMENT_MODEL = DEFAULT_CLASSIFIER_MODEL; // "anthropic/claude-haiku-4-5"
const CLASSIFY_TIMEOUT_MS = 5_000;

// As descrições NÃO são decoração: viram o JSON Schema da ferramenta que o
// provider manda ao modelo. Sem elas o `.max(100)` existia só no validador — o
// modelo nunca ficava sabendo do limite e escrevia 223, 297, 340 caracteres
// (medido com mensagens reais desta instalação). Com a descrição, o mesmo
// conjunto caiu para 59–102.
//
// O teto do Zod é FOLGADO de propósito. Modelo não conta caractere: mesmo
// avisado, uma amostra bateu 102. Reprovar a classificação inteira por 2
// caracteres a mais seria péssimo negócio — ainda mais porque
// `reasoning_short` é DESCARTADO (só `sentiment_score` e a latência vão para
// messages.metadata). Ele existe para o modelo raciocinar antes de pontuar,
// não para ser guardado. A descrição segura a verbosidade (e o custo); o teto
// só impede resposta absurda.
const sentimentSchema = z.object({
  sentiment_score: z
    .number()
    .min(0)
    .max(1)
    .describe("0 = muito negativo, 0.5 = neutro, 1 = muito positivo"),
  reasoning_short: z
    .string()
    .max(280)
    .describe("Justificativa curta da nota, em NO MÁXIMO 100 caracteres"),
});

export interface SentimentResult {
  skipped: boolean;
  reason?: string;
  sentiment_score?: number;
}

export async function processSentiment(event: EventRow): Promise<SentimentResult> {
  try {
    // Sem portão de `.env` na frente: `isAiGatewayConfigured()` só olhava três
    // variáveis de ambiente e barrava a chave colada pela tela (IA ›
    // Credenciais) e a OpenAI. Quem sabe se existe modelo é o resolver abaixo,
    // que devolve `null` quando nada existe.
    //
    // Passar SENTIMENT_MODEL como string cai no gateway da Vercel mesmo sem
    // chave (plano anônimo) e devolve "Unauthenticated ... Configure
    // AI_GATEWAY_API_KEY" — o que quebrava este worker em toda instalação que
    // só tem ANTHROPIC_API_KEY, ou seja, o padrão do install.sh. O resolver
    // devolve o provider certo para a chave que existir.
    // O painel de provedores manda AQUI também. Sem esta linha, a tela
    // oferecia "Medir o clima da conversa", aceitava a escolha e dizia
    // "salvo" — e este worker seguia usando o modelo padrão. Botão que não
    // controla nada é pior que botão ausente: gasta a confiança de quem clicou.
    // O id padrão é da Anthropic: numa empresa que atende pela OpenAI, Google
    // ou DeepSeek sem modelo escolhido para o clima, ninguém o executa, e o
    // clima ficava mudo enquanto o painel dizia "Usando o padrão da
    // organização". A queda para o padrão da organização é o que torna isso
    // verdade. A rota do cartão do Jev faz a MESMA pergunta.
    const resolvido = await resolverModeloDoPonto(
      "sentiment_classify",
      event.organization_id,
      SENTIMENT_MODEL,
      { naFaltaUsarOPadraoDaOrganizacao: true },
    );

    const messageId =
      (event.payload?.["message_id"] as string | undefined) ?? event.entity_id ?? null;
    const conversationId = (event.payload?.["conversation_id"] as string | undefined) ?? null;
    if (!messageId) {
      return { skipped: true, reason: "missing_message_id" };
    }

    const admin = createAdminClient();

    // ── O interruptor do Jev ──────────────────────────────────────────────
    // Lido aqui, além de dentro de `medirClima`, porque o MODO muda quem decide.
    // Leitura que falha vale como desligado (`lerConfigDoJev` nunca lança).
    const { data: org } = await admin
      .from("organizations")
      .select("settings, locale")
      .eq("id", event.organization_id)
      .maybeSingle();
    const daOrg = org as { settings?: unknown; locale?: string | null } | null;
    const jev = lerConfigDoJev(daOrg?.settings);

    // Sem IA de linguagem e sem o Jev, não há quem meça.
    if (!resolvido && !jev.ligado) {
      return { skipped: true, reason: "ai_gateway_key_missing" };
    }

    // ── Load message (programmatic org filter) ────────────────────────────
    const { data: message, error: msgErr } = await admin
      .from("messages")
      .select("id, body, direction, conversation_id, organization_id, metadata")
      .eq("id", messageId)
      .eq("organization_id", event.organization_id)
      .maybeSingle();

    if (msgErr || !message) {
      return { skipped: true, reason: "message_not_found" };
    }

    // ── Guard: inbound only ───────────────────────────────────────────────
    if (message.direction !== "inbound") {
      return { skipped: true, reason: "not_inbound" };
    }

    // ── Guard: non-empty body ─────────────────────────────────────────────
    const body = (message.body ?? "").trim();
    if (!body) {
      return { skipped: true, reason: "empty_body" };
    }

    // ── Guard: elegibilidade da IA ────────────────────────────────────────
    // O único efeito deste worker é alimentar o handoff por sentimento
    // (`ai.sentiment_alert` → `triggerHandoff`). Numa conversa que o gate
    // `allowlist` barra, `triggerHandoff` já se recusa — então classificar aqui
    // seria só queimar um Haiku à toa. Pula cedo. `open` (o default) segue.
    // Fail-closed: erro de leitura → pula (sem custo, sem efeito).
    const convIdParaGate = conversationId ?? (message.conversation_id as string | null);
    if (convIdParaGate) {
      try {
        const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: event.organization_id,
          conversationId: convIdParaGate,
          agora: new Date(),
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        if (elegib !== null && elegib.bloqueioPorAllowlist) {
          return { skipped: true, reason: "nao_elegivel_para_ia" };
        }
      } catch {
        return { skipped: true, reason: "elegibilidade_indeterminada" };
      }
    }

    // ── Qual agente atende ESTA conversa? ─────────────────────────────────
    //
    // Antes, a resposta era "o primeiro da organização que atende", ordenado por
    // `is_default` e depois `created_at` — e a conversa que disparou o evento não
    // entrava na consulta em lugar nenhum. Com um agente só, certo por acidente.
    // Com dois, o limiar em vigor passava a depender da ORDEM DE CRIAÇÃO: numa
    // clínica, cliente triste é sinal de problema; numa assistência técnica, é o
    // cliente normal. O mesmo limiar erra nos dois sentidos, e quem configurou o
    // campo do agente B ficava vendo o comportamento do agente A sem pista
    // nenhuma na tela — os dois campos existem, os dois aceitam valor, e um
    // deles não fazia nada. (issue #486)
    const { data: conversa } = await admin
      .from("conversations")
      .select("id, channel_session_id, active_ai_agent_id")
      .eq("id", message.conversation_id)
      .eq("organization_id", event.organization_id)
      .maybeSingle();

    // As versões PUBLICADAS ligadas ao número em que a conversa acontece — é
    // quem de fato responde ao cliente por aquela sessão. `null` (não consegui
    // consultar) e `[]` (consultei, não há) levam ao mesmo desfecho na régua,
    // mas quem lê o log precisa distinguir os dois.
    let versoesPublicadasNaSessao: string[] | null = null;
    if (conversa?.channel_session_id) {
      const { data: versoes } = await admin
        .from("ai_agent_versions")
        .select("id, channel_session_id, status")
        .eq("organization_id", event.organization_id)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      versoesPublicadasNaSessao = (versoes ?? []).map((v) => v.id as string);
    }

    const { data: candidatos } = await admin
      .from("ai_agents")
      .select(
        "id, config, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at",
      )
      .eq("organization_id", event.organization_id)
      .is("archived_at", null);

    const { agente: agent, motivo: motivoDoAgente } = resolverAgenteDaConversa(
      candidatos ?? [],
      conversa
        ? {
            active_ai_agent_id: conversa.active_ai_agent_id as string | null,
            versoesPublicadasNaSessao,
          }
        : null,
    );

    // Sem agente resolvido, o padrão do PRODUTO — nunca o limiar do vizinho.
    // Chutar a configuração de outro agente é o defeito de novo, agora com cara
    // de configuração deliberada.
    const agentConfig = (agent?.config as Record<string, unknown> | null) ?? {};
    const threshold =
      typeof agentConfig["sentiment_threshold"] === "number"
        ? agentConfig["sentiment_threshold"]
        : DEFAULT_SENTIMENT_THRESHOLD;

    const comum = {
      organization_id: event.organization_id,
      // `null`, não `""` (issue #160): o worker roda mesmo sem agente ativo — lê
      // o agente só para o threshold e cai no default —, e string vazia numa
      // coluna uuid fazia o insert de auditoria falhar em silêncio. O custo
      // existe; a linha precisa entrar.
      agent_id: agent?.id ?? null,
      conversation_id: conversationId ?? message.conversation_id ?? null,
      message_id: messageId,
      invocation_kind: "sentiment_classify",
    } satisfies Partial<LogInvocationInput>;

    // ── O Jev primeiro, quando ligado ──────────────────────────────────────
    //
    // Três desfechos, e o modo (`settings.jev.modo`) só pesa no primeiro:
    //  - mediu: em "decide" (ou sem IA de linguagem para comparar) a nota dele
    //    vale e o LLM nem roda; em "observacao" o LLM roda e decide, e as duas
    //    notas ficam em `messages.metadata` para o cartão medir a concordância
    //    (se o LLM falhar, a nota do Jev vale);
    //  - falhou na rede: a IA de sempre mede como reserva, e a linha dela diz
    //    isso (`reserva_do_jev`). Linha de erro do Jev só quando NINGUÉM mediu —
    //    uma falha que a reserva cobriu não é erro para quem opera;
    //  - não tentou (sem chave, disjuntor aberto): nada sai para a rede, e sem
    //    chave o caminho é exatamente o de antes do Jev.
    // Falha que não passa sozinha (chave recusada, sem crédito, pergunta nossa
    // recusada) abre aviso na Central, com ou sem reserva — DEPOIS de se saber
    // se a reserva mediu, porque é isso que o aviso afirma. O aviso se fecha
    // sozinho quando o Jev volta a medir.
    const clima: ClimaMedido | null = jev.ligado
      ? await medirClima({ organizationId: event.organization_id, mensagem: body })
      : null;

    if (clima?.ok) {
      await fecharAvisoDoJev(admin, event.organization_id);
    }
    /**
     * A linha da medição do Jev sai DEPOIS da decisão, com a origem do que
     * aconteceu: "jev" quando a nota dele decidiu, "jev_observacao" quando a IA
     * de sempre decidiu. Antes da decisão a linha não sabia — em observação com a
     * IA de sempre caída, é a nota do Jev que decide.
     */
    const registrarMedicaoDoJev = (decidiu: boolean): void => {
      if (!clima?.ok) return;
      logInvocation({
        ...comum,
        provider: "typesafe",
        model: `typesafe/${clima.modelo}`,
        origem_da_escolha: decidiu ? "jev" : "jev_observacao",
        prompt_tokens: clima.tokensDeEntrada,
        completion_tokens: clima.tokensDeSaida,
        latency_ms: clima.latenciaMs,
        // Fracionário, sem o `Math.ceil` de `computeCost`: a centavo por
        // chamada, o Jev custaria ~600x o preço real (D4). Versão sem preço na
        // tabela sai `null`, nunca o preço de outra.
        cost_cents: costCents(clima.modelo, {
          inputTokens: clima.tokensDeEntrada,
          outputTokens: clima.tokensDeSaida,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        finish_reason: null,
      });
    };

    const jevFalhouNaRede = clima !== null && !clima.ok && clima.tentouRede ? clima : null;
    /** `reservaMediu` é o que o corpo do aviso afirma — por isso só se sabe no fim. */
    const avisarSeExigeAcao = async (reservaMediu: boolean): Promise<void> => {
      if (!jevFalhouNaRede?.exigeAcao) return;
      await avisarNaCentral(admin, {
        organizationId: event.organization_id,
        idioma: normalizarIdioma(daOrg?.locale ?? null),
        motivo: jevFalhouNaRede.motivo,
        temReserva: reservaMediu,
      });
    };
    const registrarFalhaDoJev = (): void => {
      if (jevFalhouNaRede === null) return;
      logInvocation({
        ...comum,
        provider: "typesafe",
        model: `typesafe/${MODELO_DO_JEV}`,
        origem_da_escolha: "jev",
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: jevFalhouNaRede.latenciaMs,
        cost_cents: 0,
        finish_reason: "error",
        error_code: codigoDoErroDoJev(jevFalhouNaRede.motivo),
        error_payload: { motivo: jevFalhouNaRede.motivo },
      });
    };

    let decisao: { score: number; engine: MotorDoClima; latenciaMs: number };
    if (clima?.ok && (jev.modo === "decide" || resolvido === null)) {
      decisao = { score: clima.score01, engine: "jev", latenciaMs: clima.latenciaMs };
    } else if (resolvido === null) {
      registrarFalhaDoJev();
      if (jevFalhouNaRede) {
        await avisarSeExigeAcao(false);
        // Sem IA de linguagem, a falha que "passa sozinha" (fora do ar, lento,
        // ilegível) deixa o clima sem medição do mesmo jeito — e enquanto ela
        // não passa, ninguém sabe. Várias seguidas é queda, não tropeço: vira o
        // MESMO aviso (mesmo título, mesmo dedupe, fecha no próximo sucesso).
        if (
          !jevFalhouNaRede.exigeAcao &&
          falhasSeguidas(event.organization_id) >= FALHAS_SEGUIDAS_PARA_AVISAR_SEM_RESERVA
        ) {
          await avisarNaCentral(admin, {
            organizationId: event.organization_id,
            idioma: normalizarIdioma(daOrg?.locale ?? null),
            motivo: jevFalhouNaRede.motivo,
            temReserva: false,
            quedaSustentada: true,
          });
        }
        return { skipped: true, reason: "jev_falhou_sem_reserva" };
      }
      // O Jev está ligado aqui (desligado e sem IA de linguagem, o worker já saiu
      // lá em cima), então o motivo é o dele: `ai_gateway_key_missing` mandava
      // quem lê o log caçar uma chave que não falta quando o disjuntor só segura.
      return {
        skipped: true,
        reason: clima?.ok === false ? `jev_${clima.motivo}` : "ai_gateway_key_missing",
      };
    } else {
      // O Jev ligado, com chave, e sem resposta: quem mede é a reserva.
      const reserva = clima !== null && !clima.ok && clima.motivo !== "sem_credencial";
      const origem = reserva ? ({ origem_da_escolha: "reserva_do_jev" } as const) : {};
      const inicio = Date.now();
      let medido: Awaited<ReturnType<typeof classificarComLlm>> | null = null;
      let erroDaIa: unknown = null;
      try {
        medido = await classificarComLlm(resolvido.model, body);
      } catch (err) {
        erroDaIa = err;
        // A FALHA também vira linha em `llm_calls`. A 0128 fez isso para o seam do
        // agent-engine, e este worker não passa por lá — então, até aqui, escolher
        // no painel um modelo que não existe fazia toda classificação falhar sem
        // deixar rastro nenhum: a tela de Execuções, cuja razão de existir é
        // responder "por que falhou", não mostrava nada para este ponto, com o
        // painel dizendo que estava configurado.
        //
        // A linha de ERRO não leva `reserva_do_jev`: essa origem diz "a IA de
        // sempre mediu no lugar dele", e aqui ela não mediu. Quando o Jev já
        // tinha medido (observação), leva `jev_cobriu` — a tela não mostra a
        // consequência de um clima que foi medido.
        logInvocation({
          ...comum,
          ...(clima?.ok ? ({ origem_da_escolha: "jev_cobriu" } as const) : {}),
          model: resolvido.modelId,
          prompt_tokens: 0,
          completion_tokens: 0,
          latency_ms: Date.now() - inicio,
          cost_cents: 0,
          finish_reason: "error",
          error_payload: { message: err instanceof Error ? err.message : String(err) },
        });
      }
      if (medido !== null) {
        const latenciaMs = Date.now() - inicio;
        logInvocation({
          ...comum,
          ...origem,
          model: resolvido.modelId,
          prompt_tokens: medido.promptTokens,
          completion_tokens: medido.completionTokens,
          latency_ms: latenciaMs,
          cost_cents: await computeCost({
            model: resolvido.modelId,
            promptTokens: medido.promptTokens,
            completionTokens: medido.completionTokens,
          }),
          finish_reason: null,
        });
        decisao = { score: medido.score, engine: "llm", latenciaMs };
        await avisarSeExigeAcao(true);
      } else if (clima?.ok) {
        // Observação com a IA de sempre caída: o Jev já mediu, e a nota dele é a
        // única que existe. Descartá-la deixaria o cliente irritado passar sem
        // ninguém ser chamado, com a medição na mão.
        decisao = { score: clima.score01, engine: "jev", latenciaMs: clima.latenciaMs };
      } else {
        // Ninguém mediu. O `throw` mantém o desfecho de antes — quem decide o
        // retorno continua sendo o catch global, que nunca derruba o bot.
        registrarFalhaDoJev();
        await avisarSeExigeAcao(false);
        throw erroDaIa;
      }
    }

    registrarMedicaoDoJev(decisao.engine === "jev");

    // ── Merge sentiment into messages.metadata ────────────────────────────
    const existingMetadata = (message.metadata as Record<string, unknown> | null) ?? {};
    const updatedMetadata = {
      ...existingMetadata,
      [CHAVES_DO_CLIMA.nota]: decisao.score,
      sentiment_latency_ms: decisao.latenciaMs,
      [CHAVES_DO_CLIMA.motor]: decisao.engine,
      ...(clima?.ok
        ? { [CHAVES_DO_CLIMA.notaDoJev]: clima.score01, [CHAVES_DO_CLIMA.modeloDoJev]: clima.modelo }
        : {}),
    };

    const { error: updateErr } = await admin
      .from("messages")
      .update({ metadata: updatedMetadata })
      .eq("id", messageId)
      .eq("organization_id", event.organization_id);

    if (updateErr) {
      console.warn("[ai-sentiment-worker] metadata update failed", {
        message_id: messageId,
        error: updateErr.message,
      });
    }

    // ── Emit alert if below threshold ────────────────────────────────────
    if (decisao.score < threshold) {
      const { error: emitErr } = await admin.rpc(
        "emit_event" as never,
        {
          p_event_type: "ai.sentiment_alert",
          p_entity_kind: "message",
          p_entity_id: messageId,
          p_payload: {
            message_id: messageId,
            conversation_id: conversationId ?? message.conversation_id ?? null,
            [CHAVES_DO_CLIMA.nota]: decisao.score,
            // Qual motor mediu: a passagem para humano marca "(percebido pelo
            // Jev)" na linha do tempo da equipe (D11).
            [CHAVES_DO_CLIMA.motor]: decisao.engine,
          },
          // `agent_id` e `motivo` viajam com o alerta porque o limiar é o número
          // que decidiu emiti-lo: sem eles, "por que este alerta saiu?" recomeça
          // do zero, e foi essa ausência que deixou o defeito da #486 invisível
          // pela tela — os dois campos existiam e um não fazia nada.
          p_metadata: {
            source: "ai-sentiment-worker",
            threshold,
            agent_id: agent?.id ?? null,
            agente_resolvido_por: motivoDoAgente,
          },
          p_organization_id: event.organization_id,
        } as never,
      );

      if (emitErr) {
        console.warn("[ai-sentiment-worker] ai.sentiment_alert emit failed", {
          message_id: messageId,
          error: emitErr.message,
        });
      }
    }

    return { skipped: false, sentiment_score: decisao.score };
  } catch (err) {
    // Global catch: NEVER throw — must not break the bot path.
    console.warn("[ai-sentiment-worker] sentiment_classify_failed", {
      event_id: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { skipped: true, reason: "classify_failed" };
  }
}

async function classificarComLlm(
  model: LanguageModel,
  body: string,
): Promise<{ score: number; promptTokens: number; completionTokens: number }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const generated = await generateObject({
      model,
      schema: sentimentSchema,
      system: SENTIMENT_SYSTEM_PROMPT,
      prompt: body,
      temperature: 0,
      // 80 era pequeno demais e nunca tinha sido exercitado (o worker morria
      // antes, na autenticação). `generateObject` com Anthropic usa modo
      // FERRAMENTA: o JSON vai dentro de um tool_use, que custa bem mais que
      // texto puro. Medido com mensagens reais desta instalação: 2 de 3
      // paravam em `stop_reason: max_tokens` com o JSON cortado no meio —
      // daí o "No object generated: response did not match schema", que
      // parecia erro de esquema e era truncamento. Pico observado: 146 sem
      // as descrições, 84 com elas. 256 dá folga sem virar cheque em branco.
      maxOutputTokens: 256,
      abortSignal: abortController.signal,
    });
    const usage = generated.usage as
      | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
      | undefined;
    return {
      score: generated.object.sentiment_score,
      promptTokens: usage?.inputTokens ?? usage?.promptTokens ?? 0,
      completionTokens: usage?.outputTokens ?? usage?.completionTokens ?? 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Os títulos do aviso em todo idioma visível: o título é a chave do aviso, e ele
 * sai traduzido. Casar só o do idioma de agora abriria um segundo aviso igual
 * quando a organização trocasse de idioma, e deixaria o antigo sem fechar.
 */
const TITULOS_DO_AVISO_DO_JEV = [...new Set(IDIOMAS.map((i) => traduzir(AVISO_DO_JEV.titulo, i)))];

/**
 * Organizações em que ESTE processo já sabe que não há aviso do Jev aberto.
 * Sem esta memória, cada medição bem-sucedida faria uma escrita na Central.
 *
 * ponytail: memória por processo. O dreno do agent-worker e o do cron são dois
 * processos; quem abriu o aviso é quem o esqueceu daqui, então é ele que o
 * fecha no próximo sucesso. Se um processo reiniciar, a primeira medição
 * confere uma vez.
 */
const semAvisoDoJevAberto = new Set<string>();

/**
 * Quantas falhas seguidas, sem IA de linguagem, fazem de um tropeço uma queda.
 * O disjuntor abre na 3ª e deixa passar uma tentativa a cada 5 minutos, então a
 * 5ª chega depois de uns 10 minutos de clima sem medição — tempo de sobra para
 * não avisar por um soluço, e pouco para o dono não saber.
 */
const FALHAS_SEGUIDAS_PARA_AVISAR_SEM_RESERVA = 5;

/**
 * Aviso na Central para a falha do Jev que não passa sozinha.
 *
 * `kind='other'` sem referência, e o título fixo como chave — o mesmo desenho de
 * `lib/agent-engine/edge/llm/run-model-call.ts`: kind novo exigiria reconstruir
 * o CHECK de `agent_inbox_items.kind`, e o título fixo faz uma chave recusada
 * virar UM aviso, não um por mensagem do dia. Com um aviso já aberto, ele é
 * ATUALIZADO para o desfecho de agora (motivo, se a reserva mediu, gravidade):
 * sem isso, uma chave recusada coberta pela reserva seguia dizendo "a IA de
 * sempre mede no lugar dele" depois que a reserva também caiu. O texto sai no
 * idioma da organização porque a Central mostra o corpo como veio.
 *
 * ponytail: busca e escrita em duas idas, sem trava. Dois drains medindo a mesma
 * organização no mesmo instante podem abrir dois avisos iguais — a mesma corrida
 * que `abrirItemDeOrcamento` (ai-response-worker) declara. Aviso repetido é
 * ruído; ausente seria o clima parado sem nada na tela. Fecha de vez só com
 * índice único parcial (org, título) em `kind='other' and status='open'`, que é
 * migration e exige antes deduplicar os avisos abertos de todo clone.
 *
 * Nunca lança: o aviso é o alerta, não a medição.
 */
async function avisarNaCentral(
  admin: ReturnType<typeof createAdminClient>,
  a: {
    organizationId: string;
    idioma: Idioma;
    motivo: MotivoComRede;
    temReserva: boolean;
    quedaSustentada?: boolean;
  },
): Promise<void> {
  semAvisoDoJevAberto.delete(a.organizationId);
  const { title, body } = avisoDoJevNaCentral(
    a.motivo,
    a.temReserva,
    (t) => traduzir(t, a.idioma),
    a.quedaSustentada,
  );
  // Sem reserva, o clima parou de vez: ninguém é chamado quando o cliente se irrita.
  const severity = a.temReserva ? "warn" : "critical";
  const { data: abertos, error: erroDaBusca } = await admin
    .from("agent_inbox_items")
    .select("id, title, body, severity")
    .eq("organization_id", a.organizationId)
    .eq("kind", "other")
    .in("title", TITULOS_DO_AVISO_DO_JEV)
    .eq("status", "open")
    .limit(1);
  if (erroDaBusca) {
    console.warn("[ai-sentiment-worker] busca do aviso do Jev falhou — aviso não aberto", {
      organization_id: a.organizationId,
      error: erroDaBusca.message,
    });
    return;
  }

  const aberto = (abertos ?? [])[0] as { id: string; title: string; body: string; severity: string } | undefined;
  if (aberto && aberto.title === title && aberto.body === body && aberto.severity === severity) return;
  const { error } = aberto
    ? await admin
        .from("agent_inbox_items")
        .update({ title, body, severity })
        .eq("id", aberto.id)
        .eq("organization_id", a.organizationId)
    : await admin.from("agent_inbox_items").insert({
        organization_id: a.organizationId,
        kind: "other",
        severity,
        title,
        body,
      });
  if (error) {
    console.warn("[ai-sentiment-worker] aviso do Jev na Central não foi gravado", {
      organization_id: a.organizationId,
      error: error.message,
    });
  }
}

/**
 * O Jev voltou a medir: o aviso aberto deixa de ser verdade e se fecha. Sem
 * isto, depois de trocar a chave ou pôr crédito, a Central seguia dizendo "O Jev
 * parou de medir" até alguém fechá-la à mão.
 *
 * Nunca lança, e só escreve na primeira medição depois de um aviso (ver
 * `semAvisoDoJevAberto`).
 */
async function fecharAvisoDoJev(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<void> {
  if (semAvisoDoJevAberto.has(organizationId)) return;
  const { error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("kind", "other")
    .in("title", TITULOS_DO_AVISO_DO_JEV)
    .eq("status", "open");
  if (error) {
    console.warn("[ai-sentiment-worker] aviso do Jev não foi fechado", {
      organization_id: organizationId,
      error: error.message,
    });
    return;
  }
  semAvisoDoJevAberto.add(organizationId);
}

import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/agents/:id/versions/:vid/test (admin)
 *
 * Spec 10 §4.4. Cria ai_agent_runs com is_dry_run=true e executa o runtime
 * real. ⚠️ Não é mais `callInternalRuntime` → `runAgent`, como esta linha
 * afirmou por vários releases: aquele runtime (`lib/ai/runtime`) está aposentado
 * desde a Fase 0 — o cron `agent-dispatcher` responde `deprecated: true`. Quem
 * roda hoje é `testAgentVersion` (`lib/agent-engine/agent/sandbox.ts`), o mesmo
 * motor do turno de WhatsApp, em modo prévia. Para conferir sem acreditar nesta
 * linha, leia a chamada mais abaixo.
 *
 * ⚠️ Esta rota é o ÚNICO escritor vivo de `ai_agent_runs`. O caminho normal
 * (WhatsApp) não abre linha nenhuma ali — ele registra em `llm_calls`. Quem
 * procurar o turno real nesta tabela não acha, e não é defeito desta rota.
 *
 * INTERNAL_AGENT_RUN_STUB=true troca a execução por um trace fabricado —
 * serve para exercitar o render da UI sem gastar token, e NÃO é o default:
 * numa instalação nova, "Testar agente" tem que testar o agente.
 *
 * Crítico: dry_run=true → bypass do partial unique
 *   ai_agent_runs_one_running_per_conv (que filtra is_dry_run=false), por
 *   isso múltiplos tests simultâneos pra mesma conversation não conflitam.
 *
 * Sample contact é apenas pra contexto do prompt — nunca toca contacts/conversations
 * tables, nunca chama WAHA, nunca cria messages.outbound.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { testRunSchema, LIMITE_DO_HISTORICO_EM_MENSAGENS, LIMITE_DO_HISTORICO_EM_CARACTERES } from "@/lib/ai/agents/validation";
import { avaliarRespostaDeTeste } from "@/lib/ai/agents/avaliar-resposta-de-teste";
import { ehFalhaDoBanco } from "@/lib/ai/agents/falha-do-banco";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { codigo } from "@/lib/agent-engine/agent/recibo-do-traco";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { LlmConteudoBloqueadoError } from "@/lib/agent-engine/edge/llm/conteudo-bloqueado";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A frase que a tela diz quando a falha é do PROVEDOR (chave recusada, modelo
 * fora de `enabled_models`, cota, endereço próprio sem chave) — ou quando não
 * dá para provar de onde veio. É a frase de antes do #4020, e ela continua
 * certa para esse caso: o que estava errado era usá-la para tudo.
 */
const MENSAGEM_GENERICA =
  "Não foi possível executar o teste. Confira modelo, credencial e materiais do agente.";

/**
 * Código de wire da falha de banco. Declarado em `lib/api/errors.ts`: `fail()`
 * aceita qualquer string, então só é contrato se estiver na lista.
 */
const MENSAGEM_BANCO_CODIGO = "preview_banco_indisponivel";

/**
 * A frase para quando o banco não atendeu. Ela precisa NEGAR a orientação da
 * genérica ("não é modelo nem credencial"), senão quem lê refaz o que já fez —
 * foi exatamente esse o atrito do #4020 — e apontar onde está o erro cru, que
 * continua sendo o log do app (mesmo marcador de sempre).
 */
const MENSAGEM_BANCO =
  "Não foi possível executar o teste: o banco de dados não respondeu (indisponibilidade ou tempo esgotado). Modelo e credencial do agente não têm relação com esta falha — tente de novo em instantes. O motivo exato fica no log do app, em [ai.test].";

type Ctx = { params: Promise<{ id: string; vid: string }> };

/**
 * Fecha a linha do run — e RECLAMA se não conseguir.
 *
 * O INSERT desta rota sempre checou o erro; os dois UPDATEs não checavam
 * nenhum, e foi por isso que um status fora do CHECK pôde ficar dois releases
 * no código sem ninguém ver. Falhar aqui não derruba o teste (o resultado já
 * está pronto e vai para a tela de qualquer jeito), mas tem que deixar rastro:
 * um update de fechamento que não fecha é exatamente o defeito que se quer
 * enxergar.
 */
async function atualizarRun(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  runId: string,
  requestId: string,
  campos: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("ai_agent_runs")
    .update(campos)
    .eq("organization_id", organizationId)
    .eq("id", runId);
  if (error) {
    logger.error("[ai.test] não foi possível fechar a linha do teste", {
      request_id: requestId,
      run_id: runId,
      organization_id: organizationId,
      status_pretendido: campos.status,
      error: error.message,
    });
  }
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, vid } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(vid)) {
    return fail("invalid_request", "ids inválidos.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "ai_agents_test", requestId);
  if (teto) return teto;
  const authUserId = actor.type === "user" ? actor.id : null;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  /**
   * #4424 — o histórico do teste é recusado ANTES de qualquer trabalho, com uma
   * frase legível e 400 (o corpo está semanticamente errado, não malformado em
   * um campo). Os limites são os mesmos que o schema e o painel usam: sem eles,
   * cada turno reenviaria a conversa inteira e o custo do teste cresceria sem
   * teto. `sample_message` não entra na conta — history é só o PASSADO.
   */
  const historicoPedido = (raw as { history?: unknown } | null)?.history;
  if (Array.isArray(historicoPedido)) {
    const caracteres = historicoPedido.reduce<number>((total, m) => {
      const corpo =
        m && typeof m === "object" && "body" in m && typeof m.body === "string"
          ? m.body.trim().length
          : 0;
      return total + corpo;
    }, 0);
    if (
      historicoPedido.length > LIMITE_DO_HISTORICO_EM_MENSAGENS ||
      caracteres > LIMITE_DO_HISTORICO_EM_CARACTERES
    ) {
      return fail(
        "invalid_request",
        t(
          "O histórico da conversa passou do limite: até 30 mensagens e 20.000 caracteres. Recomece a conversa para seguir.",
        ),
        400,
        { requestId },
      );
    }
  }
  const parsed = testRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // #2237 — esta rota só precisa saber que a versão existe (na org e no
  // agente certos) e qual é o canal dela. A config que o Testar usa — prompt,
  // modelo, ferramentas, `knowledge_source_ids` — o runtime do preview
  // RECARREGA por versionId (`loadAgentVersionConfig` → `agent-config.ts`).
  // A lista de 11 colunas que morava aqui era uma cópia que ninguém lia e que
  // envelheceu sozinha (faltava `knowledge_source_ids`); ler só o que se usa
  // não deixa cópia para envelhecer. O teste da rota cobra isso.
  const { data: version } = await admin
    .from("ai_agent_versions")
    .select(
      "id, channel_session_id",
    )
    .eq("id", vid)
    .eq("organization_id", organizationId)
    .eq("agent_id", id)
    .maybeSingle();

  if (!version) return fail("not_found", t("Version não encontrada."), 404, { requestId });

  const startedAt = new Date();

  const { data: runRow, error: runErr } = await admin
    .from("ai_agent_runs")
    .insert({
      organization_id: organizationId,
      agent_id: id,
      agent_version_id: vid,
      conversation_id: null,
      contact_id: null,
      channel_session_id: version.channel_session_id,
      inbound_message_id: null,
      outbound_message_id: null,
      status: "running",
      is_dry_run: true,
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return fail("internal_error", "Erro ao iniciar test run.", 500, { requestId });
  }

  let resultPayload: Record<string, unknown>;

  try {
    const result = await testAgentVersion(getRequestPool(), requestTurnDeps(), {
      organizationId: organizationId,
      agentId: id,
      versionId: vid,
      runId: runRow.id,
      sampleMessage: parsed.data.sample_message,
      history: parsed.data.history,
      sampleContact: parsed.data.sample_contact,
      sampleTags: parsed.data.sample_tags,
      channelId: version.channel_session_id,
    });
    const finalText = result.candidates.map((c) => c.body).join("\n\n");
    // #2490 — mídia pendente é teste REPROVADO, mesmo com candidato na mão: o
    // `send_message` que falhou a foto devolveu erro ao modelo, e aprovar a tela
    // com aquela resposta seria exatamente o "passou sem preparar" da issue.
    const midiaPendente =
      result.midia.some((m) => m.falha !== undefined) ||
      // #4129 — o material da empresa entra na MESMA régua: dry-run com arquivo
      // não preparado é teste reprovado, nunca "aprovado com pendência".
      result.materiais.some((m) => m.falha !== undefined);
    resultPayload = {
      run_id: runRow.id,
      status: result.candidates.length && !midiaPendente ? "ok" : "blocked",
      latency_ms: Date.now() - startedAt.getTime(),
      final_text: finalText,
      tool_calls: result.proposals,
      ...result,
      // #4424 — o `erro` de cada ferramenta é texto livre do coletor; a tela
      // recebe o mesmo vocabulário fechado do leitor do traço (`codigo()`).
      ferramentas: (result.ferramentas ?? []).map((f) => ({ ...f, erro: codigo(f.erro) })),
      stub: process.env.INTERNAL_AGENT_RUN_STUB === "true",
      guardrails: avaliarRespostaDeTeste(finalText, result.midia),
    };
    // ⚠️ `completed`, não `"ok"`. O CHECK da coluna aceita
    // pending|running|completed|failed|aborted|handoff — `"ok"` é o vocabulário
    // de `llm_calls`, que é outra tabela. Enquanto esteve `"ok"` aqui, TODO
    // update era rejeitado pelo Postgres com 23514 e o erro era descartado (o
    // `await` não olhava `error`, ao contrário do INSERT logo acima): a linha
    // nascia `running` e morria `running`, em toda instalação, para sempre.
    // Medido numa VPS v1.20.0: 16 execuções, 16 linhas em `running`.
    await atualizarRun(admin, organizationId, runRow.id, requestId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt.getTime(),
      // `steps_count`, `tokens_in`, `tokens_out` e `cost_cents` seguem em zero
      // de propósito: o turno de prévia não devolve essas contagens à rota, e
      // gravar `candidates.length` no lugar de passos seria um número errado com
      // cara de certo. Quem tem o dado é `llm_calls` (`purpose='agent_preview'`),
      // e ligar as duas é trabalho à parte — não se conserta um zero honesto com
      // um palpite.
      tool_calls: JSON.parse(JSON.stringify(result.proposals)),
    });
  } catch (err) {
    // ⚠️ Este `catch` era vazio, e engolir o erro aqui é o que tornava o
    // problema INDIAGNOSTICÁVEL: o teste falhava, a tela dizia uma frase
    // genérica sobre modelo e credencial, e a causa real não existia em lugar
    // nenhum — nem no log, nem na linha do run, nem na resposta.
    //
    // #4020 — e a frase genérica não podia ser a resposta para TUDO. Ela manda
    // conferir modelo, credencial e materiais, e é a orientação certa quando a
    // falha é do provedor; quando o banco não responde (`Query read timeout`),
    // ela manda a pessoa reinstalar uma credencial que está boa. Duas
    // instalações fizeram exatamente isso. O erro cru continua indo para o log
    // e para a linha do run (quem depura precisa dele); o que muda é a
    // TRADUÇÃO para a tela, e ela só afirma "banco" com prova.
    const mensagem = err instanceof Error ? err.message : String(err);
    logger.error("[ai.test] o teste do agente falhou", {
      request_id: requestId,
      run_id: runRow.id,
      agent_id: id,
      version_id: vid,
      organization_id: organizationId,
      error: mensagem,
    });
    const falhaDoBanco = ehFalhaDoBanco(err);
    await atualizarRun(admin, organizationId, runRow.id, requestId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt.getTime(),
      // O código guardado diz a NATUREZA da falha para quem for diagnosticar
      // depois; antes era sempre `preview_failed`, o que fazia um timeout de
      // banco parecer problema de configuração de agente também na tabela.
      error_code: falhaDoBanco ? "preview_banco_indisponivel" : "preview_failed",
      // Guardado na linha para quem for diagnosticar depois. A tela NUNCA lê
      // este texto: ela recebe a frase da causa (a de banco ou a genérica),
      // porque `message` de driver pode carregar host, usuário e SQL.
      error_message: mensagem.slice(0, 2000),
    });
    if (err instanceof LlmConteudoBloqueadoError) {
      // Recusa nossa, com texto próprio e sem detalhe interno — não é caso de
      // banco nem de credencial, e a frase já é a explicação.
      return fail("preview_failed", err.message, 422, { requestId });
    }
    if (falhaDoBanco) {
      // 502, não 422: não há nada para a pessoa corrigir na configuração do
      // agente — a dependência é que não atendeu. E 502, não 503:
      // `lib/api/client.ts` repete sozinho todo POST que recebe 503
      // (RETRYABLE_STATUSES), e esta rota não é idempotente — cada repetição
      // cria um run e roda o turno inteiro, inclusive o modelo pago (#783).
      // 502 é o mesmo "a dependência não respondeu" de `channel_unavailable`
      // e `wacalls_error`, e o cliente não o repete.
      return fail(MENSAGEM_BANCO_CODIGO, t(MENSAGEM_BANCO), 502, { requestId });
    }
    return fail("preview_failed", t(MENSAGEM_GENERICA), 422, { requestId });
  }

  void audit({
    action: "ai_agent.tested",
    actorUserId: authUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: organizationId,
    resourceType: "ai_agent_version",
    resourceId: vid,
    requestId,
    metadata: { run_id: runRow.id, dry_run: true },
  });

  return ok(resultPayload, { requestId });
}

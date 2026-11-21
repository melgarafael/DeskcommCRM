/**
 * O "Testar" do agente — uma execução de PRÉVIA da versão, sem cliente real.
 *
 * Saiu de `app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts` para ser a
 * mesma execução pela tela (a rota) e pelo MCP do CRM (`crm_test_ai_agent_version`,
 * o dono testando pelo ChatGPT o rascunho que acabou de corrigir). Nada mudou
 * no caminho: abre a linha de `ai_agent_runs` com `is_dry_run = true`, roda
 * `testAgentVersion` (o motor do turno de WhatsApp, em modo prévia — não chama
 * o provedor do canal, não cria mensagem, não toca contato nem conversa), fecha a linha e
 * audita `ai_agent.tested`.
 *
 * Devolve o resultado em vez de uma `Response`: quem chama traduz para o
 * próprio protocolo (envelope da API REST ou resultado da ferramenta MCP).
 * `traduzivel` diz se a mensagem é uma frase nossa (passa por `traduzir`) ou
 * um texto já pronto (a recusa de conteúdo do provedor).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import { audit } from "@/lib/audit";
import { perguntaDoTeste, respostaDoTeste } from "@/lib/ai/agents/texto-do-teste";
import { avaliarRespostaDeTeste } from "@/lib/ai/agents/avaliar-resposta-de-teste";
import { ehFalhaDoBanco } from "@/lib/ai/agents/falha-do-banco";
import type { testRunSchema } from "@/lib/ai/agents/validation";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { somarCustoDoRunDePrevia } from "@/lib/ai/agents/custo-do-run-de-previa";
import { codigo } from "@/lib/agent-engine/agent/recibo-do-traco";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";
import { LlmConteudoBloqueadoError } from "@/lib/agent-engine/edge/llm/conteudo-bloqueado";

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
export const MENSAGEM_BANCO_CODIGO = "preview_banco_indisponivel";

/**
 * A frase para quando o banco não atendeu. Ela precisa NEGAR a orientação da
 * genérica ("não é modelo nem credencial"), senão quem lê refaz o que já fez —
 * foi exatamente esse o atrito do #4020 — e apontar onde está o erro cru, que
 * continua sendo o log do app (mesmo marcador de sempre).
 */
const MENSAGEM_BANCO =
  "Não foi possível executar o teste: o banco de dados não respondeu (indisponibilidade ou tempo esgotado). Modelo e credencial do agente não têm relação com esta falha — tente de novo em instantes. O motivo exato fica no log do app, em [ai.test].";

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
  admin: SupabaseClient,
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

/**
 * O custo do teste, medido onde ele existe (#4664).
 *
 * A linha do run nascia e morria com `tokens_in`, `tokens_out` e `cost_cents` no
 * padrão 0 enquanto as chamadas de modelo do teste — que custaram dinheiro de
 * verdade — ficavam em `llm_calls`. Fechar a linha com zero era uma afirmação
 * falsa: "este teste não gastou nada". O custo por chamada está lá, com o elo
 * `preview_run_id` apontando para ESTE run (`somarCustoDoRunDePrevia`).
 *
 * Nunca derruba o teste: o resultado já está pronto e vai para a tela. Se a
 * leitura falhar, os campos NÃO entram no update (as colunas ficam no padrão,
 * como antes) e o motivo vai para o log — gravar 0 seria repetir o defeito com
 * outra roupa, e gravar um número pela janela de tempo misturaria dois testes
 * simultâneos.
 */
async function camposDoCustoDoTeste(
  pool: ReturnType<typeof getRequestPool>,
  organizationId: string,
  runId: string,
  requestId: string,
): Promise<Record<string, number>> {
  const soma = await somarCustoDoRunDePrevia(pool, organizationId, runId);
  if (!soma) {
    logger.warn("[ai.test] custo do teste não somado (a linha fecha sem tokens e custo)", {
      request_id: requestId,
      run_id: runId,
      organization_id: organizationId,
    });
    return {};
  }
  return {
    tokens_in: soma.tokens_in,
    tokens_out: soma.tokens_out,
    cost_cents: soma.cost_cents,
  };
}

export type PedidoDeTeste = z.output<typeof testRunSchema>;

export type ResultadoDoTeste =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; codigo: string; mensagem: string; traduzivel: boolean; status: number };

export async function testarVersaoDoAgente(
  admin: SupabaseClient,
  args: {
    orgId: string;
    agentId: string;
    versionId: string;
    pedido: PedidoDeTeste;
    ator: { userId: string | null; apiTokenId: string | null; requestId: string };
  },
): Promise<ResultadoDoTeste> {
  const organizationId = args.orgId;
  const id = args.agentId;
  const vid = args.versionId;
  const pedido = args.pedido;
  const requestId = args.ator.requestId;

  // #2237 — esta execução só precisa saber que a versão existe (na org e no
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

  if (!version) return { ok: false, codigo: "not_found", mensagem: "Version não encontrada.", traduzivel: true, status: 404 };

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
      // #4426: a PERGUNTA entra no nascimento da linha. É o que a aba
      // "Execuções" não tinha: o custo do teste ficava registrado e o que se
      // perguntou sumia com o próximo teste (`setResult(null)` no painel).
      // A resposta vem no fechamento, logo abaixo — e se o turno falhar, esta
      // metade fica: a pergunta que quebrou o teste é justamente a que se quer
      // reler.
      input_text: perguntaDoTeste(pedido.sample_message),
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return { ok: false, codigo: "internal_error", mensagem: "Erro ao iniciar test run.", traduzivel: false, status: 500 };
  }

  let resultPayload: Record<string, unknown>;

  try {
    const result = await testAgentVersion(getRequestPool(), requestTurnDeps(), {
      organizationId: organizationId,
      agentId: id,
      versionId: vid,
      runId: runRow.id,
      sampleMessage: pedido.sample_message,
      history: pedido.history,
      sampleContact: pedido.sample_contact,
      sampleTags: pedido.sample_tags,
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
      // #4664: o custo REAL do teste, somado das chamadas que apontam para ESTE
      // run (`llm_calls.preview_run_id`). Antes estas três colunas ficavam no
      // padrão 0 e a linha dizia que o teste não gastou nada; o dinheiro estava
      // a uma tabela de distância, sem nada ligando as duas pontas.
      ...(await camposDoCustoDoTeste(
        getRequestPool(),
        organizationId,
        runRow.id,
        requestId,
      )),
      // #4426: a RESPOSTA final, o MESMO texto que o painel mostrou ao vivo.
      // Antes ela só existia no corpo da resposta HTTP: quem abrisse a linha
      // depois via tokens, custo e "Sem trace disponível." — o histórico
      // guardava o preço do teste e não o que ele respondeu.
      output_text: respostaDoTeste(finalText),
      // `steps_count` segue em zero de propósito: o turno de prévia não devolve
      // a contagem de passos à rota, e gravar `candidates.length` no lugar seria
      // um número errado com cara de certo.
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
      // #4664: o teste que FALHOU também gastou — a recusa do provedor é
      // cobrada, e é justamente a linha que alguém vai abrir para entender o que
      // aconteceu. Somar só no caminho feliz deixaria o custo do fracasso em 0.
      ...(await camposDoCustoDoTeste(
        getRequestPool(),
        organizationId,
        runRow.id,
        requestId,
      )),
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
      return { ok: false, codigo: "preview_failed", mensagem: err.message, traduzivel: false, status: 422 };
    }
    if (falhaDoBanco) {
      // 502, não 422: não há nada para a pessoa corrigir na configuração do
      // agente — a dependência é que não atendeu. E 502, não 503:
      // `lib/api/client.ts` repete sozinho todo POST que recebe 503
      // (RETRYABLE_STATUSES), e esta rota não é idempotente — cada repetição
      // cria um run e roda o turno inteiro, inclusive o modelo pago (#783).
      // 502 é o mesmo "a dependência não respondeu" de `channel_unavailable`
      // e `wacalls_error`, e o cliente não o repete.
      return { ok: false, codigo: MENSAGEM_BANCO_CODIGO, mensagem: MENSAGEM_BANCO, traduzivel: true, status: 502 };
    }
    return { ok: false, codigo: "preview_failed", mensagem: MENSAGEM_GENERICA, traduzivel: true, status: 422 };
  }

  void audit({
    action: "ai_agent.tested",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: organizationId,
    resourceType: "ai_agent_version",
    resourceId: vid,
    requestId,
    metadata: { run_id: runRow.id, dry_run: true },
  });

  return { ok: true, data: resultPayload };
}

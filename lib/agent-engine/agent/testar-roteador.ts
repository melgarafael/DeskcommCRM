/**
 * TESTAR UM ROTEADOR — a regra, fora do route handler.
 *
 * ─── Por que este módulo existe ──────────────────────────────────────────────
 *
 * Esta regra nasceu inteira dentro de
 * `app/api/v1/ai/routers/[id]/test/route.ts`. Quem não é a rota — o servidor
 * MCP, uma automação, qualquer consumidor futuro dentro do processo — só tinha
 * dois caminhos ruins: chamar a própria API por HTTP, ou copiar a regra (e ela
 * envelhece calada na cópia). Aqui ela mora uma vez só, do mesmo jeito que
 * `listaTiposDeAtendimento` (`lib/agenda/consulta.ts`) já faz no `GET` de
 * `agenda/tipos`.
 *
 * ─── O QUE NÃO MUDA (e é o contrato) ─────────────────────────────────────────
 *
 * - As consultas são as mesmas, na mesma ordem. A leitura de `ai_routers` filtra
 *   `organization_id`: roteador de outra organização é 404, nunca o dado.
 * - NUNCA grava em `ai_router_decisions` (telemetria de decisão real, não de
 *   teste) nem em `conversations`. `leadId`/`jobId` vão null para o
 *   classificador: não existe contato/job real atrás de um clique de teste, e
 *   `llm_calls.contact_id`/`job_id` são FKs — um uuid inventado quebraria o
 *   insert do registro de custo.
 * - O custo continua indo para `llm_calls` como hoje, quando o classificador é
 *   consultado.
 * - O payload de saída é o mesmo: `ia_consultada`, `modo_roteador`,
 *   `intent_name`, `confidence`, `min_confidence`, `agent_id`, `agent_name`,
 *   `jev` — com o `?? null` (nunca `?? 0`) da confiança.
 *
 * ─── A borda fica na rota ────────────────────────────────────────────────────
 *
 * `requireSupportWrite`, `resolveAuthDual`, `tetoDeEscritaDoToken`, o uuid do
 * path, o Zod do corpo e a montagem de `ok()`/`fail()` com o `requestId`. Esta
 * função não vê `NextRequest` nem devolve `Response`: devolve resultado
 * discriminado.
 *
 * `deps.t` é o tradutor da borda (o mesmo `traduzir(texto, authz.idioma)`).
 * Ele entra como dependência porque as mensagens daqui são literais de
 * dicionário e o idioma é resolvido na rota; sem ele, o padrão é identidade —
 * pt-BR, que é o texto escrito abaixo.
 */
import type { Pool } from "pg";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  classifyIntent,
  type IntentVerdict,
} from "@/lib/agent-engine/agent/intent-classifier";
import {
  destinoDoVeredito,
  vereditoConfiavelDoRoteador,
} from "@/lib/agent-engine/agent/resolve-turn-agent";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { temIaDeSempre } from "@/lib/agent-engine/edge/llm/credentials";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { consultarJevNoRoteador, registrarRoteadorDoJev } from "@/lib/ai/decisao/roteador";

/** O payload de hoje, campo por campo. É contrato de API: não invente nem renomeie. */
export type ResultadoDoTesteDoRoteador = {
  ia_consultada: boolean;
  modo_roteador: string;
  intent_name: string | null;
  confidence: number | null;
  min_confidence: number;
  agent_id: string | null;
  agent_name: string | null;
  jev: {
    estado: string;
    respondeu: boolean;
    intent_name: string | null;
    confidence: number | null;
    agent_id: string | null;
    agent_name: string | null;
    decide: boolean;
  } | null;
};

export type DependenciasDoTesteDoRoteador = {
  /** O MESMO cliente de serviço que a rota já usa (`createAdminClient()`). */
  admin: SupabaseClient;
  pool: Pool;
  llmCfg: LlmEdgeConfig;
  log: Logger;
  /** O tradutor da borda. Ausente = identidade (pt-BR). */
  t?: (texto: string) => string;
};

export type EntradaDoTesteDoRoteador = {
  organizationId: string;
  routerId: string;
  mensagem: string;
};

export type RecusaDoTesteDoRoteador = {
  ok: false;
  code: "internal_error" | "not_found" | "state_conflict";
  status: 404 | 409 | 500;
  message: string;
};

export async function testarRoteador(
  deps: DependenciasDoTesteDoRoteador,
  entrada: EntradaDoTesteDoRoteador,
): Promise<{ ok: true; data: ResultadoDoTesteDoRoteador } | RecusaDoTesteDoRoteador> {
  const t = deps.t ?? ((texto: string) => texto);
  const { admin, pool, llmCfg, log } = deps;
  const { organizationId, routerId, mensagem } = entrada;

  const { data: router, error: routerErr } = await admin
    .from("ai_routers")
    .select("id, channel_session_id")
    .eq("id", routerId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (routerErr) {
    // Sem `t()` de propósito: é o texto de hoje, e ele NÃO passava pelo
    // dicionário antes desta extração. Trocar isso mudaria a resposta para
    // quem opera em espanhol — e o pedido é não mudar comportamento.
    return { ok: false, code: "internal_error", status: 500, message: "Erro ao carregar router." };
  }
  if (!router) {
    return { ok: false, code: "not_found", status: 404, message: t("Router não encontrado.") };
  }

  const loaded = await loadActiveRouter(pool, organizationId, router.channel_session_id);
  if (!loaded || loaded.id !== routerId) {
    return {
      ok: false,
      code: "state_conflict",
      status: 409,
      message: t("O router precisa estar ativo (is_active=true) para ser testado."),
    };
  }

  if (Array.isArray(loaded.senderRoutes) && loaded.senderRoutes.length > 0) {
    // Também sem `t()`: mensagem interpolada na origem, nunca passou pelo
    // dicionário. Fica como está (contrato do pedido).
    return {
      ok: false,
      code: "state_conflict",
      status: 409,
      message:
        "Este roteador escolhe pelo remetente. Teste enviando do número autorizado pelo WhatsApp; uma frase digitada aqui não informa a origem.",
    };
  }

  const jev = consultarJevNoRoteador(pool, {
    organizationId,
    mensagem,
    membros: loaded.members,
    contactId: null,
    jobId: null,
  });
  const [modo, estadoDoJev] = await Promise.all([
    jev.modo ?? Promise.resolve("comparacao"),
    jev.estado,
  ]);
  // A mesma regra do turno (decisão B, doc 89): sem a IA de sempre, o Jev não
  // decide sozinho nem na prévia — vale a comparação, e a R2.
  const independente =
    modo === "sob_demanda" &&
    estadoDoJev === "decidindo" &&
    (await temIaDeSempre(pool, llmCfg, organizationId, loaded.classifierProvider));
  const classificar = () =>
    classifyIntent(
      pool,
      llmCfg,
      {
        tenantId: organizationId,
        leadId: null,
        jobId: null,
        router: loaded,
        signal: mensagem,
      },
      { log },
    );
  // Na comparação, as duas consultas seguem em paralelo. Na decisão independente,
  // a mesma régua do turno real determina se a reserva precisa ser chamada.
  const comparacao = independente ? null : classificar();
  const escolhaDoJev = await jev.escolha;
  const jevConfiavel = vereditoConfiavelDoRoteador(loaded, escolhaDoJev?.veredito ?? null);
  const iaConsultada = !independente || !jevConfiavel;
  const verdict = comparacao !== null ? await comparacao : iaConsultada ? await classificar() : null;
  if (escolhaDoJev !== null) {
    await registrarRoteadorDoJev(pool, {
      organizationId,
      contactId: null,
      jobId: null,
      jev: escolhaDoJev,
      decidiu: false,
      observacao: null,
    });
  }

  // Sem veredito, ou abaixo do mínimo, produção cai no fallback/genérico — e o
  // painel de teste não pode fingir que casou (review whole-branch item 3).
  const agenteDo = (v: IntentVerdict | null): string | null =>
    destinoDoVeredito(loaded, undefined, null, v).membro?.agentId ?? loaded.fallbackAgentId;
  const nomeDoAgente = async (agentId: string | null): Promise<string | null> => {
    if (!agentId) return null;
    const { data: agentRow } = await admin
      .from("ai_agents")
      .select("name")
      .eq("id", agentId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    return agentRow?.name ?? null;
  };

  // A saída ilegível segue "nenhuma" para o agente (a régua do turno), mas não
  // é resposta da IA: a tela a mostra como "não respondeu", e o Jev decidindo
  // não vale no lugar dela (R2).
  const iaRespondeu = verdict !== null && verdict.falhou !== true;
  const agentId = agenteDo(verdict);
  const agentName = await nomeDoAgente(agentId);
  const agenteDoJev = escolhaDoJev === null ? null : agenteDo(escolhaDoJev.veredito);

  return {
    ok: true,
    data: {
      ia_consultada: iaConsultada,
      modo_roteador: modo,
      intent_name: iaRespondeu ? verdict.intentName : null,
      // `?? null`, nunca `?? 0`: sem veredito não houve medição, e zero é uma
      // AFIRMAÇÃO ("o classificador tem certeza de que não é nada"). A tela local
      // escapa por checar `intent_name` antes de exibir, mas isto é contrato de
      // API pública — todo outro consumidor leria a invenção. Doutrina em
      // `lib/kanban/card-state.ts`: null é "sinal insuficiente", 0 é "calculei e deu zero".
      confidence: iaRespondeu ? verdict.confidence : null,
      min_confidence: loaded.minConfidence,
      agent_id: agentId,
      agent_name: agentName,
      // `null` com a tarefa do roteador do Jev desligada (ou o Jev inteiro).
      jev:
        estadoDoJev === "desligada"
          ? null
          : {
              estado: estadoDoJev,
              respondeu: escolhaDoJev !== null,
              intent_name: escolhaDoJev?.veredito.intentName ?? null,
              // A probabilidade calibrada da escolha — sobre ela vale o `min_confidence`.
              confidence: escolhaDoJev?.veredito.confidence ?? null,
              agent_id: agenteDoJev,
              agent_name: agenteDoJev === agentId ? agentName : await nomeDoAgente(agenteDoJev),
              // Em produção vale a escolha dele: decidindo, respondendo, e com a
              // IA de sempre respondendo também (R2).
              decide: independente
                ? jevConfiavel
                : estadoDoJev === "decidindo" && escolhaDoJev !== null && iaRespondeu,
            },
    },
  };
}

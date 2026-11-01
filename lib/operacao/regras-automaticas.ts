/**
 * As REGRAS AUTOMÁTICAS — o que o sistema faz sozinho quando algo acontece
 * (`automation_rules` + `automation_rule_runs`).
 *
 * ⚠️ ESTA É A PEÇA MAIS PERIGOSA QUE O AGENTE ALCANÇA, e a razão é o tempo:
 * uma regra ligada dispara em todo evento que casar, para sempre, sem ninguém
 * assistindo. Ligar uma regra de `call_webhook` manda dado da empresa para fora
 * a cada lead novo; ligar uma de `send_whatsapp_message` fala com clientes de
 * verdade. Nenhuma dessas duas coisas volta atrás. Por isso a capacidade de
 * ligar/desligar é `critico` no catálogo — nunca entra por pacote.
 *
 * ⚠️ O QUE O AGENTE **NÃO** PODE FAZER, e é decisão, não omissão: criar regra,
 * editar o gatilho, editar as ações ou apagar. Ligar uma regra que um humano
 * escreveu e revisou é reversível por um clique na tela e o humano sabe o que
 * ela faz. Deixar o agente ESCREVER a ação seria deixá-lo escolher para qual
 * endereço externo a empresa manda dados — e aí o gate humano vira decorativo.
 *
 * ⚠️ `actions` NUNCA SAI COM `config` CRU. A configuração de `call_webhook`
 * carrega `secret_enc` e a URL de destino. O que sai daqui é a LISTA DE TIPOS de
 * ação — o suficiente para dizer "esta regra manda mensagem e aplica marcador",
 * que é o que alguém precisa saber para decidir se liga.
 */
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { contarCondicoes, type Conditions } from "@/lib/automation/conditions";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";

export interface RegraVisivel {
  id: string;
  name: string;
  is_active: boolean;
  /** O evento que a dispara, no vocabulário do sistema (`lead.created`, …). */
  trigger_event: string;
  /** Só os TIPOS das ações — nunca a configuração. Ver o aviso no topo. */
  acoes: string[];
  quantidade_de_condicoes: number;
  last_run_at: string | null;
  run_count: number;
  last_change_actor_kind: string | null;
  last_change_at: string | null;
}

const COLUNAS =
  "id, name, is_active, trigger_event, conditions, actions, last_run_at, run_count, " +
  "last_change_actor_kind, last_change_at";

function semConfig(linha: Record<string, unknown>): RegraVisivel {
  const acoes = Array.isArray(linha.actions)
    ? (linha.actions as Array<{ type?: unknown }>).map((a) => String(a?.type ?? "desconhecida"))
    : [];
  // `conditions` é a lista antiga OU um grupo `{all|any}` (#2727). Contar por
  // `.length` devolvia 0 para `{any:[…]}` — um objeto não tem comprimento —, e a
  // tela dizia "sem condições" para uma regra com duas.
  const condicoes = contarCondicoes((linha.conditions ?? []) as Conditions);
  return {
    id: linha.id as string,
    name: linha.name as string,
    is_active: Boolean(linha.is_active),
    trigger_event: linha.trigger_event as string,
    acoes,
    quantidade_de_condicoes: condicoes,
    last_run_at: (linha.last_run_at as string | null) ?? null,
    run_count: Number(linha.run_count ?? 0),
    last_change_actor_kind: (linha.last_change_actor_kind as string | null) ?? null,
    last_change_at: (linha.last_change_at as string | null) ?? null,
  };
}

export async function listarRegrasAutomaticas(
  deps: DepsDaOperacao,
  opts: { apenasAtivas?: boolean } = {},
): Promise<RegraVisivel[]> {
  let q = deps.supabase
    .from("automation_rules")
    .select(COLUNAS)
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false });
  if (opts.apenasAtivas) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(semConfig);
}

async function regraDaOrg(
  deps: DepsDaOperacao,
  id: string,
): Promise<{ id: string; name: string; is_active: boolean; trigger_event: string; trigger_config: unknown }> {
  const { data, error } = await deps.supabase
    .from("automation_rules")
    .select("id, name, is_active, trigger_event, trigger_config")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  if (!data) {
    throw new ApiError(404, "not_found", undefined, deps.requestId, "Essa regra não existe aqui.");
  }
  return data as unknown as {
    id: string;
    name: string;
    is_active: boolean;
    trigger_event: string;
    trigger_config: unknown;
  };
}

/** Liga ou desliga a regra. Ver o aviso do topo antes de afrouxar o risco disto. */
export async function definirRegraAtiva(
  deps: DepsDaOperacao,
  input: { id: string; ativa: boolean },
): Promise<RegraVisivel> {
  const antes = await regraDaOrg(deps, input.id);

  // A mesma recusa do PATCH da rota: religar por aqui não passa por ela, e uma
  // regra antiga com gatilho por data num campo do contato voltaria muda.
  if (input.ativa) {
    const campoDeData = await campoDoGatilhoDeDataEhDoContato(
      deps.supabase,
      deps.organizationId,
      antes.trigger_event,
      antes.trigger_config,
    );
    if ("erro" in campoDeData) {
      throw new ApiError(500, "internal_error", undefined, deps.requestId, campoDeData.erro);
    }
    if (campoDeData.doContato) {
      throw new ApiError(422, "invalid_request", undefined, deps.requestId, MENSAGEM_CAMPO_DE_DATA_DO_CONTATO);
    }
  }

  const { data: updated, error } = await deps.supabase
    .from("automation_rules")
    .update({
      is_active: input.ativa,
      updated_at: new Date().toISOString(),
      ...autoriaDaMudanca(deps.actor),
    })
    .eq("id", input.id)
    .eq("organization_id", deps.organizationId)
    .select(COLUNAS)
    .single();
  if (error || !updated) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      deps.requestId,
      error?.message ?? "automation_rule_update_failed",
    );
  }

  await audit({
    action: "automation.rule_updated",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    organizationId: deps.organizationId,
    resourceType: "automation_rule",
    resourceId: input.id,
    requestId: deps.requestId,
    metadata: {
      is_active: input.ativa,
      de: antes.is_active,
      name: antes.name,
      actor_type: deps.actor.type,
    },
  });

  return semConfig(updated as unknown as Record<string, unknown>);
}

export interface ExecucaoVisivel {
  id: string;
  regra: string | null;
  status: string;
  quando: string;
  /** Só as que NÃO deram certo — o resto é ruído para quem investiga. */
  falhas: Array<{ acao: string; erro: string }>;
}

/**
 * O que as regras dispararam, e o que falhou.
 *
 * ⚠️ SÓ AS FALHAS VÃO DETALHADAS. `actions_result` traz o resultado de cada ação
 * inclusive nos sucessos, e mandar tudo encheria o contexto do modelo com linhas
 * que não mudam decisão nenhuma (invariante 5 da doutrina: dado que não muda uma
 * decisão é ruído). O status agregado responde "funcionou?"; a lista de falhas
 * responde "o que conserto?".
 */
export async function execucoesDasRegras(
  deps: DepsDaOperacao,
  input: { ruleId?: string; limite: number; apenasFalhas?: boolean },
): Promise<ExecucaoVisivel[]> {
  if (input.ruleId) await regraDaOrg(deps, input.ruleId);

  let q = deps.supabase
    .from("automation_rule_runs")
    .select("id, status, created_at, actions_result, error, rule_id, automation_rules(name)")
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false })
    .limit(input.limite);
  if (input.ruleId) q = q.eq("rule_id", input.ruleId);
  if (input.apenasFalhas) q = q.in("status", ["failed", "partial"]);

  const { data, error } = await q;
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const resultados = Array.isArray(r.actions_result)
      ? (r.actions_result as Array<{ type?: unknown; status?: unknown; error?: unknown }>)
      : [];
    return {
      id: r.id as string,
      regra: nomeDaRegra(r.automation_rules),
      status: r.status as string,
      quando: r.created_at as string,
      falhas: resultados
        .filter((a) => a?.status === "failed")
        .map((a) => ({
          acao: String(a?.type ?? "desconhecida"),
          erro: String(a?.error ?? r.error ?? "sem detalhe"),
        })),
    };
  });
}

/**
 * O nome vindo do join — que o PostgREST devolve como objeto OU array conforme a
 * cardinalidade que ele infere. Tratar só um dos dois formatos deixaria o nome
 * `null` em metade dos casos, e a tela mostraria "Automação removida" para uma
 * regra que existe.
 */
function nomeDaRegra(join: unknown): string | null {
  if (Array.isArray(join)) return (join[0] as { name?: string } | undefined)?.name ?? null;
  if (join && typeof join === "object") return (join as { name?: string }).name ?? null;
  return null;
}

/**
 * OS IDS QUE UMA REGRA DE AUTOMAÇÃO CARREGA, CONFERIDOS CONTRA A ORGANIZAÇÃO (Spec 33, R1).
 *
 * `automation_rules.actions` e `trigger_config` são jsonb: o banco não tem chave estrangeira para o
 * funil, a etapa, o canal, o agente, o fluxo ou a pessoa que a regra aponta. Pela sessão, a RLS e a
 * tela só oferecem recurso da própria organização. Pelo token de integração a rota usa a service
 * role, e uma regra poderia apontar para um recurso de OUTRA organização — e o motor, ao executar,
 * agiria sobre ele. Este módulo é a conferência que faltava, e só o ramo do token a usa.
 *
 * FALHA FECHADA, nos três sentidos:
 *  - tipo de ação que o mapa não conhece é recusado;
 *  - qualquer chave que termine em `_id` ou `_ids` (em qualquer profundidade, inclusive `user_id`
 *    dentro de `fila` e as ações aninhadas de `ai_decide`) que o mapa daquele tipo não declare é
 *    recusada — nunca ignorada. Ação nova com id novo reprova aqui até alguém declarar o campo;
 *  - id declarado que não aparece na organização, ou consulta que falha, é recusa.
 *
 * Toda consulta filtra `organization_id` à mão (o cliente é o admin).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResultadoDosIds = { ok: true } | { ok: false; campo: string };

type Alvo = "pipeline" | "etapa" | "canal" | "agente" | "fluxo" | "membro" | "plano" | "fonte";

/** Tabelas com `id` e `organization_id`. `membro` e `plano` têm conferência própria. */
const TABELA_DO_ALVO: Record<Exclude<Alvo, "membro" | "plano">, string> = {
  pipeline: "crm_pipelines",
  etapa: "crm_stages",
  canal: "channel_sessions",
  agente: "ai_agents",
  fluxo: "followup_flow_pointers",
  fonte: "webhook_sources",
};

/**
 * O MAPA: tipo de ação → caminho do campo dentro de `config` → o que ele referencia.
 * `[]` marca elemento de array. Tipo ausente daqui é recusado. Escrito contra `acoesFixas` em
 * `lib/schemas/webhooks.ts`: quem acrescentar ação com id declara aqui, no mesmo PR.
 */
const MAPA_DAS_ACOES: Readonly<Record<string, Readonly<Record<string, Alvo>>>> = {
  create_or_move_lead: { pipeline_id: "pipeline", stage_id: "etapa" },
  send_whatsapp_message: { channel_session_id: "canal" },
  send_email: { membro_id: "membro" },
  add_tag: {},
  assign_owner: {
    user_id: "membro",
    "fila[].user_id": "membro",
    "fallback.user_id": "membro",
    "fallback.fila[].user_id": "membro",
  },
  send_ai_message: { agent_id: "agente", channel_session_id: "canal" },
  call_webhook: {},
  start_message_flow: { flow_pointer_id: "fluxo" },
  create_task: { "atribuir_a.usuario_id": "membro" },
  apply_task_plan: { plano_id: "plano" },
  set_lead_date_field: { pipeline_id: "pipeline" },
  notify_team: {},
};

/** O que o gatilho (`trigger_config`) pode referenciar. */
const MAPA_DO_GATILHO: Readonly<Record<string, Alvo>> = {
  pipeline_id: "pipeline",
  stage_id: "etapa",
  webhook_source_id: "fonte",
};

const TERMINA_EM_ID = /_ids?$/;
const PROFUNDIDADE_MAXIMA_DE_ACOES = 3;

type Referencia = { campo: string; alvo: Alvo; id: string };
type Coleta = { refs: Referencia[]; recusa: string | null };

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Percorre `valor` inteiro. Toda chave que termina em `_id`/`_ids` precisa estar em `conhecidos`
 * (caminho com `[]` nos arrays) e valer uma string; senão a coleta recusa, com o caminho concreto.
 */
function varrer(
  valor: unknown,
  caminho: string,
  rotulo: string,
  conhecidos: Readonly<Record<string, Alvo>>,
  coleta: Coleta,
  ignorar: ReadonlySet<string> = new Set(),
): void {
  if (coleta.recusa !== null) return;
  if (Array.isArray(valor)) {
    valor.forEach((item, i) => varrer(item, `${caminho}[]`, `${rotulo}[${i}]`, conhecidos, coleta, ignorar));
    return;
  }
  if (!ehObjeto(valor)) return;
  for (const [chave, filho] of Object.entries(valor)) {
    if (coleta.recusa !== null) return;
    if (caminho === "" && ignorar.has(chave)) continue;
    const caminhoDoFilho = caminho === "" ? chave : `${caminho}.${chave}`;
    const rotuloDoFilho = rotulo === "" ? chave : `${rotulo}.${chave}`;
    if (TERMINA_EM_ID.test(chave)) {
      const alvo = conhecidos[caminhoDoFilho.replace(/\[\d+\]/g, "[]")];
      if (alvo === undefined || typeof filho !== "string" || filho === "") {
        coleta.recusa = rotuloDoFilho;
        return;
      }
      coleta.refs.push({ campo: rotuloDoFilho, alvo, id: filho });
      continue;
    }
    varrer(filho, caminhoDoFilho, rotuloDoFilho, conhecidos, coleta, ignorar);
  }
}

function coletarDaAcao(acao: unknown, rotulo: string, profundidade: number, coleta: Coleta): void {
  if (coleta.recusa !== null) return;
  if (profundidade > PROFUNDIDADE_MAXIMA_DE_ACOES || !ehObjeto(acao)) {
    coleta.recusa = rotulo;
    return;
  }
  const tipo = acao.type;
  const config = acao.config;
  if (tipo === "ai_decide") {
    if (!ehObjeto(config)) {
      coleta.recusa = `${rotulo}.config`;
      return;
    }
    // Chave `_id` solta direto na ação, e na configuração da própria `ai_decide` (sem as opções):
    // nenhum `_id` é conhecido aqui.
    varrer(acao, "", rotulo, {}, coleta, new Set(["config", "type"]));
    varrer(config, "", `${rotulo}.config`, {}, coleta, new Set(["opcoes"]));
    const opcoes = config.opcoes;
    if (!Array.isArray(opcoes)) {
      coleta.recusa = `${rotulo}.config.opcoes`;
      return;
    }
    opcoes.forEach((opcao, k) => {
      const onde = `${rotulo}.config.opcoes[${k}]`;
      if (!ehObjeto(opcao)) {
        coleta.recusa ??= onde;
        return;
      }
      // Chaves da opção além de `acao` (`id` e `rotulo` não terminam em `_id`): nenhuma `_id` conhecida.
      varrer(opcao, "", onde, {}, coleta, new Set(["acao"]));
      coletarDaAcao(opcao.acao, `${onde}.acao`, profundidade + 1, coleta);
    });
    return;
  }
  if (typeof tipo !== "string" || !Object.hasOwn(MAPA_DAS_ACOES, tipo)) {
    coleta.recusa = `${rotulo}.type`;
    return;
  }
  const mapa = MAPA_DAS_ACOES[tipo] ?? {};
  // Chave `_id` solta direto na ação (fora de `config`) também é recusada.
  varrer(acao, "", rotulo, {}, coleta, new Set(["config", "type"]));
  varrer(config, "", `${rotulo}.config`, mapa, coleta);
}

async function conferir(
  db: SupabaseClient,
  organizationId: string,
  refs: readonly Referencia[],
): Promise<ResultadoDosIds> {
  const porAlvo = new Map<Alvo, Referencia[]>();
  for (const ref of refs) porAlvo.set(ref.alvo, [...(porAlvo.get(ref.alvo) ?? []), ref]);

  for (const [alvo, lista] of porAlvo) {
    const ids = [...new Set(lista.map((r) => r.id))];
    const existentes = new Set<string>();
    try {
      if (alvo === "membro") {
        const { data, error } = await db
          .from("user_organizations")
          .select("user_id")
          .eq("organization_id", organizationId)
          .in("user_id", ids)
          .is("revoked_at", null);
        if (error) return { ok: false, campo: lista[0]?.campo ?? alvo };
        for (const l of data ?? []) existentes.add(String((l as { user_id: unknown }).user_id));
      } else if (alvo === "plano") {
        const { data, error } = await db
          .from("organizations")
          .select("settings")
          .eq("id", organizationId)
          .maybeSingle();
        if (error) return { ok: false, campo: lista[0]?.campo ?? alvo };
        const planos = (data as { settings?: { task_plans?: unknown } } | null)?.settings?.task_plans;
        for (const p of Array.isArray(planos) ? planos : []) {
          const id = (p as { id?: unknown } | null)?.id;
          if (typeof id === "string") existentes.add(id);
        }
      } else {
        const { data, error } = await db
          .from(TABELA_DO_ALVO[alvo])
          .select("id")
          .eq("organization_id", organizationId)
          .in("id", ids);
        if (error) return { ok: false, campo: lista[0]?.campo ?? alvo };
        for (const l of data ?? []) existentes.add(String((l as { id: unknown }).id));
      }
    } catch {
      return { ok: false, campo: lista[0]?.campo ?? alvo };
    }
    const ausente = lista.find((r) => !existentes.has(r.id));
    if (ausente) return { ok: false, campo: ausente.campo };
  }
  return { ok: true };
}

/**
 * Confere que CADA id referenciado pelas ações existe na organização. Falha fechada: ver o cabeçalho.
 * `campo` é o caminho do primeiro problema (`acoes[0].config.stage_id`).
 */
export async function validarIdsDasAcoes(
  db: SupabaseClient,
  organizationId: string,
  acoes: unknown,
): Promise<ResultadoDosIds> {
  if (!Array.isArray(acoes)) return { ok: false, campo: "acoes" };
  const coleta: Coleta = { refs: [], recusa: null };
  acoes.forEach((acao, i) => coletarDaAcao(acao, `acoes[${i}]`, 0, coleta));
  if (coleta.recusa !== null) return { ok: false, campo: coleta.recusa };
  return conferir(db, organizationId, coleta.refs);
}

/**
 * O mesmo para o `trigger_config` (funil, etapa e fonte do gatilho). Chave `_id` que o mapa do
 * gatilho não declara é recusada.
 */
export async function validarIdsDoGatilho(
  db: SupabaseClient,
  organizationId: string,
  triggerConfig: unknown,
): Promise<ResultadoDosIds> {
  if (triggerConfig === undefined || triggerConfig === null) return { ok: true };
  const coleta: Coleta = { refs: [], recusa: null };
  varrer(triggerConfig, "", "trigger_config", MAPA_DO_GATILHO, coleta);
  if (coleta.recusa !== null) return { ok: false, campo: coleta.recusa };
  return conferir(db, organizationId, coleta.refs);
}

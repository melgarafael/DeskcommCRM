/**
 * GET /api/v1/metrics/funil — análise do funil (issue #1750).
 *
 * Três perguntas que o painel não respondia: quantos passam de cada etapa para
 * a seguinte, quanto tempo leva do primeiro contato ao fechamento, e de que
 * origem vêm os que fecham. A conta é `lib/metrics/funil.ts`; aqui só se lê e
 * se monta — nenhuma tabela nova, nenhum SQL em banco de produção: as
 * passagens saem das atividades `stage_changed` que o relógio de etapa já
 * grava (dependência declarada no corpo da issue).
 *
 * Escopo = a PRÓPRIA RLS, igual às rotas irmãs de métricas: leitura com o
 * client de sessão, então `crm_leads` (`fn_can_view_lead`) e
 * `crm_lead_activities` (policy que passa pelo mesmo `fn_can_view_lead`)
 * filtram sozinhos — atendente vê só os próprios negócios, gestor vê a
 * organização (spec 13, decisão G1-06e). A org vem do cookie validado, NUNCA
 * do query. Read-only ⇒ sem audit.
 *
 * CONTRA-MÉTRICA NO MESMO CORPO (doutrina `03-medida-do-proposito.md` §3.3):
 * a taxa de conversão só responde sozinha se vier junto com o custo de
 * empurrá-la — turnos até o desfecho e opt-outs. Os dois números já saem de
 * `fn_atrito_metrics` na MESMA janela, então este payload os repete em vez de
 * recalcular: mesma fonte, mesmo denominador, zero SQL novo. Se a RPC falhar,
 * a contra-métrica vem `null` com a razão escrita — nunca some e nunca vira 0.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  type AtividadeDeEtapa,
  type EtapaReferencia,
  type FunilReferencia,
  type LeadDaJanela,
  montarRelatorioDeFunil,
} from "@/lib/metrics/funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Teto da leitura: acima disso o relatório diz que está cortado, não mente. */
const LIMITE = 5000;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

interface AtividadeCrua {
  lead_id: string;
  payload: unknown;
  performed_at: string;
}

interface LeadCru {
  id: string;
  pipeline_id: string;
  stage_id: string;
  status: string;
  source: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  closed_at: string | null;
}

/** Número do jsonb vira `null` se não for número de verdade — nunca NaN. */
function numeroOuNull(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function lerContraMetrica(dado: unknown, motivo: string | null): unknown {
  const cliente = (
    dado && typeof dado === "object" ? (dado as { cliente?: unknown }).cliente : null
  ) as Record<string, unknown> | null;
  if (!motivo && (!cliente || typeof cliente !== "object")) {
    return {
      turnos: null,
      opt_outs: null,
      fonte: "fn_atrito_metrics",
      nota: "Contra-métrica não medida: fn_atrito_metrics não devolveu o bloco 'cliente' nesta janela.",
    };
  }
  if (motivo) {
    return { turnos: null, opt_outs: null, fonte: "fn_atrito_metrics", nota: motivo };
  }
  return {
    turnos: {
      p50: numeroOuNull(cliente?.turnos_p50),
      p90: numeroOuNull(cliente?.turnos_p90),
      denominador: "demandas encerradas na janela",
    },
    opt_outs: {
      quantidade: numeroOuNull(cliente?.descadastros),
      denominador: "contatos bloqueados na janela",
    },
    fonte: "fn_atrito_metrics (mesma janela; a rota /api/v1/metrics/atrito mede o restante do índice)",
    nota: "Doutrina §3.3: a taxa de conversão é publicada junto do custo de empurrá-la — turnos até o desfecho e opt-outs.",
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // piso agent (vê as próprias); a RLS é quem garante o escopo de cada linha.
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }
  const de = from.toISOString();
  const ate = to.toISOString();

  const supabase = await createClient();
  const orgId = activeOrg.orgId;

  // Seis leituras na mesma janela. A de leads vem em DOIS filtros (criados e
  // encerrados) e o resultado é unido por id: é a base declarada do relatório,
  // "criados OU encerrados na janela", sem depender de `.or()` com dois
  // predicados compostos.
  const [atividadesRes, criadosRes, encerradosRes, etapasRes, funisRes, atritoRes] =
    await Promise.all([
      supabase
        .from("crm_lead_activities")
        .select("lead_id, payload, performed_at")
        .eq("organization_id", orgId)
        .eq("type", "stage_changed")
        .gte("performed_at", de)
        .lt("performed_at", ate)
        .limit(LIMITE),
      supabase
        .from("crm_leads")
        .select(
          "id, pipeline_id, stage_id, status, source, value_cents, currency, created_at, closed_at",
        )
        .eq("organization_id", orgId)
        .gte("created_at", de)
        .lt("created_at", ate)
        .limit(LIMITE),
      supabase
        .from("crm_leads")
        .select(
          "id, pipeline_id, stage_id, status, source, value_cents, currency, created_at, closed_at",
        )
        .eq("organization_id", orgId)
        .gte("closed_at", de)
        .lt("closed_at", ate)
        .limit(LIMITE),
      supabase
        .from("crm_stages")
        .select("id, name, pipeline_id, position")
        .eq("organization_id", orgId),
      supabase.from("crm_pipelines").select("id, name, position").eq("organization_id", orgId),
      supabase.rpc("fn_atrito_metrics", { p_org: orgId, p_from: de, p_to: ate }),
    ]);

  for (const [nome, res] of [
    ["crm_lead_activities", atividadesRes],
    ["crm_leads: criados", criadosRes],
    ["crm_leads: encerrados", encerradosRes],
    ["crm_stages", etapasRes],
    ["crm_pipelines", funisRes],
  ] as const) {
    if (res.error) return fail("internal_error", `${nome}: ${res.error.message}`, 500, { requestId });
  }

  // `stage_changed` tem DUAS grafias no repositório: as rotas de movimento
  // gravam `from_stage_id/to_stage_id`; o agente, o handoff e a agenda gravam
  // `{ de, para }` (lib/leads/agent-stage-sync.ts, handoff-stage-move.ts,
  // appointment-stage-move.ts). Ler só a primeira descartava em silêncio
  // justamente os movimentos feitos pela IA.
  const atividades: AtividadeDeEtapa[] = ((atividadesRes.data ?? []) as AtividadeCrua[])
    .map((a) => {
      const p = (a.payload && typeof a.payload === "object" ? a.payload : {}) as {
        from_stage_id?: string | null;
        to_stage_id?: string | null;
        de?: string | null;
        para?: string | null;
      };
      return {
        lead_id: a.lead_id,
        de: p.from_stage_id ?? p.de ?? null,
        para: p.to_stage_id ?? p.para ?? "",
        quando: a.performed_at,
      };
    })
    .filter((a) => Boolean(a.lead_id) && Boolean(a.para));

  const linhasDeLead = [
    ...((criadosRes.data ?? []) as LeadCru[]),
    ...((encerradosRes.data ?? []) as LeadCru[]),
  ];
  const porId = new Map<string, LeadCru>();
  for (const l of linhasDeLead) if (l.id) porId.set(l.id, l);
  const leads: LeadDaJanela[] = [...porId.values()].map((l) => ({
    id: l.id,
    pipeline_id: l.pipeline_id,
    stage_id: l.stage_id,
    status: (l.status === "won" || l.status === "lost" ? l.status : "open"),
    source: l.source ?? "",
    value_cents: l.value_cents,
    currency: l.currency,
    created_at: l.created_at,
    closed_at: l.closed_at,
  }));

  const etapas: EtapaReferencia[] = ((etapasRes.data ?? []) as Array<{
    id: string;
    name: string;
    pipeline_id: string;
    position: number | string;
  }>).map((e) => ({
    id: e.id,
    nome: e.name,
    pipeline_id: e.pipeline_id,
    posicao: Number(e.position),
  }));

  const funis: FunilReferencia[] = ((funisRes.data ?? []) as Array<{
    id: string;
    name: string;
    position: number | string;
  }>).map((f) => ({ id: f.id, nome: f.name, posicao: Number(f.position) }));

  const relatorio = montarRelatorioDeFunil({
    janela: { from: de, to: ate },
    atividades,
    leads,
    etapas,
    funis,
  });

  const contraMetrica = lerContraMetrica(
    atritoRes.error ? null : atritoRes.data,
    atritoRes.error
      ? `Contra-métrica não medida nesta resposta: ${atritoRes.error.message}`
      : null,
  );

  const truncado =
    (atividadesRes.data?.length ?? 0) >= LIMITE ||
    (criadosRes.data?.length ?? 0) >= LIMITE ||
    (encerradosRes.data?.length ?? 0) >= LIMITE;

  return ok({ ...relatorio, contra_metrica: contraMetrica, truncado }, { requestId });
}

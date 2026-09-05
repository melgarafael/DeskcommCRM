/**
 * GET /api/v1/reports/activities — o que aconteceu na operação num período.
 *
 * Lê `crm_lead_activities` no eixo do PERÍODO, coisa que até aqui não existia:
 * o barramento só era legível por negócio (`/leads/[id]/timeline`) e por contato
 * (`/contacts/[id]/timeline`), então "o que a equipe fez esta semana" obrigava a
 * abrir negócio por negócio.
 *
 * ## Escopo — a própria RLS, e por isso o client é o do USUÁRIO
 *
 * `fn_activity_report` é SECURITY INVOKER (migration 0215). Chamada com o client
 * de sessão (cookie validado), a policy `crm_lead_activities_select` (0042) faz
 * o recorte: `agent` em modo 'own' recebe só as atividades dos negócios dele,
 * viewer/manager/admin recebem a organização. Trocar isto pelo admin client
 * "porque é só leitura" derrubaria o recorte por atendente sem erro nenhum na
 * tela — o relatório simplesmente passaria a mostrar demais.
 *
 * O admin client aparece uma vez só, e para o que a RLS não resolve: `auth.users`
 * não é legível por `authenticated`, e sem ele o ranking de quem trabalhou seria
 * uma lista de UUIDs. Mesmo padrão de `/api/v1/metrics/attendants`.
 *
 * ## Read-only ⇒ sem audit
 *
 * Não há mutação; a doutrina de audit cobre POST/PATCH/DELETE.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { PipelineVocabulary } from "@/lib/kanban/types";
import {
  fusoValido,
  janelaDoPeriodo,
  montarRelatorio,
  type NomesConhecidos,
  type RelatorioBruto,
} from "@/lib/reports/atividades";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * O teto de 90 dias não é timidez: `fn_activity_report` monta uma série com uma
 * linha por dia e varre a janela inteira para contar. Numa VPS de 2 GB — a
 * máquina que a doutrina de packaging assume — um "desde sempre" é o pedido que
 * derruba o banco, e ele chegaria pela query string de qualquer um.
 */
const DIAS_MAXIMOS = 90;

/**
 * O corte da lista. O relatório NÃO é a timeline: quem quer o histórico inteiro
 * de um negócio abre o negócio, e cada linha aponta para lá. O que o corte não
 * pode é mentir — daí `truncado` chegar à tela.
 */
const LIMITE_DE_LINHAS = 200;

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(DIAS_MAXIMOS).default(7),
  /**
   * Fuso IANA do navegador de quem lê. Agrupar o dia em UTC joga a atividade
   * das 21h de Brasília no dia seguinte — o relatório afirmaria trabalho num
   * dia em que ninguém trabalhou.
   */
  tz: z.string().min(1).max(64).default("UTC").refine(fusoValido, {
    message: "Fuso horário desconhecido.",
  }),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso `viewer`: é leitura, e quem restringe por atendente é a RLS, não o
  // papel. Um piso mais alto esconderia da pessoa as atividades dela mesma.
  const authz = await requireRole("viewer", { requestId, resource: "reports" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    days: url.searchParams.get("days") ?? undefined,
    tz: url.searchParams.get("tz") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const { de, ate } = janelaDoPeriodo(parsed.data.days, new Date());

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_activity_report", {
    p_org: activeOrg.orgId,
    p_from: de.toISOString(),
    p_to: ate.toISOString(),
    p_tz: parsed.data.tz,
    p_limit: LIMITE_DE_LINHAS,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const bruto = (data ?? {
    total: 0,
    by_actor: [],
    by_type: [],
    daily: [],
    items: [],
    items_truncated: false,
  }) as unknown as RelatorioBruto;

  const nomes = await resolveNomes(supabase, activeOrg.orgId, bruto);

  // O vocabulário do funil PADRÃO da organização. O relatório é org-wide, então
  // não há um funil a que ele pertença — e o padrão é o que a organização
  // escolheu como a sua palavra. Sem isto, a tela cairia num literal ("Negócio")
  // e o produto deixaria de servir cinco nichos com o mesmo código.
  const { data: funil } = await supabase
    .from("crm_pipelines")
    .select("vocabulary")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_default", true)
    .maybeSingle();

  const relatorio = montarRelatorio(bruto, {
    nomes,
    vocabulary: (funil?.vocabulary ?? null) as PipelineVocabulary | null,
  });

  return ok(
    { window: { from: de.toISOString(), to: ate.toISOString() }, ...relatorio },
    { requestId },
  );
}

/**
 * Id → nome, para pessoas e agentes. Degrada com `null` em vez de falhar: sem
 * o service role (dev), sem a pessoa (conta apagada) ou sem o agente, o
 * `actorName` cai no rótulo genérico e a linha continua honesta.
 */
async function resolveNomes(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  bruto: RelatorioBruto,
): Promise<NomesConhecidos> {
  const usuarios: Record<string, string | null> = {};
  const agentes: Record<string, string | null> = {};

  const idsDeUsuario = [...new Set(bruto.by_actor.map((a) => a.user_id).filter(ehId))];
  const idsDeAgente = [...new Set(bruto.by_actor.map((a) => a.agent_id).filter(ehId))];

  if (idsDeUsuario.length > 0 && isServiceRoleConfigured()) {
    const admin = createAdminClient();
    await Promise.all(
      idsDeUsuario.map(async (id) => {
        const { data } = await admin.auth.admin.getUserById(id);
        usuarios[id] =
          (data?.user?.user_metadata?.full_name as string | undefined) ??
          data?.user?.email ??
          null;
      }),
    );
  }

  if (idsDeAgente.length > 0) {
    // Client do usuário de novo — e AINDA ASSIM com `organization_id` escrito:
    // quem pertence a duas organizações passa na RLS das duas, e a doutrina
    // manda toda query que cruza tabela tenant-aware dizer o inquilino em voz
    // alta em vez de terceirizar o recorte.
    const { data } = await supabase
      .from("ai_agents")
      .select("id, name")
      .eq("organization_id", orgId)
      .in("id", idsDeAgente);
    for (const a of data ?? []) agentes[a.id] = a.name;
  }

  return { usuarios, agentes };
}

function ehId(v: string | null): v is string {
  return typeof v === "string" && v.length > 0;
}

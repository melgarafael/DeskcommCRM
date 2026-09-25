import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/pipelines/[id]/stages — cria uma etapa no fim do funil.
 *
 * Até a tela de etapas existir, NENHUMA superfície criava etapa: o gatilho
 * `trg_seed_default_pipeline_for_org` semeia um funil de e-commerce em toda
 * organização nova, então uma clínica abre o sistema e vê "Carrinho abandonado"
 * sem ter como corrigir.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A operação inteira vive em
 * `lib/leads/stage-operations.ts` porque o agente de IA também organiza o funil
 * (BRIEFING §3, Decisão 4): duas superfícies escrevendo na mesma tabela por
 * caminhos diferentes fariam o sistema mentir para uma das duas.
 *
 * Auth: sessão por cookie, papel manager+ (é configuração do funil, não trabalho
 * de card). `organization_id` sai do JWT — nunca do body. O client é o do
 * usuário, então a RLS vale; o filtro explícito é a convenção do repo e a rede
 * que sobra se a policy mudar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { criarEtapa } from "@/lib/leads/stage-operations";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// `.max(80)`: o nome é o topo de uma coluna do quadro, não um parágrafo. O banco
// não limita, mas a tela quebra muito antes disso.
const bodySchema = z.object({ name: z.string().min(1).max(80) }).strict();

/**
 * GET — as etapas vivas do funil, na ordem do quadro.
 *
 * Existia criação de etapa e nenhuma LEITURA: quem precisava oferecer "escolha
 * a etapa" numa tela (a campanha, agora) não tinha de onde tirar a lista, e a
 * saída seria cada tela consultar o banco por conta própria — duas réguas para
 * "quais etapas existem", que divergem no primeiro arquivamento.
 *
 * Ganho e perda entram: quem escolhe etapa para FILTRAR público quer poder
 * dizer "quem está em Perdido". Quem escolhe etapa de NASCIMENTO é recusado
 * antes, pela regra de que card não nasce fechado.
 */
export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "pipeline_stages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_stages")
    .select("id, name, position, is_won, is_lost")
    .eq("organization_id", authz.org.orgId)
    .eq("pipeline_id", id)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (error) return fail("internal_error", t("Falha ao listar etapas."), 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Dê um nome à etapa — é o que aparece no topo da coluna."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  try {
    const { funil } = await criarEtapa(
      {
        supabase,
        organizationId: authz.org.orgId,
        actor: { type: "user", id: authz.user.id, role: authz.org.role },
        requestId,
      },
      { pipelineId, nome: parsed.data.name },
    );
    return ok(funil, { status: 201, requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

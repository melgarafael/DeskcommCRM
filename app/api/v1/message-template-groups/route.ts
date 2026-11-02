import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/message-template-groups — os grupos de respostas rápidas da
 *      organização ativa, na ordem de exibição (#3245).
 * POST /api/v1/message-template-groups — cria um grupo no FIM da lista.
 *
 * ─── Por que leitura para `agent` e escrita para `manager+` ─────────────────
 *
 * O grupo é ESTRUTURA COMPARTILHADA da organização — a mesma régua da resposta
 * rápida com `owner_user_id` nulo (`message_templates_write`): quem atende lê e
 * vincula a própria resposta a um grupo que já existe; quem cria, renomeia,
 * reordena ou apaga a estrutura da equipe é `manager+`. A policy
 * `message_template_groups_write` (migration 0808) cobra o mesmo — o gate aqui
 * é a mensagem clara antes do INSERT, não a autorização.
 *
 * ─── O grupo novo nasce no FIM ─────────────────────────────────────────────
 *
 * Diferente da resposta rápida (que nasce no topo, #3244), um grupo é uma ETAPA
 * do roteiro: quem cria "Negociação" depois de "Atendimento inicial" e
 * "Follow-up" espera vê-lo por último. A posição é `posicaoEntre(maior, null)`,
 * a mesma conta fracionária da reordenação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createGrupoSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { posicaoEntre } from "@/lib/templates/ordem";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, name, ordem, created_at, updated_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  // `id` no fim é o desempate: dois grupos criados ao mesmo tempo podem dividir
  // a posição, e a lista não pode trocar de ordem entre duas aberturas da tela.
  const { data, error } = await supabase
    .from("message_template_groups")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .order("ordem", { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar os grupos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = createGrupoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  // A última posição da lista VISÍVEL (RLS + organização). `null` é lista
  // vazia, e `posicaoEntre(null, null)` devolve o primeiro passo.
  const { data: ultima, error: erroUltima } = await supabase
    .from("message_template_groups")
    .select("ordem")
    .eq("organization_id", org.orgId)
    .order("ordem", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroUltima) return fail("internal_error", "Erro ao criar o grupo.", 500, { requestId });
  const maior = (ultima as { ordem: number } | null)?.ordem ?? null;
  const ordem = posicaoEntre(maior, null);

  const { data, error } = await supabase
    .from("message_template_groups")
    .insert({ organization_id: org.orgId, name: parsed.data.name, ordem })
    .select(COLS)
    .single();
  if (error || !data) {
    // Nome repetido (índice único por organização, sem diferenciar caixa nem
    // espaço) é o único conflito esperado aqui — 409 com a frase da tela, não
    // um 500 que faria a pessoa recarregar a página para descobrir o motivo.
    if (error?.code === "23505") {
      return fail("conflict", t("Já existe um grupo com esse nome."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao criar o grupo.", 500, { requestId });
  }

  void audit({
    action: "template_group.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template_group",
    resourceId: data.id,
    requestId,
    metadata: { name: parsed.data.name },
  });
  return ok(data, { requestId, status: 201 });
}

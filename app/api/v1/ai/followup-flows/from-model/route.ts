import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/from-model — instala um modelo pronto do
 * catálogo (`lib/followup/modelos/`) como fluxo RASCUNHO da organização ativa.
 *
 * O que ela grava, de uma vez: o ponteiro com o nome do modelo, o `draft_graph`
 * inteiro (textos e prazos), o `trigger_config` já armado e a política de
 * handoff. O que ela NÃO faz, e as duas omissões são deliberadas:
 *
 *   • **não publica.** Texto que vai para paciente é lido por uma pessoa antes
 *     de sair. O fluxo nasce `draft`, e publicar continua sendo o botão do
 *     construtor — que roda o mesmo `validateFlowForPublish` de sempre.
 *   • **não mexe em agente nenhum.** Gatilho automático só enrolla se um agente
 *     PUBLICADO tem o ponteiro em `followup.flow_pointer_ids`
 *     (`agent-followup-gate.ts`). Ligar isso sozinha seria mudar o
 *     comportamento de um agente que já atende, sem ninguém pedir. Quem avisa
 *     que falta esse passo é a tela.
 *
 * ⚠️ O GRAFO É VALIDADO AQUI, ANTES DO INSERT. `draft_graph` é `jsonb` sem
 * CHECK: um modelo quebrado entraria no banco em silêncio e só apareceria
 * quando o dono da clínica abrisse o construtor. O catálogo é código nosso, e
 * por isso a falha é 500 `modelo_invalido` — defeito do produto, não do pedido.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { instalarModeloSchema, triggerConfigSchema } from "@/lib/followup/api-schemas";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { modeloPorId } from "@/lib/followup/modelos";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = instalarModeloSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const modelo = modeloPorId(parsed.data.model_id);
  if (!modelo) {
    return fail("not_found", t("Este modelo não existe mais."), 404, { requestId });
  }

  const supabase = await createClient();

  // A etapa é conferida AQUI, com alguém na tela — e não só no publish. Etapa de
  // outra organização, apagada ou arquivada deixa o fluxo `active` sem nunca
  // enrollar ninguém: fluxo morto com cara de vivo.
  if (modelo.pedeEtapa) {
    if (!parsed.data.stage_id) {
      return fail(
        "trigger_stage_missing",
        t("Escolha a etapa do funil que dispara este fluxo."),
        422,
        { requestId },
      );
    }
    const { data: etapa, error: etapaErr } = await supabase
      .from("crm_stages")
      .select("id, name, is_archived")
      .eq("id", parsed.data.stage_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (etapaErr) return fail("internal_error", etapaErr.message, 500, { requestId });
    if (!etapa) {
      return fail(
        "trigger_stage_not_found",
        t("A etapa escolhida não existe neste funil — escolha outra."),
        422,
        { requestId },
      );
    }
    if (etapa.is_archived) {
      return fail(
        "trigger_stage_archived",
        `A etapa «${etapa.name}» está arquivada e nunca receberia um negócio — escolha uma etapa ativa.`,
        422,
        { requestId },
      );
    }
  }

  const gatilho = triggerConfigSchema.safeParse(modelo.gatilho({ stageId: parsed.data.stage_id }));
  const grafo = flowGraphSchema.safeParse(modelo.grafo);
  // Sem contexto de conexão: o modelo do catálogo tem de ser publicável em
  // QUALQUER organização, inclusive a que tem canal com janela de 24 h.
  const publicavel = grafo.success ? validateFlowForPublish(grafo.data) : null;
  if (!gatilho.success || !grafo.success || (publicavel && !publicavel.ok)) {
    return fail(
      "internal_error",
      `modelo_invalido: ${modelo.id}`,
      500,
      { requestId },
    );
  }

  const nome = parsed.data.name ?? modelo.nome;
  const { data: criado, error: insErr } = await supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: activeOrg.orgId,
      name: nome,
      draft_graph: grafo.data,
      trigger_config: gatilho.data,
      handoff_policy: modelo.handoffPolicy,
    })
    .select("*")
    .single();

  if (insErr || !criado) {
    // Instalar duas vezes é engano comum (a pessoa não vê o fluxo na lista e
    // clica de novo). O 409 nomeia o fluxo que JÁ existe em vez de criar um
    // segundo com o mesmo desenho disputando o mesmo paciente — só uma
    // inscrição por contato vive por vez (`idx_followup_enrollments_one_live`).
    if (insErr?.code === "23505") {
      return fail(
        "conflict",
        `Você já tem um fluxo chamado «${nome}». Abra esse ou instale com outro nome.`,
        409,
        { requestId },
      );
    }
    return fail("internal_error", insErr?.message ?? "followup_flow_insert_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id,
    requestId,
    metadata: { name: nome, model_id: modelo.id, trigger_kind: gatilho.data.kind },
  });

  return ok(criado, { requestId, status: 201 });
}

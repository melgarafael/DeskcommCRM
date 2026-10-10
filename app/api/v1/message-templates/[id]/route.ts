import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/message-templates/[id] — atualiza título/corpo/atalho e a
 *        LISTA de imagens (`midias`, #2526).
 * DELETE /api/v1/message-templates/[id] — remove o template e as imagens dele.
 *
 * O `.eq("organization_id", org.orgId)` é defesa extra, não substitui a RLS
 * `message_templates_write` — quem já não é dono (agent) nem manager (compartilhado)
 * é barrado pela policy antes de chegar aqui.
 *
 * ─── Por que `midias` só entra por aqui, e não pelo upload ──────────────────
 *
 * O upload ADICIONA (ele gera o caminho e confere os bytes); o PATCH é quem
 * REMOVE, mandando a lista completa das que permanecem — o mesmo desenho do
 * `PUT /products/:id/fotos`. Daí as duas conferências, e as duas importam:
 *
 *   1. `conferirMidias` — toda imagem da lista nova já existe na linha. Sem
 *      ela, um corpo forjado cadastraria um caminho que ninguém subiu.
 *   2. `midiaPertenceAoTemplate` — e que é DESTE template e desta organização.
 *      `storage.remove` roda por service role, sem RLS: sem a conferência, o
 *      PATCH apagaria arquivo de outra org pelo preço de um JSON.
 *
 * O apagado sai do bucket SÓ DEPOIS do update dar certo — arquivo órfão se
 * recupera, linha apontando para arquivo sumido é tela quebrada.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { updateTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { apagarMidiasDoTemplate } from "@/lib/templates/midias-no-bucket";
import {
  conferirMidias,
  midiaPertenceAoTemplate,
  type MidiaDeTemplate,
} from "@/lib/templates/midias";

export const dynamic = "force-dynamic";
const COLS =
  "id, organization_id, owner_user_id, title, body, shortcut, midias, created_by_user_id, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = updateTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // A lista ATUAL vem antes do update: é dela que sai o diff. Sem esta leitura
  // um PATCH que só remove apagaria o arquivo errado — ou nenhum.
  const { data: linha, error: erroLeitura } = await supabase
    .from("message_templates")
    .select("midias")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroLeitura) {
    logger.error("[message-templates] falha ao ler midias", { detalhe: erroLeitura.message, requestId });
    return fail("internal_error", "Erro ao atualizar template.", 500, { requestId });
  }
  if (!linha) return fail("not_found", t("Template não encontrado."), 404, { requestId });

  const atuais = ((linha as { midias: MidiaDeTemplate[] | null }).midias ?? []) as MidiaDeTemplate[];
  const novas = parsed.data.midias;
  let removidas: string[] = [];
  if (novas !== undefined) {
    if (novas.some((m) => !midiaPertenceAoTemplate(m.storage_path, org.orgId, id))) {
      return fail("validation_failed", t("Dados inválidos."), 422, {
        requestId,
        details: { midias: ["Imagem que não pertence a este template."] },
      });
    }
    const conferida = conferirMidias(atuais, novas);
    if (!conferida.ok) {
      // A tela está atrás da linha (outra aba mexeu) ou o corpo foi forjado.
      return fail("conflict", t("As imagens mudaram. Recarregue a página."), 409, { requestId });
    }
    removidas = conferida.removidas;
  }

  const { data, error } = await supabase
    .from("message_templates")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(COLS)
    .single();
  if (error || !data) return fail("not_found", t("Template não encontrado."), 404, { requestId });

  // Só depois da linha gravada, e nunca derruba o PATCH: o pedido do operador
  // (remover a imagem) já foi atendido, o log é o que falta para a limpeza.
  if (removidas.length) await apagarMidiasDoTemplate(removidas, requestId);

  void audit({
    action: "template.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: data.id,
    requestId,
    metadata: { fields: Object.keys(parsed.data), removidas: removidas.length },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  // .select() confirma que a linha existia E era visível/apagável pela RLS.
  // Sem isso, um DELETE barrado pela RLS afeta 0 linhas mas ainda retornaria
  // 204 + audit falso (mutação que não ocorreu). Espelha a semântica do PATCH.
  // `midias` vem junto porque é a ÚLTIMA chance de ler os caminhos: depois do
  // delete a linha não existe mais, e a imagem dela ficaria órfã para sempre
  // (critério de aceite da #2526).
  const { data: deleted, error } = await supabase
    .from("message_templates")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, midias")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao excluir template.", 500, { requestId });
  if (!deleted) return fail("not_found", t("Template não encontrado."), 404, { requestId });

  const caminhos = (((deleted as { midias: MidiaDeTemplate[] | null }).midias ?? []) as MidiaDeTemplate[])
    .map((m) => m.storage_path)
    // A conferência é a mesma do PATCH: a leitura é por service role e o
    // apagado é irreversível, então só o que é DESTE template sai daqui.
    .filter((caminho) => midiaPertenceAoTemplate(caminho, org.orgId, id));
  await apagarMidiasDoTemplate(caminhos, requestId);

  void audit({
    action: "template.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: deleted.id,
    requestId,
    metadata: { midias: caminhos.length },
  });
  return noContent(requestId);
}

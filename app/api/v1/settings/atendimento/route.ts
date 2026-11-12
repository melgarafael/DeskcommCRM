import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  JANELA_DA_NOTA_HORAS,
  JANELA_MAXIMA_HORAS,
  lerOpcaoDaSatisfacao,
  TEXTO_DA_PERGUNTA_PADRAO,
} from "@/lib/atendimento/satisfacao";

/**
 * GET/PATCH /api/v1/settings/atendimento — o interruptor da pesquisa de
 * satisfação (#4023).
 *
 * Nasce DESLIGADA (`satisfacao.ligado` ausente ⇒ não pergunta). A pergunta sai
 * uma vez, ao encerrar, e a resposta de 1 a 5 volta pela entrada normal do
 * WhatsApp (ver `lib/atendimento/satisfacao.ts`).
 *
 * Piso `manager`: é configuração da empresa, não preferência do atendente.
 * `/api/v1/metrics/satisfacao` lê o resultado com o mesmo piso.
 */

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  ligado: z.boolean(),
  janela_horas: z.number().int().min(1).max(JANELA_MAXIMA_HORAS).optional(),
  pergunta: z.string().trim().min(10).max(300).optional(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const satisfacao = lerOpcaoDaSatisfacao((data as { settings?: unknown } | null)?.settings);
  return ok({ satisfacao }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("validation_failed", t("Corpo inválido."), 422, { requestId });
  }
  const parsed = patchSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Configuração inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: orgRow, error: erroDaLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (erroDaLeitura) return fail("internal_error", erroDaLeitura.message, 500, { requestId });

  // Merge não-destrutivo em dois níveis: preserva as outras chaves de `settings`
  // e as outras chaves do bloco (a pergunta e a janela sobrevivem ao liga/desliga).
  const atuais = ((orgRow as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>;
  const bloco = parsed.data;
  const blocoAtual = (atuais.satisfacao as Record<string, unknown> | null) ?? {};
  const proximoBloco = {
    ...blocoAtual,
    ligado: bloco.ligado,
    janela_horas: bloco.janela_horas ?? blocoAtual.janela_horas ?? JANELA_DA_NOTA_HORAS,
    pergunta: bloco.pergunta ?? blocoAtual.pergunta ?? TEXTO_DA_PERGUNTA_PADRAO,
  };

  const { error: erroAoGravar } = await admin
    .from("organizations")
    .update({ settings: { ...atuais, satisfacao: proximoBloco } })
    .eq("id", authz.org.orgId);
  if (erroAoGravar) return fail("internal_error", erroAoGravar.message, 500, { requestId });

  await audit({
    action: "settings.satisfacao_alterada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { ligado: bloco.ligado },
  });

  return ok({ satisfacao: lerOpcaoDaSatisfacao({ satisfacao: proximoBloco }) }, { requestId });
}

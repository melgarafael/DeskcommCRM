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
import {
  lerOpcaoDoFiltroDeSpam,
  LIMIAR_MAXIMO,
  LIMIAR_MINIMO,
} from "@/lib/entrada/filtro-de-spam";

/**
 * GET/PATCH /api/v1/settings/atendimento — os dois interruptores do ciclo de
 * atendimento, em UMA rota.
 *
 * ## #4023 — pesquisa de satisfação
 *
 * Nasce DESLIGADA (`satisfacao.ligado` ausente ⇒ não pergunta). A pergunta sai
 * uma vez, ao encerrar, e a resposta de 1 a 5 volta pela entrada normal do
 * WhatsApp (ver `lib/atendimento/satisfacao.ts`).
 *
 * ## #4026 — filtro de spam na entrada
 *
 * Nasce DESLIGADO (`filtro_de_spam.ligado` ausente ⇒ nada é retido). Ligado,
 * a mensagem acima do limiar vai para a QUARENTENA: continua em `messages`,
 * nada é descartado, e não acorda agente, ligação, notificação nem automação
 * até uma pessoa liberar (`/api/v1/quarentena`).
 *
 * ## Por que PATCH com `bloco`, e não dois PATCHes
 *
 * Porque são dois interruptores da MESMA tela e do mesmo ciclo, e porque a
 * escrita é um merge de `organizations.settings` — um segundo endpoint seria a
 * segunda cópia do merge, e a primeira que envelhecesse apagaria a chave da
 * outra (o defeito clássico de dois donos do mesmo jsonb).
 *
 * Piso `manager`: é configuração da empresa, não preferência do atendente.
 * `/api/v1/metrics/satisfacao` lê o resultado com o mesmo piso.
 */

export const dynamic = "force-dynamic";

const patchSchema = z.discriminatedUnion("bloco", [
  z.object({
    bloco: z.literal("satisfacao"),
    ligado: z.boolean(),
    janela_horas: z.number().int().min(1).max(JANELA_MAXIMA_HORAS).optional(),
    pergunta: z.string().trim().min(10).max(300).optional(),
  }),
  z.object({
    bloco: z.literal("filtro_de_spam"),
    ligado: z.boolean(),
    limiar: z.number().min(LIMIAR_MINIMO).max(LIMIAR_MAXIMO).optional(),
  }),
]);

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
  const filtro = lerOpcaoDoFiltroDeSpam((data as { settings?: unknown } | null)?.settings);
  return ok({ satisfacao, filtro_de_spam: filtro }, { requestId });
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
  // e as outras chaves do bloco (a pergunta e o limiar sobrevivem ao liga/desliga).
  const atuais = ((orgRow as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>;
  const bloco = parsed.data;
  const chave = bloco.bloco === "satisfacao" ? "satisfacao" : "filtro_de_spam";
  const blocoAtual = (atuais[chave] as Record<string, unknown> | null) ?? {};
  const proximoBloco =
    bloco.bloco === "satisfacao"
      ? {
          ...blocoAtual,
          ligado: bloco.ligado,
          janela_horas: bloco.janela_horas ?? blocoAtual.janela_horas ?? JANELA_DA_NOTA_HORAS,
          pergunta: bloco.pergunta ?? blocoAtual.pergunta ?? TEXTO_DA_PERGUNTA_PADRAO,
        }
      : {
          ...blocoAtual,
          ligado: bloco.ligado,
          limiar: bloco.limiar ?? blocoAtual.limiar ?? undefined,
        };

  const { error: erroAoGravar } = await admin
    .from("organizations")
    .update({ settings: { ...atuais, [chave]: proximoBloco } })
    .eq("id", authz.org.orgId);
  if (erroAoGravar) return fail("internal_error", erroAoGravar.message, 500, { requestId });

  await audit({
    action: bloco.bloco === "satisfacao" ? "settings.satisfacao_alterada" : "settings.filtro_de_spam_alterado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { ligado: bloco.ligado },
  });

  const atualizado = lerOpcaoDaSatisfacao({ satisfacao: proximoBloco });
  const filtroAtualizado = lerOpcaoDoFiltroDeSpam({ filtro_de_spam: proximoBloco });
  return ok(
    bloco.bloco === "satisfacao" ? { satisfacao: atualizado } : { filtro_de_spam: filtroAtualizado },
    { requestId },
  );
}

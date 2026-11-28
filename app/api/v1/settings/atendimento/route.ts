import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
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
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

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
 * outra (o defeito clássico de dois donos do mesmo jsonb). `bloco` é
 * OPCIONAL no ramo da satisfação: o painel que já está na main
 * (`_pesquisaDeSatisfacao.tsx`) manda `{ ligado }` sem bloco, e o corpo antigo
 * continua valendo como o da satisfação. Exigir `bloco` transformaria o painel
 * em 422 — o merge não pode reescrever o contrato de quem já usa a rota.
 *
 * ## Pisos
 *
 * Ler é `manager`+ (é quem vê o resultado, em Configurações › Atendimento);
 * GRAVAR é de quem administra a empresa (`admin`, o mesmo piso das outras
 * opções daquela tela, `podeAdministrarEmpresa`): as duas chaves saem em nome
 * da empresa para todo cliente. `/api/v1/metrics/satisfacao` lê o resultado com
 * piso `manager`.
 */

export const dynamic = "force-dynamic";

const blocoDaSatisfacao = z
  .object({
    bloco: z.literal("satisfacao").optional(),
    ligado: z.boolean(),
    janela_horas: z.number().int().min(1).max(JANELA_MAXIMA_HORAS).optional(),
    pergunta: z.string().trim().min(10).max(300).optional(),
  })
  // `strict` para que um `limiar` mandado sem `bloco` não caia calado no ramo
  // da satisfação (o zod, por padrão, APAGA a chave desconhecida e responderia
  // 200 sem ter gravado nada).
  .strict();

const blocoDoFiltro = z
  .object({
    bloco: z.literal("filtro_de_spam"),
    ligado: z.boolean(),
    limiar: z.number().min(LIMIAR_MINIMO).max(LIMIAR_MAXIMO).optional(),
  })
  .strict();

const patchSchema = z.union([blocoDaSatisfacao, blocoDoFiltro]);

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

  const settings = (data as { settings?: unknown } | null)?.settings;
  const satisfacao = lerOpcaoDaSatisfacao(settings);
  const filtro_de_spam = lerOpcaoDoFiltroDeSpam(settings);
  return ok({ satisfacao, filtro_de_spam }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings", allowPlatformAdmin: true });
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
  // e as outras chaves do bloco (a pergunta, a janela e o limiar sobrevivem ao
  // liga/desliga).
  const atuais = ((orgRow as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>;
  const bloco = parsed.data;
  const daSatisfacao = bloco.bloco !== "filtro_de_spam";
  const chave = daSatisfacao ? "satisfacao" : "filtro_de_spam";
  const blocoAtual = (atuais[chave] as Record<string, unknown> | null) ?? {};
  const proximoBloco = daSatisfacao
    ? {
        ...blocoAtual,
        ligado: bloco.ligado,
        janela_horas:
          (bloco as { janela_horas?: number }).janela_horas ?? blocoAtual.janela_horas ?? JANELA_DA_NOTA_HORAS,
        pergunta: (bloco as { pergunta?: string }).pergunta ?? blocoAtual.pergunta ?? TEXTO_DA_PERGUNTA_PADRAO,
      }
    : {
        ...blocoAtual,
        ligado: bloco.ligado,
        limiar: (bloco as { limiar?: number }).limiar ?? blocoAtual.limiar ?? undefined,
      };

  const { error: erroAoGravar } = await admin
    .from("organizations")
    .update({ settings: { ...atuais, [chave]: proximoBloco } })
    .eq("id", authz.org.orgId);
  if (erroAoGravar) return fail("internal_error", erroAoGravar.message, 500, { requestId });

  await audit({
    action: daSatisfacao ? "settings.satisfacao_alterada" : "settings.filtro_de_spam_alterado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { ligado: bloco.ligado },
  });

  return ok(
    daSatisfacao
      ? { satisfacao: lerOpcaoDaSatisfacao({ satisfacao: proximoBloco }) }
      : { filtro_de_spam: lerOpcaoDoFiltroDeSpam({ filtro_de_spam: proximoBloco }) },
    { requestId },
  );
}

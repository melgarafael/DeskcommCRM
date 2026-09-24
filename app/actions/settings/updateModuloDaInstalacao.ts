"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import {
  MODULOS_OPCIONAIS,
  gravarModulo,
  moduloLigado,
} from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateModuloResult = { ok: true } | { ok: false; error: string };

const entradaSchema = z.object({
  modulo: z.enum(MODULOS_OPCIONAIS),
  ligado: z.boolean(),
});

/**
 * Liga ou desliga um MÓDULO OPCIONAL da instalação (doc 37 para o banco
 * externo; doc 24 para "todo liga/desliga tem tela").
 *
 * `is_platform_admin`, e não `admin` do tenant, pelo mesmo motivo de
 * `updateComportamento.ts`: o módulo vale para TODAS as empresas do servidor, e
 * abrir a porta de saída para o banco de outro sistema é decisão de quem
 * responde pelo servidor.
 *
 * Auditado porque "desde quando as empresas podiam ligar um banco de fora?" não
 * tem resposta em nenhuma outra tabela — a linha guarda o estado, não o
 * histórico.
 */
export async function updateModuloDaInstalacao(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdateModuloResult> {
  const { user } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const { modulo, ligado } = parsed.data;

  const db = createAdminClient();
  const antes = await moduloLigado(db, modulo);
  if (!(await gravarModulo(db, modulo, ligado, user.id))) {
    return { ok: false, error: "write_failed" };
  }

  const hdrs = await headers();
  await audit({
    action: "platform.modulo_updated",
    actorUserId: user.id,
    resourceType: "platform_config",
    metadata: { modulo, de: antes, para: ligado },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/sistema");
  return { ok: true };
}

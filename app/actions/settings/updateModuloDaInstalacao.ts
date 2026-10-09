"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import {
  MODULOS_AINDA_NAO_LIGAVEIS,
  MODULOS_OPCIONAIS_POR_FLAG,
  gravarModulo,
  moduloLigado,
} from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateModuloResult = { ok: true } | { ok: false; error: string };

// Só módulos por FLAG passam por aqui — um módulo de tabela (ADR-0002, ex. "honorarios")
// se instala em `/admin/modulos` via `fn_modulo_instalar`, nunca por este action.
const entradaSchema = z.object({
  modulo: z.enum(MODULOS_OPCIONAIS_POR_FLAG),
  ligado: z.boolean(),
});

/**
 * Liga ou desliga um MÓDULO OPCIONAL da instalação (doc 37 para o banco
 * externo; doc 24 para "todo liga/desliga tem tela").
 *
 * `is_platform_admin`, e não `admin` do tenant, pelo mesmo motivo de
 * `updateComportamento.ts`: o módulo vale para TODAS as empresas do servidor, e
 * abrir a porta de saída para o banco de outro sistema é decisão de quem
 * responde pelo servidor. A escrita passa por `escritaDeAdminOuRecusa` (regra D
 * de `admin-escrita-exige-scope-full`): a recusa de scope/MFA volta como
 * resultado para a tela, em vez de lançar ao error boundary.
 *
 * Auditado porque "desde quando as empresas podiam ligar um banco de fora?" não
 * tem resposta em nenhuma outra tabela — a linha guarda o estado, não o
 * histórico.
 *
 * Desligar a COBRANÇA (spec da cobrança do revendedor §7h) libera toda empresa
 * suspensa por falta de pagamento, por `fn_cobranca_liberar_suspensoes`, e
 * audita quantas. Nada é cancelado no provedor. A liberação roda ANTES de
 * gravar a chave: se ela falhar, a chave continua ligada e nada é gravado nem
 * auditado, e a linha continua em /admin/sistema para tentar de novo. Gravada
 * antes, a linha sumiria (travada e desligada = escondida) e as suspensas por
 * cobrança ficariam sem saída: /reactivate recusa esse tipo, e prazo/isenção
 * dão 404 com a chave desligada. Se a GRAVAÇÃO falhar depois da liberação, as
 * liberadas já saíram (cada uma com o seu `tenant.reactivated` no event_log) e
 * desligar de novo é seguro: a função é idempotente.
 */
export async function updateModuloDaInstalacao(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdateModuloResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const { modulo, ligado } = parsed.data;
  // Ligar um módulo que ainda não tem tela não daria nada usável — e, no caso
  // dos roteiros de atendimento, poria o motor no turno sem que ninguém pudesse
  // ver o que ele coleta. Desligar continua permitido.
  if (ligado && MODULOS_AINDA_NAO_LIGAVEIS.includes(modulo)) {
    return { ok: false, error: "modulo_ainda_nao_disponivel" };
  }

  const db = createAdminClient();
  const antes = await moduloLigado(db, modulo);

  let liberadas: number | null = null;
  if (modulo === "cobranca" && !ligado) {
    const { data, error } = await db.rpc("fn_cobranca_liberar_suspensoes", { p_ator: user.id });
    if (error) {
      logger.error("desligar a cobrança: a liberação das suspensas falhou; a chave segue como estava", {
        codigo: error.code,
        detalhe: error.message,
      });
      return { ok: false, error: "liberacao_falhou" };
    }
    liberadas = Number(data ?? 0);
  }

  if (!(await gravarModulo(db, modulo, ligado, user.id))) {
    if (liberadas !== null) {
      logger.error("desligar a cobrança: liberou as suspensas, mas a chave não gravou", { liberadas });
    }
    return { ok: false, error: "write_failed" };
  }

  // Entre a liberação e a gravação, uma chamada de LLM ainda via a cobrança
  // ligada e pode ter reaberto o aviso do teto do plano; com a chave já
  // desligada, ninguém mais o fecharia. Liberar de novo é idempotente. Falhar
  // aqui não desfaz nada: a chave gravou, e o primeiro passe já rodou.
  if (liberadas !== null) {
    const { data, error } = await db.rpc("fn_cobranca_liberar_suspensoes", { p_ator: user.id });
    if (error) {
      logger.warn("desligar a cobrança: a segunda liberação falhou; um aviso do plano pode ter ficado aberto", {
        codigo: error.code,
        detalhe: error.message,
      });
    } else {
      liberadas += Number(data ?? 0);
    }
  }

  const hdrs = await headers();
  const quem = {
    actorUserId: user.id,
    resourceType: "platform_config",
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  };
  await audit({ ...quem, action: "platform.modulo_updated", metadata: { modulo, de: antes, para: ligado } });
  if (liberadas !== null) {
    await audit({ ...quem, action: "cobranca.modulo_desligado", metadata: { liberadas } });
  }
  revalidatePath("/admin/sistema");

  return { ok: true };
}

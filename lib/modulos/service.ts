import "server-only";

import { z } from "zod";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { SQL_ERRORS } from "@/lib/extensions/erros-do-banco";
import { ExtensionServiceError } from "@/lib/extensions/http";

import { CATALOGO_DE_MODULOS, moduloDoCatalogo } from "./catalogo";

const operationRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  status: z.string(),
  actor_id: z.string().uuid().nullable(),
  name: z.string().nullable(),
  result: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
});

const appliedSchema = z.object({ applied_now: z.boolean() });

export interface ModuloInstaladoView {
  modulo: string;
  estado: "ativo" | "suspenso";
  instalado_em: string;
  reaplicado_em: string | null;
  motivo_suspensao: string | null;
}

export interface ModuloInstalarResultado {
  operationId: string;
  appliedNow: boolean;
}

/** Mesmo mapeamento de código de erro do banco → mensagem pública que as extensões usam: os dois
 * mecanismos passam pelo mesmo livro de recibos (`extension_operations`) e pelas mesmas funções
 * `fn_extensions_*` por baixo, então os códigos `extension_*` são os que `fn_modulo_instalar`
 * também levanta. */
function dbFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  const known = error.code === "P0001" && error.message ? SQL_ERRORS[error.message] : undefined;
  if (known && error.message) {
    throw new ExtensionServiceError(error.message, known.message, known.status);
  }
  logger.warn("[modulos] falha do banco sem código conhecido", {
    db_code: error.code ?? null,
    detail: (error.message ?? "").slice(0, 200),
  });
  throw new ExtensionServiceError(
    "upstream_unavailable",
    "Não foi possível confirmar o resultado. Consulte o histórico antes de repetir o pedido.",
    503,
  );
}

/** O catálogo (vitrine) cruzado com o que já está instalado nesta instância. */
export async function listarModulos(): Promise<{
  disponiveis: typeof CATALOGO_DE_MODULOS;
  instalados: ModuloInstaladoView[];
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("modulos_instalados")
    .select("modulo, estado, instalado_em, reaplicado_em, motivo_suspensao")
    .order("modulo", { ascending: true });
  dbFailure(error);
  return { disponiveis: CATALOGO_DE_MODULOS, instalados: (data ?? []) as ModuloInstaladoView[] };
}

/**
 * Instala um módulo NA INSTÂNCIA (ADR-0002, D3) — nunca numa organização. Idempotente pela
 * chave de operação: repetir com a mesma chave devolve o mesmo recibo sem reexecutar.
 */
export async function instalarModulo(
  actorId: string,
  operationId: string,
  modulo: string,
): Promise<ModuloInstalarResultado> {
  if (!moduloDoCatalogo(modulo)) {
    throw new ExtensionServiceError(
      "extension_module_unknown",
      SQL_ERRORS.extension_module_unknown!.message,
      SQL_ERRORS.extension_module_unknown!.status,
    );
  }

  const admin = createAdminClient();
  const resultado = await admin.rpc("fn_modulo_instalar", {
    p_actor: actorId,
    p_operation: operationId,
    p_modulo: modulo,
  });
  dbFailure(resultado.error);

  const receipt = operationRowSchema.parse(resultado.data);
  const applied = appliedSchema.parse(resultado.data).applied_now;

  if (applied) {
    await audit({
      action: "modulo.instalado",
      actorUserId: actorId,
      actingAsPlatformAdmin: true,
      resourceType: "modulos_instalados",
      resourceId: receipt.id,
      metadata: { modulo, operation_id: receipt.id },
    });
  }

  return { operationId: receipt.id, appliedNow: applied };
}

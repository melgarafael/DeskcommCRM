/**
 * Leitura administrativa restrita aos IDs que o chamador acabou de selecionar
 * de user_organizations, na organização autenticada e sem revoked_at.
 * Só rótulos da agenda: o helper global nomesDosAtendentes continua nome-only.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { identidadeDoResponsavel, type IdentidadeDaAgenda, type TraduzirIdentidade } from "./identidade-do-responsavel";

export async function rotulosDosResponsaveisDaAgenda(
  membrosAtivosAutorizados: readonly string[],
  t: TraduzirIdentidade = (texto) => texto,
): Promise<Map<string, IdentidadeDaAgenda>> {
  const ids = [...new Set(membrosAtivosAutorizados.filter((id) => typeof id === "string" && id.trim()))];
  if (!ids.length) return new Map();
  const degradar = () => new Map(ids.map((id) => [id, identidadeDoResponsavel(id, null, true, t)]));
  let admin: ReturnType<typeof createAdminClient>;
  try {
    if (!isServiceRoleConfigured()) {
      logger.info("[agenda-responsaveis] identidade indisponível", { responsaveis: ids.length });
      return degradar();
    }
    admin = createAdminClient();
  } catch {
    logger.warn("[agenda-responsaveis] leitura indisponível", { responsaveis: ids.length });
    return degradar();
  }
  let falhas = 0;
  const pares = await Promise.all(ids.map(async (id): Promise<[string, IdentidadeDaAgenda]> => {
    try {
      const { data, error } = await admin.auth.admin.getUserById(id);
      // Não atribuir a identidade de outra pessoa a este ID, mesmo em resposta inconsistente.
      if (error || !data?.user || data.user.id !== id) {
        falhas += 1;
        return [id, identidadeDoResponsavel(id, null, true, t)];
      }
      return [id, identidadeDoResponsavel(id, data.user, false, t)];
    } catch {
      falhas += 1;
      return [id, identidadeDoResponsavel(id, null, true, t)];
    }
  }));
  // Nem e-mail, nem payload/erro remoto: um erro pode conter a própria identidade.
  if (falhas) logger.warn("[agenda-responsaveis] leitura parcial", { responsaveis: ids.length, falhas });
  return new Map(pares);
}

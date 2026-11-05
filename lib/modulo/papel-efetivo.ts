/**
 * PAPEL EFETIVO DE UM TOKEN DE MÓDULO (Spec 33, F3, tarefa 4).
 *
 *   com pessoa (JWT de contexto válido):  min(teto `admin`, papel ATUAL da pessoa, lido do banco)
 *   sem pessoa:                           min(papel do token, teto `agent`)
 *
 * O teto com pessoa é `admin` (ADR-0005 D4: "papel de quem clica"; Spec 33, "Papel efetivo"): quem
 * limita o módulo é o menor entre o papel ATUAL da pessoa e as áreas consentidas. Equipe, papéis,
 * token, provedor/chave de IA, credencial, LGPD, webhook e envio NÃO têm área (`areas.ts`,
 * `SEM_AREA`), então o módulo é recusado ali qualquer que seja o papel. Antes era `manager`, uma
 * cerca a mais que travava funis, agentes e configuração, que são o trabalho do assistente.
 * Sem pessoa o módulo jamais passa de `agent`, e também nunca passa do papel do próprio
 * token (que a F2 emite como `viewer`): omissão não dá poder.
 *
 * O papel da pessoa é lido AGORA de `user_organizations` (admin client, filtro explícito de
 * organização e de pessoa, vínculo não revogado). Nada de cache, nada vem do JWT. Pessoa removida,
 * papel que não se reconhece ou erro de leitura devolvem `null`, e `null` recusa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ROLE_RANK, type Role } from "@/lib/auth/types";

export const TETO_DO_MODULO_COM_PESSOA: Role = "admin";
export const TETO_DO_MODULO_SEM_PESSOA: Role = "agent";

function ehPapel(valor: unknown): valor is Role {
  return typeof valor === "string" && Object.prototype.hasOwnProperty.call(ROLE_RANK, valor);
}

export function menorPapel(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

export interface EntradaDoPapelEfetivo {
  /** Papel do token (escopo `role:*`); a F2 emite `viewer`. */
  papelDoToken: Role;
  /** Papel ATUAL da pessoa do JWT, lido do banco; `null`/ausente = sem pessoa. */
  papelDaPessoa?: Role | null;
}

export function papelEfetivoDoModulo({ papelDoToken, papelDaPessoa }: EntradaDoPapelEfetivo): Role {
  if (papelDaPessoa) return menorPapel(TETO_DO_MODULO_COM_PESSOA, papelDaPessoa);
  return menorPapel(papelDoToken, TETO_DO_MODULO_SEM_PESSOA);
}

/** Papel atual da pessoa na organização, ou `null` (removida, revogada, desconhecido, erro). */
export async function lerPapelAtualDaPessoa(
  supabase: SupabaseClient,
  organizationId: string,
  pessoaId: string,
): Promise<Role | null> {
  try {
    const { data, error } = await supabase
      .from("user_organizations")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", pessoaId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error || !data) return null;
    const papel = (data as { role?: unknown }).role;
    return ehPapel(papel) ? papel : null;
  } catch {
    return null;
  }
}

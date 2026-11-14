"use server";

/**
 * Liga e desliga "Bloquear chamadas recebidas". O que a chave decide e por que
 * mora em `organizations.settings` está em
 * `lib/organizacao/bloqueio-de-chamadas.ts`.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirVendaPeloCanal`: pelo client de sessão, o UPDATE de um admin de tenant
 * em `organizations` casa ZERO linhas e devolve sucesso. O id vem de
 * `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  comBloqueioDeChamadas,
  comMensagemDeRecusaDeChamadas,
  MENSAGEM_DE_RECUSA_MAX,
} from "@/lib/organizacao/bloqueio-de-chamadas";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoBloqueioDeChamadas =
  | { ok: true }
  | {
      ok: false;
      error: "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required" | "erro_ao_gravar";
    };

const Entrada = z.object({
  ligar: z.boolean(),
  mensagem: z.string().max(MENSAGEM_DE_RECUSA_MAX),
});

/** `mensagem` vazia = não avisar quem ligou. */
export async function definirBloqueioDeChamadas(
  ligar: boolean,
  mensagem: string,
): Promise<ResultadoBloqueioDeChamadas> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = Entrada.safeParse({ ligar, mensagem });
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  // `settings` é jsonb compartilhado: ler, mesclar e gravar preserva o que não é nosso.
  const novo = comMensagemDeRecusaDeChamadas(
    comBloqueioDeChamadas(atual?.settings, entrada.data.ligar),
    entrada.data.mensagem,
  );
  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "calls.block_incoming_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { ligado: entrada.data.ligar, com_mensagem: entrada.data.mensagem.trim() !== "" },
  });

  revalidatePath("/app/settings/security");
  return { ok: true };
}

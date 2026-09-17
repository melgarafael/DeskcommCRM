"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import {
  MODOS_DE_CADASTRO,
  gravarModoDeCadastro,
  modoDeCadastro,
  type ModoDeCadastro,
} from "@/lib/auth/politica-de-cadastro";

export type UpdateSignupModeResult = { ok: true } | { ok: false; error: string };

/**
 * Fecha (ou reabre) o cadastro desta INSTALAÇÃO.
 *
 * ── Por que o gate é `is_platform_admin`, e não `admin` do tenant ────────────
 *
 * O objeto é a instalação inteira, não uma organização. Num revendedor que
 * hospeda várias empresas, deixar o admin de um tenant fechar o cadastro
 * impediria QUALQUER outra empresa de entrar. Mesmo argumento de
 * `updateBranding.ts` e `updateGoogleOAuth.ts`, que este arquivo espelha.
 *
 * ── Por que auditar ─────────────────────────────────────────────────────────
 *
 * "Por que ninguém mais consegue criar conta?" é uma pergunta que só tem
 * resposta aqui: não há event_log que cubra o tipo (nenhum dos handlers de
 * `register-handlers.ts` o consumiria, e evento sem consumer é o anti-pattern
 * nº 3), e a mudança não deixa rastro em nenhuma outra tabela. A trilha tem
 * consumidor real, que é `/admin/audit`.
 */
const entradaSchema = z.object({
  signup_mode: z.enum(MODOS_DE_CADASTRO as unknown as [ModoDeCadastro, ...ModoDeCadastro[]]),
});

export async function updateSignupMode(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdateSignupModeResult> {
  const { user } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  // O valor ANTERIOR entra na trilha. Sem ele a linha responde "quem mexeu" mas
  // não "o que mudou", e uma sequência de salvamentos idênticos fica
  // indistinguível de uma troca real.
  const anterior = await modoDeCadastro();

  if (!(await gravarModoDeCadastro(parsed.data.signup_mode, user.id))) {
    return { ok: false, error: "write_failed" };
  }

  const hdrs = await headers();
  await audit({
    action: "platform.signup_mode_updated",
    actorUserId: user.id,
    resourceType: "platform_settings",
    metadata: { de: anterior, para: parsed.data.signup_mode },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/cadastro");
  return { ok: true };
}

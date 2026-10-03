"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import {
  carregarComportamentoDaInstalacao,
  gravarComportamentoDaInstalacao,
} from "@/lib/instalacao/comportamento-servidor";

export type UpdateComportamentoResult = { ok: true } | { ok: false; error: string };

/**
 * Muda COMO esta instalação se comporta: orçamento de IA, assinatura do webhook
 * do canal, divulgação de pagamento e conferência de promessa (issue #1034).
 *
 * ── Por que o gate é `is_platform_admin`, e não `admin` do tenant ────────────
 *
 * O objeto é a instalação inteira, não uma organização. Num revendedor que
 * hospeda várias empresas, deixar o admin de um tenant desligar o bloqueio de
 * gasto de IA mudaria a conta de TODOS os clientes daquele servidor. Mesmo
 * argumento de `updateSignupMode.ts`, `updateBranding.ts` e
 * `updateGoogleOAuth.ts`, que este arquivo espelha.
 *
 * ── Por que auditar ─────────────────────────────────────────────────────────
 *
 * "Por que a IA continuou respondendo depois do teto?" e "por que a entrega do
 * webhook passou a ser recusada?" são perguntas que só têm resposta aqui: não
 * há event_log que cubra o tipo (nenhum handler de `register-handlers.ts` o
 * consumiria — evento sem consumer é o anti-pattern nº 3) e a mudança não deixa
 * rastro em nenhuma outra tabela. A trilha tem consumidor real: `/admin/audit`.
 */
const entradaSchema = z.object({
  orcamento_de_ia: z.enum(["on", "avisar", "off"]),
  exigir_assinatura_no_webhook: z.boolean(),
  divulgacao_de_pagamento: z.enum(["inject", "veto"]),
  promessa_semantica: z.boolean(),
});

export async function updateComportamento(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdateComportamentoResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  // O valor ANTERIOR entra na trilha. Sem ele a linha responde "quem mexeu" mas
  // não "o que mudou", e uma sequência de salvamentos idênticos fica
  // indistinguível de uma troca real.
  const anterior = await carregarComportamentoDaInstalacao();

  if (!(await gravarComportamentoDaInstalacao(parsed.data, user.id))) {
    return { ok: false, error: "write_failed" };
  }

  const hdrs = await headers();
  await audit({
    action: "platform.comportamento_updated",
    actorUserId: user.id,
    resourceType: "platform_settings",
    metadata: { de: anterior, para: parsed.data },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/sistema");
  return { ok: true };
}

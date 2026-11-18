"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ResumoDoMolde } from "@/lib/ai/molde-de-ia";
import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import type { RecusaDeEscritaDeAdmin } from "@/lib/auth/recusa-de-escrita-de-admin";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { ehOperante } from "@/lib/organizacao/operante";
import { gravarMoldeDeIa, lerMoldeDeIa, resumoDoMoldeNoBanco } from "@/lib/instalacao/molde-de-ia-servidor";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateMoldeDeIaResult =
  | { ok: true; resumo: ResumoDoMolde | null }
  | { ok: false; error: "invalid_input" | "molde_invalido" | "write_failed" }
  | RecusaDeEscritaDeAdmin;

/**
 * Escolhe a empresa cuja IA as empresas NOVAS copiam ao nascer
 * (`platform_settings.molde_de_ia_org_id`, migration 9096) — ou nenhuma.
 *
 * ── Por que uma action própria, e não um campo a mais de `updateComportamento`
 *
 * `updateComportamento` grava as quatro chaves que o MOTOR lê a cada turno, com
 * memo, piso no `.env` e leitura pegajosa (`lib/instalacao/comportamento.ts`).
 * O molde não tem nada disso: quem o lê é o gatilho do banco, no instante em
 * que uma empresa nasce, e não há `.env` que o declare. Pôr o campo naquele
 * schema obrigaria o formulário do comportamento a mandá-lo em toda gravação e
 * o worker a carregar uma coluna que ele nunca usa. A irmã exata é
 * `updateDestinosInternos`: uma coluna de `platform_settings`, mesmo gate,
 * mesma auditoria.
 *
 * ── Por que `is_platform_admin` ─────────────────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO: a escolha decide com que IA nasce toda empresa
 * deste servidor, de qualquer cliente. E ela lê a configuração de OUTRA
 * organização — só quem administra o servidor enxerga todas.
 *
 * ── Por que só empresa ATIVA ────────────────────────────────────────────────
 *
 * A tela só oferece as ativas; recusar aqui as outras é o que impede um POST
 * direto de escolher como molde uma empresa suspensa ou em exclusão. Se o molde
 * for suspenso DEPOIS, o gatilho continua copiando: a configuração de modelos
 * dele segue válida, e quem decide trocar é quem administra.
 *
 * ── Por que auditar ─────────────────────────────────────────────────────────
 *
 * A coluna guarda o estado, não o histórico: "desde quando as empresas novas
 * nascem com a IA da empresa X?" só tem resposta na trilha, que tem consumidor
 * real (`/admin/audit`). A linha leva o molde anterior e o novo, e quantas
 * funções ele copiava no momento da escolha.
 */
const entradaSchema = z.object({
  molde_de_ia_org_id: z.string().uuid().nullable(),
});

export async function updateMoldeDeIa(input: z.infer<typeof entradaSchema>): Promise<UpdateMoldeDeIaResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const moldeId = parsed.data.molde_de_ia_org_id;

  const admin = createAdminClient();

  let resumo: ResumoDoMolde | null = null;
  if (moldeId) {
    const { data: org, error } = await admin
      .from("organizations")
      .select("id, status")
      .eq("id", moldeId)
      .maybeSingle();
    if (error) return { ok: false, error: "write_failed" };
    if (!org || !ehOperante((org as { status: string | null }).status)) {
      return { ok: false, error: "molde_invalido" };
    }
    resumo = await resumoDoMoldeNoBanco(admin, moldeId);
  }

  const anterior = await lerMoldeDeIa(admin);

  if (!(await gravarMoldeDeIa(admin, moldeId, user.id))) {
    return { ok: false, error: "write_failed" };
  }

  const hdrs = await headers();
  await audit({
    action: "platform.molde_de_ia_updated",
    actorUserId: user.id,
    resourceType: "platform_settings",
    metadata: {
      // `undefined` = não deu para ler o anterior; a linha diz isso em vez de
      // afirmar "não havia molde".
      de: anterior === undefined ? "nao_lido" : anterior,
      para: moldeId,
      funcoes: resumo?.funcoes ?? 0,
      padrao: resumo?.padrao ?? null,
    },
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/sistema");
  return { ok: true, resumo };
}

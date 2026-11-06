"use server";

/**
 * Cadastra a META MENSAL da empresa para um indicador (issue #3025, fatia 1).
 *
 * ─── O que esta action resolve ──────────────────────────────────────────────
 * A tela de Desempenho só mostrava o realizado. O alvo existia na cabeça de
 * quem cobra o time: aqui ele passa a ser LINHA (`crm_metas`, migration 0756),
 * com mês, indicador e alvo — e a leitura do progresso vira conta, não memória.
 *
 * ─── Quem escreve, e por quê ────────────────────────────────────────────────
 * `manager+`, o mesmo grau de `definirMeetAberto` e da porta da tela
 * (`minRole: "manager"`): o alvo é o número pelo qual a empresa cobra
 * o próprio time, e quem o define não é quem o persegue. A RLS da tabela cobra
 * o mesmo papel — duas linhas de defesa, e a de baixo é a que vale.
 *
 * A organização vem SEMPRE do cookie validado (`resolveActiveOrg`), nunca do
 * corpo: o input não tem `organization_id`, e não pode ter.
 *
 * ─── Gravar de novo é CORRIGIR, não duplicar ────────────────────────────────
 * O `upsert` com `onConflict` não serve aqui: o índice que garante "uma meta da
 * empresa por mês" é PARCIAL (`where pipeline_id is null`), e o alvo do
 * `on-conflict` do PostgREST tem de casar com um índice íntegro. Então a action
 * lê a linha do mês e atualiza se existir, insere se não existir — a mesma
 * forma da semente do invariante de RLS. Sem isso, cadastrar duas vezes o mesmo
 * mês ou duplicava a linha, ou estourava o índice na cara de quem salvou.
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { ROLE_RANK } from "@/lib/auth/types";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";

export type DefinirMetaMensalResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
      details?: unknown;
    };

/** O único indicador desta fatia: quantidade de vendas ganhas. */
const INDICADOR_DA_FATIA = "vendas_ganhas" as const;

const entradaSchema = z.object({
  // 'YYYY-MM': o mês é o que a pessoa escolhe; o DIA é sempre o 1º, e quem
  // garante isso é a action (a constraint da tabela recusa qualquer outro).
  periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido"),
  indicador: z.literal(INDICADOR_DA_FATIA).default(INDICADOR_DA_FATIA),
  alvo: z.number().int().min(1).max(1_000_000),
});

export type DefinirMetaMensalInput = z.input<typeof entradaSchema>;

export async function definirMetaMensal(
  input: DefinirMetaMensalInput,
): Promise<DefinirMetaMensalResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  // O piso é `manager`, não o `admin` de `podeAdministrarEmpresa`: o gerente que a
  // porta, a página e a RLS deixam entrar não pode ver o formulário recusar o
  // salvar. A regra única segue valendo para o atalho do dono da instalação
  // (scope `full`, fora do suporte), o mesmo que a RLS aceita.
  if (!podeAdministrarEmpresa(authUser, activeOrg) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const supabase = await createClient();
  const orgId = activeOrg.orgId;
  const { periodo, indicador, alvo } = parsed.data;
  const primeiroDia = `${periodo}-01`;

  // A linha do mês, na organização ativa. `pipeline_id is null` é a meta da
  // EMPRESA — o recorte por funil é a fatia seguinte e não é gravado aqui.
  const { data: existente, error: erroLeitura } = await supabase
    .from("crm_metas")
    .select("id, alvo")
    .eq("organization_id", orgId)
    .eq("periodo", primeiroDia)
    .eq("indicador", indicador)
    .is("pipeline_id", null)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar", details: erroLeitura.message };

  const alvoAnterior = ((existente as { alvo?: number } | null)?.alvo ?? null) as number | null;

  if (existente) {
    const { error } = await supabase
      .from("crm_metas")
      .update({ alvo, updated_at: new Date().toISOString() })
      .eq("id", (existente as { id: string }).id)
      .eq("organization_id", orgId);
    if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };
  } else {
    const { error } = await supabase.from("crm_metas").insert({
      organization_id: orgId,
      periodo: primeiroDia,
      indicador,
      pipeline_id: null,
      alvo,
      created_by: authUser.id,
    });
    if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };
  }

  const hdrs = await headers();
  await audit({
    action: existente ? "crm_meta.updated" : "crm_meta.created",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "crm_meta",
    // Sem id na criação (o PostgREST não devolve a linha no insert sem
    // `select`); o que identifica o alvo é o par período + indicador.
    resourceId: (existente as { id?: string } | null)?.id ?? null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: ipDoCliente(hdrs) ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: {
      periodo: primeiroDia,
      indicador,
      alvo,
      // O alvo ANTERIOR entra: é a mudança que interessa a quem audita depois —
      // "de 40 para 25" é uma história diferente de "criou 25".
      alvo_anterior: alvoAnterior,
    },
  });

  revalidatePath("/app/settings/metas");
  revalidatePath("/app/metrics");
  return { ok: true };
}

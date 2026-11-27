"use server";

/**
 * As metas JÁ GRAVADAS de um mês, para o formulário de Configurações › Meta de
 * vendas mostrar a que existe quando a pessoa troca o mês (#4796).
 *
 * A página entrega só as metas do mês em que abriu. Trocar o mês no formulário
 * mostrava o alvo DESTE mês no campo do outro — e salvar gravava esse número
 * lá, por cima da meta que já existisse. Pré-carregar "todos os meses" esbarra
 * no teto de linhas do PostgREST numa equipe grande; ler o mês pedido, sob
 * demanda, não esbarra.
 *
 * Mesma régua de quem lê a página: sessão, organização ativa (nunca do input) e
 * `manager+` — quem não pode definir a meta também não precisa deste atalho.
 * A RLS de `crm_metas` continua sendo a defesa de baixo.
 */
import { z } from "zod";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

export interface MetaDoMesGravada {
  periodo: string;
  indicador: "vendas_ganhas" | "valor_vendido";
  vendedor_id: string | null;
  pipeline_id: string | null;
  alvo: number;
}

export type LerMetasDoMesResult =
  | { ok: true; metas: MetaDoMesGravada[] }
  | { ok: false; error: "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "erro_ao_ler" };

const periodoSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export async function lerMetasDoMes(periodo: string): Promise<LerMetasDoMesResult> {
  const parsed = periodoSchema.safeParse(periodo);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    return { ok: false, error: "forbidden_role" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_metas")
    .select("indicador, vendedor_id, pipeline_id, alvo")
    .eq("organization_id", activeOrg.orgId)
    .eq("periodo", `${parsed.data}-01`);
  if (error) return { ok: false, error: "erro_ao_ler" };

  const metas = (
    (data ?? []) as Array<{ indicador: string; vendedor_id: string | null; pipeline_id: string | null; alvo: number }>
  )
    .filter((m) => m.indicador === "vendas_ganhas" || m.indicador === "valor_vendido")
    .map((m) => ({
      periodo: parsed.data,
      indicador: m.indicador as "vendas_ganhas" | "valor_vendido",
      vendedor_id: m.vendedor_id ?? null,
      pipeline_id: m.pipeline_id ?? null,
      alvo: Number(m.alvo),
    }));
  return { ok: true, metas };
}

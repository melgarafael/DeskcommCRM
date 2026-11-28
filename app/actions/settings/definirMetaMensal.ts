"use server";

/**
 * Cadastra a META MENSAL da empresa para um indicador (issue #3025, fatia 1;
 * meta em VALOR na #4796).
 *
 * ─── O que esta action resolve ──────────────────────────────────────────────
 * A tela de Desempenho só mostrava o realizado. O alvo existia na cabeça de
 * quem cobra o time: aqui ele passa a ser LINHA (`crm_metas`, migration 0756),
 * com mês, indicador e alvo — e a leitura do progresso vira conta, não memória.
 *
 * ─── DOIS indicadores agora, e o antigo não muda de régua ──────────────────
 * `vendas_ganhas` (quantidade) segue sendo o DEFAULT: meta antiga, gravada
 * antes do campo existir, continua valendo por quantidade — trocar o default
 * mudaria o número que quem já usa vê. `valor_vendido` grava o alvo em CENTAVOS
 * (a unidade de `crm_leads.value_cents`), porque R$ 500.000,00 em reais
 * quebrados não cabe numa coluna inteira com centavo. A tela digita em reais e
 * converte aqui mesmo, com `Math.round`.
 *
 * ─── Três níveis: empresa, funil e vendedor ────────────────────────────────
 * `pipeline_id` nulo e `vendedor_id` nulo é a meta da EMPRESA; `pipeline_id`
 * preenchido é a do funil; `vendedor_id` preenchido é a do vendedor. Os três
 * são gravados aqui (o funil desde a #4796; a leitura e o Desempenho já o
 * entendiam). A meta do vendedor não aceita funil junto: duas dimensões na mesma
 * linha tornariam "a meta do vendedor" ambígua (é a constraint
 * `crm_metas_dono_ou_funil`), e a recusa sai aqui, antes do banco.
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
        | "vendedor_fora_da_equipe"
        | "funil_invalido"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
      details?: unknown;
    };

/**
 * O teto do alvo por indicador. Quantidade é venda contada (1 milhão já é
 * absurdo); valor é centavo, e o teto cabe no `integer` da coluna
 * (2.147.483.647) com folga para R$ 20 milhões.
 */
const TETO_DA_QUANTIDADE = 1_000_000;
const TETO_DO_VALOR_EM_CENTAVOS = 2_000_000_000;

const entradaSchema = z
  .object({
    // 'YYYY-MM': o mês é o que a pessoa escolhe; o DIA é sempre o 1º, e quem
    // garante isso é a action (a constraint da tabela recusa qualquer outro).
    periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido"),
    // Sem indicador = quantidade: é o que a meta antiga significa.
    indicador: z.enum(["vendas_ganhas", "valor_vendido"]).default("vendas_ganhas"),
    // Nulo = meta da empresa; preenchido = meta daquele vendedor.
    vendedor_id: z.string().uuid().nullish(),
    // Preenchido = meta daquele funil (#4796). Nunca junto com vendedor.
    pipeline_id: z.string().uuid().nullish(),
    alvo: z.number().int().min(1),
  })
  .superRefine((valor, ctx) => {
    if (valor.vendedor_id && valor.pipeline_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pipeline_id"],
        message: "A meta é do vendedor ou do funil, não dos dois",
      });
    }
    const teto =
      valor.indicador === "valor_vendido" ? TETO_DO_VALOR_EM_CENTAVOS : TETO_DA_QUANTIDADE;
    if (valor.alvo > teto) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alvo"],
        message: "Alvo acima do teto do indicador",
      });
    }
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
  const vendedorId = parsed.data.vendedor_id ?? null;
  const pipelineId = parsed.data.pipeline_id ?? null;
  const primeiroDia = `${periodo}-01`;

  // O vendedor tem de ser MEMBRO ATIVO da organização: a FK só garante que o id
  // existe em `auth.users`, e a meta individual é de alguém DESTA empresa que
  // ainda está nela (vínculo revogado não conta). A recusa tem código PRÓPRIO
  // (#4986): com `validation_failed` a tela dizia "o mês e o alvo precisam estar
  // preenchidos", com os dois preenchidos.
  if (vendedorId) {
    const { data: membro, error: erroMembro } = await supabase
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", orgId)
      .eq("user_id", vendedorId)
      .is("revoked_at", null)
      .maybeSingle();
    if (erroMembro) return { ok: false, error: "erro_ao_gravar", details: erroMembro.message };
    if (!membro) {
      return { ok: false, error: "vendedor_fora_da_equipe" };
    }
  }

  // O funil tem de ser DESTA organização e estar em uso: o id vem do
  // formulário, e a FK só garante que ele existe em algum lugar. Arquivado não
  // recebe meta nova (some do seletor; a meta antiga dele continua lida).
  if (pipelineId) {
    const { data: funil, error: erroFunil } = await supabase
      .from("crm_pipelines")
      .select("id")
      .eq("id", pipelineId)
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .maybeSingle();
    if (erroFunil) return { ok: false, error: "erro_ao_gravar", details: erroFunil.message };
    if (!funil) return { ok: false, error: "funil_invalido" };
  }

  // A linha do mês, na organização ativa, pela MESMA chave do índice único
  // parcial que vale para o dono: empresa (funil e vendedor nulos), vendedor ou
  // funil — mês + indicador + dono.
  const lerMeta = () => {
    let consulta = supabase
      .from("crm_metas")
      .select("id, alvo")
      .eq("organization_id", orgId)
      .eq("periodo", primeiroDia)
      .eq("indicador", indicador);
    consulta = pipelineId ? consulta.eq("pipeline_id", pipelineId) : consulta.is("pipeline_id", null);
    consulta = vendedorId
      ? consulta.eq("vendedor_id", vendedorId)
      : consulta.is("vendedor_id", null);
    return consulta.maybeSingle();
  };
  const { data: existente, error: erroLeitura } = await lerMeta();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar", details: erroLeitura.message };

  // Quem foi de fato corrigido (a linha lida, ou a que outra pessoa acabou de
  // criar na corrida do índice) — é ela que o audit conta.
  let corrigida = existente as { id: string; alvo?: number } | null;

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
      pipeline_id: pipelineId,
      vendedor_id: vendedorId,
      alvo,
      created_by: authUser.id,
    });
    // Duas pessoas salvando a PRIMEIRA meta da mesma chave ao mesmo tempo: as
    // duas leram "não existe", e o índice único barra a segunda. Ela não é um
    // erro de quem salvou — é a correção da meta que acabou de nascer.
    if (error && (error as { code?: string }).code === "23505") {
      const { data: nascida, error: erroReleitura } = await lerMeta();
      if (erroReleitura || !nascida) {
        return { ok: false, error: "erro_ao_gravar", details: erroReleitura?.message ?? error.message };
      }
      const { error: erroCorrecao } = await supabase
        .from("crm_metas")
        .update({ alvo, updated_at: new Date().toISOString() })
        .eq("id", (nascida as { id: string }).id)
        .eq("organization_id", orgId);
      if (erroCorrecao) return { ok: false, error: "erro_ao_gravar", details: erroCorrecao.message };
      corrigida = nascida as { id: string; alvo?: number };
    } else if (error) {
      return { ok: false, error: "erro_ao_gravar", details: error.message };
    }
  }

  const hdrs = await headers();
  await audit({
    action: corrigida ? "crm_meta.updated" : "crm_meta.created",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "crm_meta",
    // Sem id na criação (o PostgREST não devolve a linha no insert sem
    // `select`); o que identifica o alvo é o par período + indicador.
    resourceId: corrigida?.id ?? null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: ipDoCliente(hdrs) ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: {
      periodo: primeiroDia,
      indicador,
      alvo,
      vendedor_id: vendedorId,
      pipeline_id: pipelineId,
      // O alvo ANTERIOR entra: é a mudança que interessa a quem audita depois —
      // "de 40 para 25" é uma história diferente de "criou 25".
      alvo_anterior: corrigida?.alvo ?? null,
    },
  });

  revalidatePath("/app/settings/metas");
  revalidatePath("/app/metrics");
  return { ok: true };
}

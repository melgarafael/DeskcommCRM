"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { proximaExecucao } from "@/lib/agencia/tarefas/regras";
import { PADROES, PRIORIDADES } from "@/lib/agencia/tarefas/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

/** Tarefas recorrentes (docs/agencia/SPEC-tarefas.md, T9). Exige `tarefas.atribuir`. */

const recorrenteSchema = z
  .object({
    id: z.string().uuid().optional(),
    titulo: z.string().trim().min(2, "Dê um título.").max(200),
    descricao: z.string().trim().max(4000).nullable().optional(),
    clienteId: z.string().uuid().nullable(),
    funcaoId: z.string().uuid().nullable(),
    prioridade: z.enum(PRIORIDADES),
    padrao: z.enum(PADROES),
    diasSemana: z.array(z.number().int().min(0).max(6)).max(7),
    diaDoMes: z.number().int().min(1).max(31).nullable(),
    hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida."),
    prazoEmHoras: z.number().int().min(1).max(24 * 60).nullable(),
    inicio: z.string().date(),
    fim: z.string().date().nullable(),
    ativa: z.boolean(),
    responsaveis: z.array(z.string().uuid()).max(20),
    etiquetas: z.array(z.string().uuid()).max(20),
  })
  .refine((r) => r.padrao !== "semanal" || r.diasSemana.length > 0, { message: "Escolha os dias da semana.", path: ["diasSemana"] })
  .refine((r) => r.padrao !== "mensal" || r.diaDoMes !== null, { message: "Escolha o dia do mês.", path: ["diaDoMes"] })
  .refine((r) => !r.fim || r.fim >= r.inicio, { message: "O fim vem antes do início.", path: ["fim"] });
export type EntradaDaRecorrente = z.input<typeof recorrenteSchema>;

export async function salvarRecorrente(entrada: EntradaDaRecorrente): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("tarefas.atribuir");
    const p = recorrenteSchema.safeParse(entrada);
    if (!p.success) return { ok: false, erro: primeiroErro(p.error) };
    const d = p.data;
    const proxima = d.ativa
      ? proximaExecucao(
          { padrao: d.padrao, diasSemana: d.diasSemana, diaDoMes: d.diaDoMes, hora: d.hora, inicio: d.inicio, fim: d.fim },
          new Date(),
        )
      : null;
    const linha = {
      titulo: d.titulo,
      descricao: d.descricao ?? null,
      cliente_id: d.clienteId,
      funcao_id: d.funcaoId,
      prioridade: d.prioridade,
      padrao: d.padrao,
      dias_semana: d.padrao === "semanal" ? d.diasSemana : [],
      dia_do_mes: d.padrao === "mensal" ? d.diaDoMes : null,
      hora: d.hora,
      prazo_em_horas: d.prazoEmHoras,
      inicio: d.inicio,
      fim: d.fim,
      ativa: d.ativa && proxima !== null,
      proxima_execucao: proxima?.toISOString() ?? null,
    };
    const db = createAdminClient();
    let id = d.id;
    if (id) {
      const { error } = await db.from("agencia_tarefas_recorrentes").update(linha).eq("id", id);
      if (error) return { ok: false, erro: "Não deu para salvar. Tente de novo." };
      await auditarAgencia("agencia.recorrente_alterada", ctx.user.id, { tipo: "agencia_recorrente", id });
    } else {
      const { data, error } = await db.from("agencia_tarefas_recorrentes").insert({ ...linha, criada_por: ctx.user.id }).select("id").single();
      if (error || !data) return { ok: false, erro: "Não deu para salvar. Tente de novo." };
      id = (data as { id: string }).id;
      await auditarAgencia("agencia.recorrente_criada", ctx.user.id, { tipo: "agencia_recorrente", id });
    }
    await Promise.all([
      db.from("agencia_recorrentes_responsaveis").delete().eq("recorrente_id", id),
      db.from("agencia_recorrentes_etiquetas").delete().eq("recorrente_id", id),
    ]);
    await Promise.all([
      d.responsaveis.length
        ? db.from("agencia_recorrentes_responsaveis").insert(d.responsaveis.map((membro_id) => ({ recorrente_id: id, membro_id })))
        : null,
      d.etiquetas.length
        ? db.from("agencia_recorrentes_etiquetas").insert(d.etiquetas.map((etiqueta_id) => ({ recorrente_id: id, etiqueta_id })))
        : null,
    ]);
    revalidatePath("/agencia/tarefas/recorrentes");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

export async function excluirRecorrente(id: string): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("tarefas.atribuir");
    if (!idSchema.safeParse(id).success) return { ok: false, erro: "Recorrente inválida." };
    // As tarefas já geradas ficam: `recorrente_id` vira nulo (on delete set null).
    const { error } = await createAdminClient().from("agencia_tarefas_recorrentes").delete().eq("id", id);
    if (error) return { ok: false, erro: "Não deu para excluir." };
    await auditarAgencia("agencia.recorrente_alterada", ctx.user.id, { tipo: "agencia_recorrente", id }, { excluida: true });
    revalidatePath("/agencia/tarefas/recorrentes");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

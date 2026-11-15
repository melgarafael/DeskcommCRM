/**
 * O NEGÓCIO E O CONTATO A QUE UMA TAREFA PODE SER PRESA.
 *
 * `crm_tasks.lead_id` e `contact_id` têm chave estrangeira simples, e a
 * conferência de chave estrangeira do Postgres não passa pela RLS: o banco
 * recusa um id inexistente, mas aceita o de QUALQUER organização. Pela sessão a
 * RLS da leitura esconde o vínculo; pelo token o client é service-role e nada
 * esconde. A régua mora aqui, como a da demanda em `demanda.ts`, e vale igual
 * para os dois caminhos.
 *
 * A organização vai no SQL (`where organization_id = $1`, parâmetro vinculado):
 * o pool não passa por RLS, então o filtro explícito é a única barreira —
 * provado contra Postgres real em `tests/invariants/tarefas-piloto-pg.test.ts`.
 */
import type { Db } from "@/lib/db";

export type VereditoDoVinculo = "aceito" | "fora_da_organizacao" | "falha_na_consulta";

export async function conferirNegocioEContato(
  db: Db,
  organizationId: string,
  vinculos: { lead_id?: string | null; contact_id?: string | null },
): Promise<VereditoDoVinculo> {
  const conferencias: Array<[tabela: "crm_leads" | "contacts", id: string]> = [];
  if (vinculos.lead_id) conferencias.push(["crm_leads", vinculos.lead_id]);
  if (vinculos.contact_id) conferencias.push(["contacts", vinculos.contact_id]);

  try {
    for (const [tabela, id] of conferencias) {
      const linha = await db.queryOne<{ id: string }>(
        `select id from ${tabela} where organization_id = $1 and id = $2 limit 1`,
        [organizationId, id],
      );
      if (!linha) return "fora_da_organizacao";
    }
    return "aceito";
  } catch {
    // Sem resposta do banco não há como afirmar que o vínculo é desta
    // organização: falha FECHADA, e o handler traduz em 500.
    return "falha_na_consulta";
  }
}

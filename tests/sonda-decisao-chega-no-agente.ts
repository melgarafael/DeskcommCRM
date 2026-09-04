/**
 * Wave 4, bloco 4.5 — a decisão humana CHEGA no turno do agente.
 *
 * A prova não é o campo existir: é o VALOR chegar. Gravar a recusa só serve
 * para alguma coisa se o próximo turno a enxergar — do contrário é evento sem
 * consumer, e o agente repropõe exatamente o que o humano acabou de negar.
 *
 * Por isso a sonda chama `getLeadContext`, a MESMA função que monta o payload
 * entregue ao modelo, contra o banco real — e confere o payload serializado,
 * que é o que o modelo de fato lê.
 *
 * Run: npx tsx tests/sonda-decisao-chega-no-agente.ts
 */

import { Pool } from "pg";

import { getLeadContext } from "../lib/agent-engine/edge/crm/get-lead-context";
import { carimbar } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

carimbar([
  "tests/sonda-decisao-chega-no-agente.ts",
  "lib/agent-engine/edge/crm/get-lead-context.ts",
  "app/api/v1/leads/[id]/next-action/route.ts",
]);

const DB = carregarEnvLocal().SUPABASE_DB_URL!;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DB });
  try {
    // Alvo: um contato sobre o qual um humano JÁ decidiu — a decisão veio da
    // interface, na sonda anterior, não de um insert de teste.
    const { rows } = await pool.query<{
      organization_id: string;
      contact_id: string;
      type: string;
      reason: string;
    }>(
      `select organization_id, contact_id, type, reason
       from crm_lead_activities
       where type in ('next_action_approved', 'next_action_dismissed')
       order by performed_at desc
       limit 1`,
    );
    const decidida = rows[0];
    if (!decidida) throw new Error("nenhuma decisão humana no banco — rode a sonda-proxima-acao antes");
    console.info(`decisão registrada: ${decidida.type} — "${decidida.reason}"`);

    const resultado = await getLeadContext(
      pool,
      {} as never,
      { tenantId: decidida.organization_id, leadId: decidida.contact_id, fuso: "America/Sao_Paulo" },
      { historyLimit: 20, maxTokens: 1_000 },
    );
    if (!resultado.ok) throw new Error(`getLeadContext falhou: ${resultado.error.message}`);

    // `?? null` e não `!`: o campo é opcional no tipo, e a diferença entre
    // AUSENTE e NULO é justamente o que a perna 1 mede.
    const decisao = resultado.context.last_human_decision ?? null;
    const chavePresente = "last_human_decision" in resultado.context;
    const serializado = JSON.stringify(resultado.context);

    console.info(
      `1. o contexto do turno traz a decisão: ${decisao !== null} (chave presente: ${chavePresente})`,
    );
    if (decisao) {
      console.info(`   ação: "${decisao.action}"`);
      console.info(`   decisão: ${decisao.decision} · quando: ${decisao.at}`);
    }
    // O que o MODELO lê é o payload serializado — se o campo existisse mas
    // caísse no corte de orçamento, o turno seguiria cego do mesmo jeito.
    const noPayload = decisao !== null && serializado.includes(decisao.action);
    console.info(`2. a ação aparece no payload que vai ao modelo: ${noPayload}`);
    console.info(`   (payload com ${resultado.tokenCount} tokens estimados)`);

    const esperado =
      decidida.type === "next_action_approved" ? "approved" : "dismissed";
    const coerente = decisao?.decision === esperado;
    console.info(`3. o sentido da decisão bate com o que o humano fez: ${coerente}`);

    const passou = chavePresente && decisao !== null && noPayload && coerente;
    console.info(
      passou
        ? "PASS   a decisão humana chega no turno do agente"
        : "FALHA  a decisão não chega — o agente reproporia o que foi negado",
    );
    if (!passou) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();

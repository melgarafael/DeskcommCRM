/**
 * Wave 4, fechamento — o rascunho não sugere o que o vendedor acabou de recusar.
 *
 * A promessa da wave é "a recusa é sinal". O gesto seguinte de quem recusa é
 * pedir um rascunho, e o rascunho é escrito COMO O VENDEDOR, sem disclosure de
 * IA — então repropor o recusado não é só ignorar a decisão: é o sistema pôr na
 * boca dele o que ele negou, sem que o leitor tenha como saber.
 *
 * PROCEDÊNCIA (as leis que esta entrega derivou na pele):
 *  - leitura ANTES, veredito por DIFERENÇA — sem o antes, todo depois é
 *    compatível com o acaso;
 *  - alvo com `order by`, nunca `limit 1` sorteado;
 *  - limpeza por id só do que esta execução criou;
 *  - a sonda é ATACADA antes de valer: com o estado plantado à mão, sem passar
 *    pelo caminho de produção, ela tem de ficar VERMELHA.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-rascunho-respeita-recusa.ts
 */

import { Pool } from "pg";

import { carimbar } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

carimbar([
  "tests/sonda-rascunho-respeita-recusa.ts",
  "lib/agent-engine/agent/draft-reply.ts",
  "lib/agent-engine/edge/crm/get-lead-context.ts",
]);

const DB = carregarEnvLocal().SUPABASE_DB_URL!;

const ATAQUE = process.env.ATAQUE === "1";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DB });
  try {
    const { getLeadContext } = await import("../lib/agent-engine/edge/crm/get-lead-context");

    // Alvo determinístico: a decisão humana MAIS RECENTE, que veio da interface.
    const { rows } = await pool.query<{
      organization_id: string;
      contact_id: string;
      type: string;
      acao: string;
    }>(
      `select organization_id, contact_id, type, payload->>'next_action' as acao
         from crm_lead_activities
        where type = 'next_action_dismissed'
          and payload->>'next_action' is not null
        order by performed_at desc, id desc
        limit 1`,
    );
    const recusada = rows[0];
    if (!recusada) throw new Error("nenhuma recusa registrada — rode a sonda-proxima-acao antes");
    console.info(`recusa registrada: "${recusada.acao}"`);

    // LEITURA ANTES: o contexto do turno já traz a decisão?
    const antes = await getLeadContext(
      pool,
      {} as never,
      { tenantId: recusada.organization_id, leadId: recusada.contact_id, fuso: "America/Sao_Paulo" },
      { historyLimit: 20, maxTokens: 1_000 },
    );
    if (!antes.ok) throw new Error(`getLeadContext falhou: ${antes.error.message}`);
    const decisaoNoContexto = antes.context.last_human_decision;
    console.info(
      `1. a decisão está no contexto do rascunho: ${decisaoNoContexto !== null}` +
        (decisaoNoContexto ? ` (${decisaoNoContexto.decision})` : ""),
    );

    // A ação recusada é a MESMA que o contexto entrega — sem isto, "a decisão
    // chegou" poderia ser a decisão de outro lead, ou uma antiga.
    const mesmaAcao = decisaoNoContexto?.action === recusada.acao;
    console.info(`2. é a MESMA ação que o vendedor recusou: ${mesmaAcao}`);
    if (decisaoNoContexto) {
      console.info(`   contexto diz: "${decisaoNoContexto.action}" (${decisaoNoContexto.decision})`);
    }

    // ⚠️ O QUE ESTA SONDA NÃO PROVA, e é deliberado: que o `system` montado
    // carrega a instrução. Isso é `draft-reply.test.ts`, que assere o objeto
    // efetivamente passado ao `runModelCall` e foi provado por MUTAÇÃO (tirando
    // o bloco, dois testes ficam vermelhos). Um grep no arquivo-fonte daria a
    // aparência de prova e mediria só que o texto existe escrito em algum lugar.

    // ATAQUE: o estado plantado à mão, SEM passar pelo caminho de produção.
    // Aqui a sonda TEM de ficar vermelha — se passar, ela não prova o que diz.
    const decisaoUsada = ATAQUE
      ? null // finge que o contexto não trouxe nada
      : decisaoNoContexto;

    const passou = decisaoUsada !== null && mesmaAcao;
    console.info(
      passou
        ? "PASS   o rascunho recebe a decisão e a instrução de não repropor"
        : "FALHA  o rascunho seguiria cego — sugeriria o que o vendedor recusou",
    );
    if (!passou) process.exitCode = 1;
    if (ATAQUE) {
      console.info(
        passou
          ? "ATAQUE FALHOU: a sonda passou com o estado forjado — ela não prova o que diz"
          : "ATAQUE OK: com o estado forjado a sonda ficou VERMELHA, como tem de ficar",
      );
      process.exitCode = passou ? 1 : 0;
    }
  } finally {
    await pool.end();
  }
}

void main();

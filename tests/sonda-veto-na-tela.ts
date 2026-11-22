/**
 * Sonda do orquestrador — cenário 11: a decisão de NÃO enviar aparece na tela?
 *
 * O cenário mistura duas coisas, e elas têm provas diferentes:
 *   A DECISÃO de vetar  -> já provada pelo invariante (veto-activity.test.ts),
 *                          que roda o código real contra Postgres real.
 *   A EXIBIÇÃO do veto  -> nunca provada, porque NUNCA houve um veto neste
 *                          banco: zero linhas `send_vetoed`.
 *
 * Por isso a sonda chama `emitVetoActivity`, **o emissor de produção**, com um
 * pool real: a linha nasce do mesmo código que nasceria num veto de verdade.
 * Escrever a linha com INSERT à mão provaria a tela e mentiria sobre a origem.
 *
 * ⚠️ E POR ISSO ELA PRECISA LIMPAR O QUE ESCREVEU. Achado do @MaestroConexoes:
 * a primeira versão deixava a linha para sempre, num lead REAL que três sessões
 * usam — dizendo "Não enviei: limite de ritmo atingido" para um envio que nunca
 * foi tentado. Contaminação pior que a de uma sonda comum: esta foi **feita para
 * ser vista**, então apareceria em qualquer print futuro daquele contato. O
 * `traceId` é único por execução e serve de gancho exato para desfazer.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-veto-na-tela.ts
 */
import { randomUUID } from "node:crypto";

import { chromium } from "@playwright/test";
import pg from "pg";

import { emitVetoActivity } from "@/lib/leads/veto-activity";
import { BASE, CREDS, EVIDENCE, login, shotPage } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();

/**
 * A org sai do arquivo que o seed gera, NÃO de um literal. Cravar o UUID faria
 * a sonda só funcionar neste banco — e o projeto é aberto: quem clonasse
 * receberia "sem lead aberto" sem entender por quê. É a mesma proibição que a
 * doutrina de migrations já faz ("não hardcode IDs do seu tenant").
 */
const ORG = CREDS.org_id as string;

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL });
  const traceId = randomUUID();
  let emitiu = false;

  try {
    // Contato que TEM negócio aberto — senão o veto cai em `activity_unrouted`
    // (o comportamento correto quando não há onde pendurar) e não haveria linha
    // na timeline para olhar. O alvo é o caso roteado.
    const { rows } = await pool.query(
      `select l.organization_id, l.contact_id, l.id as lead_id
         from crm_leads l
        where l.contact_id is not null and l.status = 'open'
          and l.organization_id = $1
        limit 1`,
      [ORG],
    );
    const alvo = rows[0];
    if (!alvo) throw new Error("sem lead aberto com contato na org de e2e");

    const { rows: agentes } = await pool.query(
      `select id from ai_agents where organization_id = $1 limit 1`,
      [ORG],
    );

    const r = await emitVetoActivity({
      pool,
      organizationId: alvo.organization_id,
      contactId: alvo.contact_id,
      traceId,
      gate: "pacing",
      code: "rate_limited",
      agentId: agentes[0]?.id ?? null,
    });
    emitiu = true;
    console.info(`emissor de produção devolveu: ${JSON.stringify(r)}`);

    const browser = await chromium.launch();
    const page = await browser
      .newContext({ viewport: { width: 1440, height: 900 } })
      .then((c) => c.newPage());
    await login(page, "admin");
    await page.goto(`${BASE}/app/contacts/${alvo.contact_id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "Linha do tempo" }).click();

    // Aceita os DOIS desfechos: sem o `or`, uma falha viraria timeout de 15s em
    // vez de veredito — o teste diria "demorou" onde devia dizer "não apareceu".
    const painel = page.locator("main");
    await painel
      .getByText(/Envio bloqueado|Nenhuma atividade registrada/)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    const texto = await painel.innerText();
    await shotPage(page, "wave-3-c11-veto-na-tela.png");
    await browser.close();

    const rotulado = /Envio bloqueado/.test(texto);
    const comMotivo = /Não enviei/.test(texto);
    const semUuid = !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(texto);

    console.info(`rótulo em pt-BR ("Envio bloqueado"): ${rotulado ? "SIM" : "NÃO"}`);
    console.info(`motivo legível na linha: ${comMotivo ? "SIM" : "NÃO"}`);
    console.info(`sem UUID visível: ${semUuid ? "SIM" : "NÃO"}`);
    console.info(`print: ${EVIDENCE}/wave-3-c11-veto-na-tela.png`);

    // `comMotivo` ENTRA na decisão. Antes ele era impresso e ignorado: a sonda
    // podia dizer "motivo legível: NÃO" e sair com código zero — um verde que
    // não cobria o que parecia cobrir.
    if (!(rotulado && comMotivo && semUuid)) process.exitCode = 1;
  } finally {
    if (emitiu) {
      const { rowCount } = await pool.query(
        `delete from crm_lead_activities where type = 'send_vetoed' and source_id = $1`,
        [traceId],
      );
      console.info(`limpeza: ${rowCount} linha(s) desta execução removida(s) da timeline`);
    }
    await pool.end();
  }
}

void main();

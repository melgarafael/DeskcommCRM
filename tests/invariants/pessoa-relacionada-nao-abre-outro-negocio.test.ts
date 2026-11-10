import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

/**
 * A PESSOA RELACIONADA ACHA O NEGÓCIO DO CLIENTE (#3669, fatia 1; migration 9045).
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * Na venda B2B o cliente fala por vários números — o dono, o comprador, o fixo
 * da loja — e cada número é um contato com a própria conversa. A lista "Pessoas
 * relacionadas" (#3083) já ligava esses contatos ao negócio, mas a ingestão não
 * a lia: a primeira mensagem do comprador abria OUTRO card, e a ligação dele
 * não achava negócio nenhum. Numa carteira de ≈930 clientes, isso virou 36
 * cards "(2º número)" abertos à mão e 4 conversas num dia caindo em card novo.
 *
 * ─── O que se congela aqui, contra o Postgres de verdade ───────────────────
 *
 *  1. `fn_nascer_lead_da_conversa` devolve NULL para a pessoa relacionada de
 *     negócio ABERTO — e não cria linha nenhuma;
 *  2. negócio GANHO não segura ninguém: a pessoa que volta depois do fechamento
 *     é demanda nova, igual ao principal;
 *  3. o vínculo de OUTRA organização não conta (o `target_id` não é FK — um
 *     link forjado num tenant não pode calar a ingestão de outro);
 *  4. o barramento de atividades (ligação, passagem, follow-up) pousa a
 *     atividade da pessoa relacionada no negócio do cliente;
 *  5. o negócio em que o contato é PRINCIPAL vence o negócio em que ele é
 *     relacionado — quem já tinha card próprio continua como antes.
 *
 * Controle: o principal continua recebendo NULL na segunda mensagem (a regra
 * da 0256 não pode ter sido trocada pela nova), e um contato sem vínculo
 * nenhum continua ganhando card.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "d9045000-0000-4000-8000-000000000001";
const OUTRA_ORG = "d9045000-0000-4000-8000-000000000002";
const FUNIL = "d9045000-0000-4000-8000-000000000003";
const ETAPA = "d9045000-0000-4000-8000-000000000004";
const FUNIL_DE_LA = "d9045000-0000-4000-8000-000000000005";
const ETAPA_DE_LA = "d9045000-0000-4000-8000-000000000006";

/** Cada caso tem o próprio cliente, para um não depender da ordem do outro. */
let sequencia = 0;
function id(): string {
  sequencia += 1;
  return `d9045000-0000-4000-8000-${String(1000 + sequencia).padStart(12, "0")}`;
}

async function contato(org = ORG): Promise<string> {
  const c = id();
  await pool.query(`insert into contacts (id, organization_id, name) values ($1, $2, 'Pessoa')`, [c, org]);
  return c;
}

async function negocio(
  principal: string,
  status: "open" | "won" = "open",
  org = ORG,
  funil = FUNIL,
  etapa = ETAPA,
): Promise<string> {
  const l = id();
  await pool.query(
    // Fechado tem `closed_at` (CHECK `crm_leads_closed_at_consistency`).
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, closed_at)
     values ($1, $2, $3, $4, $5, 'Cliente', $6, case when $6 = 'open' then null else now() end)`,
    [l, org, funil, etapa, principal, status],
  );
  return l;
}

/** O MESMO vínculo que a rota `contatos-relacionados` grava (#3083). */
async function relacionar(lead: string, pessoa: string, org = ORG): Promise<void> {
  await pool.query(
    `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind, metadata)
     values ($1, $2, 'contact', $3, 'related', '{"papel":"Comprador"}'::jsonb)`,
    [org, lead, pessoa],
  );
}

async function nascer(pessoa: string, org = ORG): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    `select public.fn_nascer_lead_da_conversa($1, $2, $3, $4, 'Negócio', 'whatsapp') as id`,
    [org, pessoa, FUNIL, ETAPA],
  );
  return rows[0]!.id;
}

async function negociosDe(pessoa: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from crm_leads where contact_id = $1`,
    [pessoa],
  );
  return Number(rows[0]!.n);
}

async function ligacaoDe(pessoa: string) {
  return emitAgentActivityForContact({
    pool,
    organizationId: ORG,
    contactId: pessoa,
    type: "voice_call_missed",
    reason: "Chamada de voz perdida",
    sourceModule: "voice_calls",
    sourceId: id(),
  });
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-9045', 'Distribuidora LTDA', 'Distribuidora'),
            ($2, 'org-9045-vizinha', 'Vizinha LTDA', 'Vizinha')
     on conflict (id) do nothing`,
    [ORG, OUTRA_ORG],
  );
  for (const [funil, etapa, org, sufixo] of [
    [FUNIL, ETAPA, ORG, "a"],
    [FUNIL_DE_LA, ETAPA_DE_LA, OUTRA_ORG, "b"],
  ] as const) {
    await pool.query(
      `insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Funil', $3)`,
      [funil, org, `funil-9045-${sufixo}`],
    );
    await pool.query(
      `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
       values ($1, $2, $3, 'Entrada', 'entrada', 1)`,
      [etapa, org, funil],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("fn_nascer_lead_da_conversa — a pessoa relacionada (9045)", () => {
  it("⭐ pessoa relacionada de negócio aberto NÃO abre outro card", async () => {
    const dono = await contato();
    const comprador = await contato();
    await relacionar(await negocio(dono), comprador);

    expect(await nascer(comprador)).toBeNull();
    expect(await negociosDe(comprador)).toBe(0);
  });

  it("negócio GANHO não segura ninguém: a pessoa ganha card, como o principal ganharia", async () => {
    const dono = await contato();
    const comprador = await contato();
    await relacionar(await negocio(dono, "won"), comprador);

    expect(await nascer(comprador)).not.toBeNull();
    expect(await negociosDe(comprador)).toBe(1);
  });

  it("vínculo de OUTRA organização não cala a ingestão desta", async () => {
    const pessoa = await contato();
    // Um link forjado no tenant vizinho apontando para o contato daqui: o
    // `target_id` não é FK, então o banco aceita a linha.
    const deLa = await negocio(await contato(OUTRA_ORG), "open", OUTRA_ORG, FUNIL_DE_LA, ETAPA_DE_LA);
    await relacionar(deLa, pessoa, OUTRA_ORG);

    expect(await nascer(pessoa)).not.toBeNull();
  });

  it("controle: o principal continua recebendo NULL na segunda mensagem", async () => {
    const dono = await contato();
    expect(await nascer(dono)).not.toBeNull();
    expect(await nascer(dono)).toBeNull();
    expect(await negociosDe(dono)).toBe(1);
  });

  it("controle: contato sem vínculo nenhum ganha card", async () => {
    expect(await nascer(await contato())).not.toBeNull();
  });
});

describe("emitAgentActivityForContact — a atividade da pessoa relacionada", () => {
  it("⭐ a ligação perdida do comprador pousa no negócio do cliente", async () => {
    const dono = await contato();
    const comprador = await contato();
    const doCliente = await negocio(dono);
    await relacionar(doCliente, comprador);

    expect(await ligacaoDe(comprador)).toEqual({ routed: true, leadId: doCliente });
    const { rows } = await pool.query<{ lead_id: string; contact_id: string }>(
      `select lead_id, contact_id from crm_lead_activities
        where organization_id = $1 and contact_id = $2 and type = 'voice_call_missed'`,
      [ORG, comprador],
    );
    // A linha guarda QUEM ligou (o comprador), no negócio do cliente.
    expect(rows).toEqual([{ lead_id: doCliente, contact_id: comprador }]);
  });

  it("⭐ o negócio em que o contato é PRINCIPAL vence o negócio em que ele é relacionado", async () => {
    const dono = await contato();
    const gerente = await contato();
    await relacionar(await negocio(dono), gerente);
    const doGerente = await negocio(gerente);

    expect(await ligacaoDe(gerente)).toEqual({ routed: true, leadId: doGerente });
  });

  it("negócio ganho do cliente não recebe a atividade da pessoa relacionada", async () => {
    const dono = await contato();
    const comprador = await contato();
    await relacionar(await negocio(dono, "won"), comprador);

    expect(await ligacaoDe(comprador)).toEqual({ routed: false, reason: "no_open_lead" });
  });

  it("vínculo de outra organização não leva a atividade para lá", async () => {
    const pessoa = await contato();
    const deLa = await negocio(await contato(OUTRA_ORG), "open", OUTRA_ORG, FUNIL_DE_LA, ETAPA_DE_LA);
    await relacionar(deLa, pessoa, OUTRA_ORG);

    expect(await ligacaoDe(pessoa)).toEqual({ routed: false, reason: "no_open_lead" });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_AGENT_A as ana,
  GOV_AGENT_B as bruno,
  GOV_MANAGER as manager,
  GOV_VIEWER as viewer,
  GOV_PIPELINE as pipeline,
  GOV_STAGE as stage,
} from "./gov-helpers";

/**
 * Rodízio na ação "Atribuir a um atendente" (migration 0692, issue #2041).
 *
 * Os casos vêm do PR #2269 (@hamiltonviana), agora chamando a função pela
 * REGRA: `fn_automation_rodizio_atribuir(org, regra, lead)` lê a fila da regra
 * gravada, trava por regra, escolhe, registra a vez e grava o dono — tudo na
 * transação da chamada. É exatamente o que a ação faz por RPC.
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 8,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

async function asRole(role: "anon" | "authenticated", user: string | null, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    if (user) await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })]);
    return await c.query(text, args);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const OUTRA_ORG = "cccccccc-0000-4000-8000-0000000020f1";
const TITULO = "lead-rodizio-da-acao";

type Pessoa = { user_id: string; pausado?: boolean };

async function novaRegra(fila: Pessoa[], organizacao = org): Promise<string> {
  const acoes = [
    { type: "add_tag", config: { tags: ["antes"] } },
    { type: "assign_owner", config: { modo: "rodizio", fila: fila.map((p) => ({ user_id: p.user_id, pausado: p.pausado ?? false })) } },
  ];
  const r = await query(
    "insert into automation_rules(organization_id,name,trigger_event,actions,is_active) values($1,'rodízio de teste','lead.created',$2::jsonb,true) returning id",
    [organizacao, JSON.stringify(acoes)],
  );
  return r.rows[0].id as string;
}

async function trocarFila(regra: string, fila: Pessoa[]) {
  const acoes = [{ type: "assign_owner", config: { modo: "rodizio", fila: fila.map((p) => ({ user_id: p.user_id, pausado: p.pausado ?? false })) } }];
  await query("update automation_rules set actions=$2::jsonb where id=$1", [regra, JSON.stringify(acoes)]);
}

async function novoLead(organizacao = org): Promise<string> {
  const r = await query(
    "insert into crm_leads(organization_id,pipeline_id,stage_id,title,source) values($1,$2,$3,$4,'webhook') returning id",
    [organizacao, pipeline, stage, TITULO],
  );
  return r.rows[0].id as string;
}

async function rodar(regra: string, lead: string, organizacao = org, evento: string | null = null) {
  const r = await query("select public.fn_automation_rodizio_atribuir($1,$2,$3,$4) as d", [organizacao, regra, lead, evento]);
  const dono = await query("select owner_user_id from crm_leads where id=$1", [lead]);
  return { desfecho: r.rows[0].d as { user_id?: string; posicao?: number; motivo?: string }, dono: dono.rows[0]?.owner_user_id as string | null };
}

async function vez(regra: string) {
  return (await rodar(regra, await novoLead())).dono;
}

beforeAll(async () => {
  seedGov();
  await query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'outra-org-rodizio-acao','Outra','Outra') on conflict do nothing",
    [OUTRA_ORG],
  );
});
afterAll(() => pool.end());
beforeEach(async () => {
  await query("delete from automation_rules where organization_id = any($1) and name='rodízio de teste'", [[org, OUTRA_ORG]]);
  await query("delete from crm_leads where organization_id = any($1) and title=$2", [[org, OUTRA_ORG], TITULO]);
  await query("update user_organizations set revoked_at=null,role='agent' where organization_id=$1 and user_id=any($2)", [org, [ana, bruno]]);
});

describe("rodízio da ação assign_owner", () => {
  it("reveza na ordem da fila e volta ao primeiro (A → B → A)", async () => {
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno }]);
    expect([await vez(regra), await vez(regra), await vez(regra)]).toEqual([ana, bruno, ana]);
  });

  it("devolve quem e a posição, e grava o dono por UPDATE (emite lead.assigned, o push)", async () => {
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno }]);
    const lead = await novoLead();
    const r = await rodar(regra, lead);
    expect(r.desfecho).toEqual({ user_id: ana, posicao: 1 });
    expect(r.dono).toBe(ana);
    const linha = await query("select owner_kind, owner_agent_id, assigned_at from crm_leads where id=$1", [lead]);
    expect(linha.rows[0]).toMatchObject({ owner_kind: "user", owner_agent_id: null });
    expect(linha.rows[0].assigned_at).not.toBeNull();
    const ev = await query(
      "select payload->>'to_user_id' para from event_log where organization_id=$1 and event_type='lead.assigned' and (payload->>'lead_id')::uuid=$2",
      [org, lead],
    );
    expect(ev.rows.map((e) => e.para)).toEqual([ana]);
    const hist = await query("select user_id, member_position from automation_rodizio_atribuicoes where lead_id=$1", [lead]);
    expect(hist.rows).toEqual([{ user_id: ana, member_position: 1 }]);
  });

  it("quem está pausado é pulado sem sair da fila, e volta quando despausa", async () => {
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno, pausado: true }]);
    expect([await vez(regra), await vez(regra)]).toEqual([ana, ana]);
    await trocarFila(regra, [{ user_id: ana }, { user_id: bruno }]);
    expect(await vez(regra)).toBe(bruno);
  });

  it("membro revogado da organização não recebe lead", async () => {
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno }]);
    await query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [org, bruno]);
    expect([await vez(regra), await vez(regra)]).toEqual([ana, ana]);
  });

  it("papel viewer não recebe lead mesmo estando na fila", async () => {
    const regra = await novaRegra([{ user_id: viewer }, { user_id: ana }]);
    expect([await vez(regra), await vez(regra)]).toEqual([ana, ana]);
  });

  it("tirar da fila quem recebeu por último não faz o rodízio recomeçar", async () => {
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno }, { user_id: manager }]);
    expect([await vez(regra), await vez(regra)]).toEqual([ana, bruno]);
    await trocarFila(regra, [{ user_id: ana }, { user_id: manager }]);
    expect([await vez(regra), await vez(regra)]).toEqual([manager, ana]);
  });

  it("todos pausados: ninguém disponível, o lead fica sem dono e nada entra no histórico", async () => {
    const regra = await novaRegra([{ user_id: ana, pausado: true }, { user_id: bruno, pausado: true }]);
    const lead = await novoLead();
    const r = await rodar(regra, lead);
    expect(r.desfecho).toEqual({ motivo: "ninguem_disponivel" });
    expect(r.dono).toBeNull();
    const hist = await query("select count(*)::int n from automation_rodizio_atribuicoes where rule_id=$1", [regra]);
    expect(hist.rows[0].n).toBe(0);
  });

  it("fila vazia e regra sem rodízio devolvem o motivo, sem dono", async () => {
    const vazia = await novaRegra([]);
    expect((await rodar(vazia, await novoLead())).desfecho).toEqual({ motivo: "fila_vazia" });
    const semRodizio = await novaRegra([{ user_id: ana }]);
    await query(
      `update automation_rules set actions='[{"type":"assign_owner","config":{"user_id":"${ana}"}}]'::jsonb where id=$1`,
      [semRodizio],
    );
    const r = await rodar(semRodizio, await novoLead());
    expect(r).toEqual({ desfecho: { motivo: "sem_rodizio" }, dono: null });
  });

  it("o MESMO evento reprocessado devolve a mesma pessoa, sem linha nova e sem andar a fila", async () => {
    // O dreno só marca o evento consumido depois de a regra voltar: um worker
    // derrubado no meio devolve o evento à fila, e a regra roda de novo.
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno }]);
    const lead = await novoLead();
    const evento = randomUUID();
    expect((await rodar(regra, lead, org, evento)).desfecho).toEqual({ user_id: ana, posicao: 1 });
    // Troca manual entre as duas voltas: a reexecução não a desfaz.
    await query("update crm_leads set owner_user_id=$2 where id=$1", [lead, manager]);
    const denovo = await rodar(regra, lead, org, evento);
    expect(denovo).toEqual({ desfecho: { user_id: ana, posicao: 1 }, dono: manager });
    const hist = await query("select count(*)::int n from automation_rodizio_atribuicoes where rule_id=$1", [regra]);
    expect(hist.rows[0].n).toBe(1);
    // Evento DIFERENTE anda a fila: a vez é de quem vinha depois de Ana.
    expect((await rodar(regra, await novoLead(), org, randomUUID())).dono).toBe(bruno);
  });

  it("quatro leads simultâneos se repartem 2/2 (a trava é por regra)", async () => {
    const regra = await novaRegra([{ user_id: ana }, { user_id: bruno }]);
    const leads = await Promise.all([novoLead(), novoLead(), novoLead(), novoLead()]);
    const donos = (await Promise.all(leads.map((l) => rodar(regra, l)))).map((r) => r.dono);
    expect(donos.filter((d) => d === ana)).toHaveLength(2);
    expect(donos.filter((d) => d === bruno)).toHaveLength(2);
  });
});

describe("isolamento e permissões", () => {
  it("regra de OUTRA organização não atribui (a fila é lida dentro da org passada)", async () => {
    const regraDeFora = await novaRegra([{ user_id: ana }], OUTRA_ORG);
    const lead = await novoLead();
    const r = await rodar(regraDeFora, lead, org);
    expect(r).toEqual({ desfecho: { motivo: "sem_rodizio" }, dono: null });
  });

  it("lead de OUTRA organização não é tocado pela regra desta", async () => {
    const regra = await novaRegra([{ user_id: ana }]);
    const funil = await query(
      "insert into crm_pipelines(organization_id,name,slug) values($1,'Outra','outra-rodizio-acao') on conflict do nothing returning id",
      [OUTRA_ORG],
    );
    const funilId =
      (funil.rows[0]?.id as string | undefined) ??
      ((await query("select id from crm_pipelines where organization_id=$1 and slug='outra-rodizio-acao'", [OUTRA_ORG])).rows[0].id as string);
    const etapa = await query(
      "insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Novo','novo',1000) on conflict do nothing returning id",
      [OUTRA_ORG, funilId],
    );
    const etapaId =
      (etapa.rows[0]?.id as string | undefined) ??
      ((await query("select id from crm_stages where pipeline_id=$1 and slug='novo'", [funilId])).rows[0].id as string);
    const leadDaOutra = await query(
      "insert into crm_leads(organization_id,pipeline_id,stage_id,title) values($1,$2,$3,$4) returning id",
      [OUTRA_ORG, funilId, etapaId, TITULO],
    );
    const alvo = leadDaOutra.rows[0].id as string;
    const r = await query("select public.fn_automation_rodizio_atribuir($1,$2,$3) as d", [org, regra, alvo]);
    expect(r.rows[0].d).toEqual({ motivo: "lead_nao_encontrado" });
    const dono = await query("select owner_user_id from crm_leads where id=$1", [alvo]);
    expect(dono.rows[0].owner_user_id).toBeNull();
    const hist = await query("select count(*)::int n from automation_rodizio_atribuicoes where rule_id=$1", [regra]);
    expect(hist.rows[0].n).toBe(0);
  });

  it("nem anon nem authenticated executam a função (a ação chama com service_role)", async () => {
    const regra = await novaRegra([{ user_id: ana }]);
    const lead = await novoLead();
    await expect(asRole("anon", null, "select public.fn_automation_rodizio_atribuir($1,$2,$3)", [org, regra, lead])).rejects.toThrow(/permission denied/);
    await expect(asRole("authenticated", manager, "select public.fn_automation_rodizio_atribuir($1,$2,$3)", [org, regra, lead])).rejects.toThrow(/permission denied/);
  });

  it("o histórico é lido pela organização e não é gravável pela API, nem por manager", async () => {
    const regra = await novaRegra([{ user_id: ana }]);
    const lead = await novoLead();
    await rodar(regra, lead);
    const lido = await asRole("authenticated", ana, "select count(*)::int n from automation_rodizio_atribuicoes where rule_id=$1", [regra]);
    expect(lido.rows[0].n).toBe(1);
    await expect(
      asRole("authenticated", manager, "insert into automation_rodizio_atribuicoes(organization_id,rule_id,lead_id,user_id,member_position) values($1,$2,$3,$4,1)", [org, regra, lead, ana]),
    ).rejects.toThrow(/permission denied/);
    await expect(asRole("anon", null, "select 1 from automation_rodizio_atribuicoes limit 1")).rejects.toThrow(/permission denied/);
  });
});

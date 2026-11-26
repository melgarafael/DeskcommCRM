import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER, seedGov } from "./gov-helpers";

const banco = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => banco.end());

interface Cenario {
  org: string;
  origem: string;
  destino: string;
  etapaDaOrigem: string;
  etapaDoDestino: string;
  etapaDePerda: string;
  lead: string;
}

async function cenario(): Promise<Cenario> {
  const org = randomUUID();
  const origem = randomUUID();
  const destino = randomUUID();
  const etapaDaOrigem = randomUUID();
  const etapaDoDestino = randomUUID();
  const etapaDePerda = randomUUID();
  const lead = randomUUID();

  await banco.query(
    "insert into public.organizations (id, slug, legal_name, display_name) values ($1::uuid, $1::text, 'Clonagem', 'Clonagem')",
    [org],
  );
  await banco.query(
    `insert into public.crm_pipelines (id, organization_id, name, slug)
     values ($1, $3, 'Vendas', 'vendas'), ($2, $3, 'Pós-venda', 'pos-venda')`,
    [origem, destino, org],
  );
  await banco.query(
    `insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost)
     values ($1, $5, $3, 'Aberto', 'aberto', 1000, false),
            ($2, $5, $4, 'Entrada', 'entrada', 1000, false),
            ($6, $5, $3, 'Perda', 'perda', 2000, true)`,
    [etapaDaOrigem, etapaDoDestino, origem, destino, org, etapaDePerda],
  );
  await banco.query(
    `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
     values ($1, $2, $3, $4, 'Negócio de origem')`,
    [lead, org, origem, etapaDaOrigem],
  );
  return { org, origem, destino, etapaDaOrigem, etapaDoDestino, etapaDePerda, lead };
}

type Conexao = pg.Pool | pg.PoolClient;
type Gravacao = {
  clone: { id: string; source_metadata: Record<string, unknown> };
  origem: { id: string; status: string; source_metadata: Record<string, unknown> };
  criou: boolean;
  fechou: boolean;
};

async function gravar(
  conn: Conexao, c: Cenario, opcoes: {
    linha?: Record<string, unknown> | null;
    sessao?: Record<string, unknown>;
    versao?: string;
  } = {},
): Promise<Gravacao> {
  const linha = opcoes.linha === undefined ? {
    stage_id: c.etapaDoDestino,
    title: "Negócio clonado",
    source: "manual",
    tags: [],
    custom_fields: {},
    source_metadata: {},
    position_in_stage: 1000,
  } : opcoes.linha;
  const { rows: [r] } = await conn.query<{ gravacao: Gravacao }>(`
    select public.fn_levar_negocio_para_funil(
      $1, $2, $3, $4,
      case when status = 'open' then jsonb_build_object(
        'stage_id', $5::uuid, 'position_in_stage', 1000,
        'lost_reason', 'moved_to_another_pipeline', 'updated_at', now()
      ) end,
      coalesce($6::timestamptz, updated_at), $7
    ) as gravacao from public.crm_leads where id = $2
  `, [c.org, c.lead, c.destino, linha, c.etapaDePerda, opcoes.versao ?? null, opcoes.sessao ?? null]);
  return r!.gravacao;
}

async function clonar(conn: Conexao, c: Cenario): Promise<string> {
  return (await gravar(conn, c)).clone.id;
}

async function idsNoDestino(c: Cenario) {
  const resultado = await banco.query<{ id: string }>(
    "select id from public.crm_leads where organization_id = $1 and pipeline_id = $2 order by id",
    [c.org, c.destino],
  );
  return resultado.rows.map(({ id }) => id);
}

it("repetição: devolve o id da mesma cópia e deixa um único card no destino", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  const segunda = await clonar(banco, c);
  expect({ segunda, ids: await idsNoDestino(c) }).toEqual({ segunda: primeira, ids: [primeira] });
});

it("corrida: dois backends de Postgres recebem o mesmo id e deixam um único card", async () => {
  const c = await cenario();
  const a = await banco.connect();
  const b = await banco.connect();
  const pid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  let segunda: Promise<string> | undefined;
  try {
    await a.query("begin; set local statement_timeout = '15s'");
    await b.query("begin; set local statement_timeout = '15s'");
    const idA = await clonar(a, c);
    let terminou = false;
    segunda = clonar(b, c).finally(() => { terminou = true; });
    void segunda.catch(() => undefined);
    // O backend B já está tentando a escrita enquanto A segura a transação.
    // Sem a guarda B chega ao fim e insere, em vez de esperar o commit de A.
    let esperou = false;
    await expect.poll(async () => {
      const r = await banco.query<{ aguardando: boolean }>(
        "select cardinality(pg_blocking_pids($1)) > 0 as aguardando",
        [pid],
      );
      esperou = r.rows[0]?.aguardando === true;
      return terminou || esperou;
    }).toBe(true);
    await a.query("commit");
    const idB = await segunda;
    await b.query("commit");
    expect({ idB, ids: await idsNoDestino(c), esperou }).toEqual({ idB: idA, ids: [idA], esperou: true });
  } finally {
    await a.query("rollback");
    await segunda?.catch(() => undefined);
    await b.query("rollback");
    a.release();
    b.release();
  }
});

it("a recusa do vínculo desfaz também o clone e o fechamento", async () => {
  const c = await cenario();
  await banco.query(`
    create function public.teste_5229_recusa_vinculo() returns trigger language plpgsql as $$
    begin
      if new.source_metadata ? 'clonado_de' and not (old.source_metadata ? 'clonado_de') then
        raise exception 'vinculo recusado';
      end if;
      return new;
    end $$;
    create trigger teste_5229_vinculo before update of source_metadata on public.crm_leads
      for each row execute function public.teste_5229_recusa_vinculo()
  `);
  try {
    await expect(gravar(banco, c)).rejects.toThrow("vinculo recusado");
    expect(await idsNoDestino(c)).toEqual([]);
    const { rows: [origem] } = await banco.query(
      "select status, source_metadata from public.crm_leads where id = $1", [c.lead],
    );
    expect(origem).toEqual({ status: "open", source_metadata: {} });
  } finally {
    await banco.query("drop trigger teste_5229_vinculo on public.crm_leads; drop function public.teste_5229_recusa_vinculo()");
  }

  const primeira = await gravar(banco, c);
  expect(primeira).toMatchObject({
    criou: true, fechou: true,
    origem: { status: "lost", source_metadata: { movido_para: { lead_id: primeira.clone.id } } },
    clone: { source_metadata: { clonado_de: { lead_id: c.lead } } },
  });
});

it("se o clone saiu do funil ou foi excluído, permite outra tentativa", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  await banco.query(
    "update public.crm_leads set pipeline_id = $1, stage_id = $2 where id = $3",
    [c.origem, c.etapaDaOrigem, primeira],
  );
  const segunda = await clonar(banco, c);
  expect(segunda).not.toBe(primeira);
  await banco.query("delete from public.crm_leads where id = $1", [segunda]);
  const terceira = await clonar(banco, c);
  expect(terceira).not.toBe(segunda);
  expect(await idsNoDestino(c)).toEqual([terceira]);
});

it("um funil arquivado não recebe e o clone volta a contar ao restaurá-lo", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  await banco.query("update public.crm_pipelines set is_archived = true where id = $1", [c.destino]);
  await expect(gravar(banco, c)).rejects.toMatchObject({ code: "PT409" });
  await banco.query("update public.crm_pipelines set is_archived = false where id = $1", [c.destino]);
  expect(await clonar(banco, c)).toBe(primeira);
});

it("usa a origem direta mesmo quando o negócio de origem também é um clone", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  const perdaNoDestino = randomUUID();
  await banco.query(`
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost)
    values ($1, $2, $3, 'Perda', 'perda', 2000, true)
  `, [perdaNoDestino, c.org, c.destino]);
  const volta = await gravar(banco, {
    org: c.org, origem: c.destino, destino: c.origem, lead: primeira, etapaDoDestino: c.etapaDaOrigem,
    etapaDaOrigem: c.etapaDoDestino, etapaDePerda: perdaNoDestino,
  });
  expect(volta.criou).toBe(true);
  expect(volta.clone.source_metadata.clonado_de).toEqual({ lead_id: primeira, pipeline_id: c.destino });
  const novaTentativa = await gravar(banco, c);
  expect(novaTentativa.criou).toBe(true);
  expect(novaTentativa.clone.id).not.toBe(primeira);
});

it("fonte alterada noutra conexão invalida o payload que já havia sido preparado", async () => {
  const c = await cenario();
  const primeira = await banco.connect();
  const segunda = await banco.connect();
  try {
    const { rows: [versao] } = await primeira.query<{ valor: string }>(
      "select updated_at::text as valor from public.crm_leads where id = $1", [c.lead],
    );
    await segunda.query(
      "update public.crm_leads set title = 'Removido', source_metadata = '{}', updated_at = updated_at + interval '1 second' where id = $1",
      [c.lead],
    );
    await expect(gravar(primeira, c, { versao: versao!.valor })).rejects.toMatchObject({ code: "PT409" });
    expect(await idsNoDestino(c)).toEqual([]);
  } finally {
    primeira.release();
    segunda.release();
  }
});

it("somente o papel de serviço pode chamar a transação diretamente", async () => {
  const { rows: [privilegios] } = await banco.query(`
    select has_function_privilege('anon', assinatura, 'EXECUTE') as anon,
           has_function_privilege('authenticated', assinatura, 'EXECUTE') as usuario,
           has_function_privilege('service_role', assinatura, 'EXECUTE') as servico
      from (values ('public.fn_levar_negocio_para_funil(uuid,uuid,uuid,jsonb,jsonb,timestamptz,jsonb)')) as f(assinatura)
  `);
  expect(privilegios).toEqual({ anon: false, usuario: false, servico: true });
});

it("o clone passa pela policy real do agente da sessão", async () => {
  seedGov();
  const c = await cenario();
  await banco.query(`
    insert into public.user_organizations (user_id, organization_id, role)
    values ($1, $4, 'agent'), ($2, $4, 'agent'), ($3, $4, 'viewer')
  `, [GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER, c.org]);
  await banco.query("update public.organizations set settings = $2 where id = $1", [c.org, { visibility_mode: "own" }]);
  await banco.query("update public.crm_leads set owner_user_id = $1, owner_kind = 'user' where id = $2", [GOV_AGENT_A, c.lead]);

  const sessao = { sub: GOV_AGENT_A, role: "authenticated", aal: "aal1" };
  await expect(gravar(banco, c, { sessao })).rejects.toMatchObject({ code: "42501" });
  const linha = {
    stage_id: c.etapaDoDestino, title: "Negócio clonado", owner_user_id: GOV_AGENT_A,
    owner_kind: "user", source: "manual", tags: [], custom_fields: {},
    source_metadata: {}, position_in_stage: 1000,
  };
  await expect(gravar(banco, c, {
    linha: { ...linha, owner_user_id: GOV_AGENT_B }, sessao,
  })).rejects.toMatchObject({ code: "42501" });
  await expect(gravar(banco, c, {
    linha, sessao: { ...sessao, sub: GOV_VIEWER },
  })).rejects.toMatchObject({ code: "42501" });
  expect(await idsNoDestino(c)).toEqual([]);
  const primeira = await gravar(banco, c, { linha, sessao });
  expect(primeira).toMatchObject({ criou: true, fechou: true });

  // A releitura não devolve o clone que agora só o colega vê.
  await banco.query("update public.crm_leads set owner_user_id = $1 where id = $2", [
    GOV_AGENT_B, primeira.clone.id,
  ]);
  await expect(gravar(banco, c, { linha, sessao })).rejects.toMatchObject({ code: "PT404" });
  expect(await idsNoDestino(c)).toEqual([primeira.clone.id]);
});

it("o replay não revela o card ligado a um contato marcado como pessoal", async () => {
  const c = await cenario();
  const primeira = await gravar(banco, c);
  const contato = randomUUID();
  await banco.query(
    "insert into public.contacts (id, organization_id, display_name, is_personal) values ($1, $2, 'Contato fictício', true)",
    [contato, c.org],
  );
  await banco.query("update public.crm_leads set contact_id = $1 where id = $2", [contato, primeira.clone.id]);
  await expect(gravar(banco, c)).rejects.toMatchObject({ code: "PT404" });
  await banco.query("update public.crm_leads set contact_id = null where id = $1", [primeira.clone.id]);
  await banco.query("update public.crm_leads set contact_id = $1 where id = $2", [contato, c.lead]);
  await expect(gravar(banco, c)).rejects.toMatchObject({ code: "PT404" });
  expect(await idsNoDestino(c)).toEqual([primeira.clone.id]);
});

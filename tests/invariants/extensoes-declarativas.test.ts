import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

// Mesmo Postgres efêmero do test:db. Dados inteiramente sintéticos; nenhuma rede de pacote.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 6 });
const actor = "e2550000-0000-4000-8000-000000000001";
const orgA = "e2550000-0000-4000-8000-000000000002";
const orgB = "e2550000-0000-4000-8000-000000000003";
const adminA = "e2550000-0000-4000-8000-000000000004";
const adminB = "e2550000-0000-4000-8000-000000000005";
const viewer = "e2550000-0000-4000-8000-000000000006";
const manager = "e2550000-0000-4000-8000-000000000007";
const actor2 = "e2550000-0000-4000-8000-000000000008";
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function withRole(role: "service_role" | "authenticated" | "anon", text: string, values: unknown[] = [], user = viewer) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role })]);
    const result = await c.query(text, values);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally { c.release(); }
}
const rpcBruto = async (name: string, args: unknown[]) => {
  const r = await withRole("service_role", `select public.fn_extensions_${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`, args);
  return r.rows[0].result;
};
// `applied_now` diz se ESTA chamada fez a transição; a repetição idempotente devolve false. As
// comparações de recibo entre chamadas usam `rpc`, que o separa; as provas dele usam `rpcBruto`.
const rpc = async (name: string, args: unknown[]) => {
  const { applied_now: _aplicado, ...recibo } = await rpcBruto(name, args);
  return recibo;
};
function artifact(name = "guia-tarefas", version = "1.0.0") {
  const manifest = {
    format_version: 1, profile: "declarative", publisher: "invariant", name, version, license: "MIT",
    host_api: { min: 1, max: 1 }, permissions: ["navigation.tasks"], dependencies: [], data: { mode: "none" },
    display: { title: { "pt-BR": "Guia" }, summary: { "pt-BR": "Organize as tarefas" }, category: "productivity", icon: "ListChecks" },
    configuration: { density: "comfortable", show_description: true },
    contributions: { crm_cards: [{ id: "primeira-tarefa", title: { "pt-BR": "Começar" }, description: { "pt-BR": "Passo inicial" }, icon: "ListChecks",
      blocks: [{ heading: { "pt-BR": "Ação" }, body: { "pt-BR": "Crie sua tarefa" } }], action: { label: { "pt-BR": "Abrir tarefas" }, capability: "tasks.open" } }] },
  };
  const { publisher, license, host_api, display, permissions } = manifest;
  const entry = { publisher, name, version, license, host_api, display, permissions, sha256: hash(manifest), byte_length: Buffer.byteLength(JSON.stringify(manifest)) };
  return { manifest, entry };
}
const base = artifact();
let catalog: string;
let seq = 0;
const origin = () => `https://extensoes-${++seq}.invariant.test`;
const admit = async (entries = [base.entry], revision = 1, url = origin(), key = randomUUID()) => {
  const snapshot = { format_version: 1, origin: url, revision, entries };
  return rpc("admit_catalog", [actor, key, snapshot, hash(snapshot)]);
};
const prepare = (item = base, key = randomUUID(), cat = catalog, who = actor, expected: number | null = null) =>
  rpc("prepare_install", [who, key, cat, item.entry.publisher, item.entry.name, item.entry.version, expected]);
const finish = (key: string, item = base, who = actor) => rpc("finish_install", [who, key, item.manifest, item.entry.sha256, item.entry.byte_length, JSON.stringify(item.manifest)]);
const install = async (item = base, cat = catalog) => { const p = await prepare(item, randomUUID(), cat); return (await finish(p.id, item)).installation_id as string; };
const configure = (id: string, revision = 0, enabled = true, config: unknown = null, key = randomUUID(), org = orgA, who = adminA) =>
  rpc("configure", [who, org, id, key, revision, enabled, config]);
const v11 = artifact("guia-tarefas", "1.1.0");
const desfazer = (id: string, revision: number, key = randomUUID(), who = actor) => rpc("revert_install", [who, key, id, revision]);
const remover = (id: string, revision: number, key = randomUUID(), who = actor) => rpc("remove_installation", [who, key, id, revision]);
const atualizar = async (item: ReturnType<typeof artifact>, revision: number | null) => {
  const p = await prepare(item, randomUUID(), catalog, actor, revision);
  return finish(p.id, item);
};
// Nova revisão do catálogo desta prova, com as entradas dadas (a origem é a mesma).
const readmitir = async (entries: (typeof base.entry)[], revision: number) => {
  const c = (await query("select origin from extension_catalogs where id=$1", [catalog])).rows[0];
  return admit(entries, revision, c.origin);
};
const linhaDa = async (id: string) => (await query("select * from extension_installations where id=$1", [id])).rows[0];
const vinculo = async (org: string, id: string) =>
  (await query("select * from organization_extensions where organization_id=$1 and installation_id=$2", [org, id])).rows[0];
const ativosEmRemovidas = async () => (await query(
  "select count(*)::int n from organization_extensions e join extension_installations i on i.id=e.installation_id where e.enabled and i.removed_at is not null",
)).rows[0].n;

async function clean() {
  await query("delete from extension_operations where actor_id in ($1,$2,$3,$4,$5,$6)", [actor, adminA, adminB, viewer, manager, actor2]);
  await query("delete from organization_extensions where organization_id in ($1,$2)", [orgA, orgB]);
  await query("delete from extension_installations where catalog_id in(select id from extension_catalogs where origin like 'https://extensoes-%.invariant.test')");
  await query("delete from extension_artifacts a where not exists(select 1 from extension_installations i where i.artifact_id=a.id or i.previous_artifact_id=a.id) and a.manifest->>'publisher'='invariant'");
  await query("delete from extension_catalogs where origin like 'https://extensoes-%.invariant.test'");
  await query("delete from system_update_runs where requested_by=$1", [actor]);
}
beforeAll(async () => {
  for (const id of [actor, adminA, adminB, viewer, manager, actor2]) await query("insert into auth.users(id,email) values($1,$2) on conflict(id) do nothing", [id, `${id}@invariant.test`]);
  for (const [id, slug] of [[orgA, "extensoes-a"], [orgB, "extensoes-b"]]) await query("insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Extensões de teste','Extensões de teste') on conflict(id) do nothing", [id, slug]);
  for (const [user, org, role] of [[adminA, orgA, "admin"], [adminB, orgB, "admin"], [viewer, orgA, "viewer"], [manager, orgA, "manager"]]) {
    await query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now()) on conflict(user_id,organization_id) do update set role=excluded.role,accepted_at=now(),revoked_at=null", [user, org, role]);
  }
  for (const plataforma of [actor, actor2]) {
    await query("insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'Teste de extensões') on conflict(user_id) do update set revoked_at=null,scope='full'", [plataforma]);
  }
});
beforeEach(async () => {
  await clean();
  await query("update platform_admins set revoked_at=null,scope='full' where user_id=$1", [actor]);
  await query("update user_organizations set revoked_at=null,accepted_at=now() where user_id in($1,$2,$3,$4)", [adminA, adminB, viewer, manager]);
  catalog = (await admit()).catalog_id;
});
afterAll(async () => { await clean(); await pool.end(); });

describe("extensões: autoridade e isolamento reais", () => {
  it("membros leem só seu vínculo e nenhuma escrita direta passa, inclusive service_role", async () => {
    const id = await install();
    await configure(id);
    await configure(id, 0, true, null, randomUUID(), orgB, adminB);
    for (const [user, own, other] of [[viewer, orgA, orgB], [adminB, orgB, orgA]]) {
      expect((await withRole("authenticated", "select * from organization_extensions where organization_id=$1", [own], user)).rowCount).toBe(1);
      expect((await withRole("authenticated", "select * from organization_extensions where organization_id=$1", [other], user)).rowCount).toBe(0);
    }
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const command of ["insert", "update", "delete"]) {
        const statement = command === "insert" ? "insert into organization_extensions(organization_id,installation_id,enabled,configuration,revision) values($1,$2,false,'{}',1)" :
          command === "update" ? "update organization_extensions set enabled=false where organization_id=$1 and installation_id=$2" : "delete from organization_extensions where organization_id=$1 and installation_id=$2";
        await expect(withRole(role, statement, [orgA, id], adminA)).rejects.toMatchObject({ code: "42501" });
      }
    }
    await query("update user_organizations set revoked_at=now() where user_id=$1", [viewer]);
    expect((await withRole("authenticated", "select * from organization_extensions", [], viewer)).rowCount).toBe(0);
  });

  it("suporte ativo lê o vínculo só da organização atendida; convite não aceito segue sem ler", async () => {
    const id = await install();
    await configure(id);
    await configure(id, 0, true, null, randomUUID(), orgB, adminB);
    const sessao = randomUUID();
    await query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1')", [sessao, actor]);
    const ler = async (org: string, sessionId: string) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: actor, role: "authenticated", session_id: sessionId }),
        ]);
        return (await c.query("select 1 from organization_extensions where organization_id=$1", [org])).rowCount;
      } finally {
        await c.query("rollback");
        c.release();
      }
    };
    try {
      // O ator é platform admin sem membership em A nem em B: o caso normal de suporte.
      await query("select public.fn_start_support($1,$2,$3,null,'support_readonly',600)", [actor, sessao, orgB]);
      expect(await ler(orgB, sessao)).toBe(1);
      expect(await ler(orgA, sessao)).toBe(0);
      expect(await ler(orgB, randomUUID())).toBe(0);
      await query("update user_organizations set accepted_at=null where user_id=$1", [viewer]);
      expect((await withRole("authenticated", "select * from organization_extensions where organization_id=$1", [orgA], viewer)).rowCount).toBe(0);
    } finally {
      await query("delete from platform_support_sessions where auth_session_id=$1", [sessao]);
      await query("delete from auth.sessions where id=$1", [sessao]);
    }
  });

  it("tabelas de instância fechadas e as RPCs não são alcançáveis por anon/authenticated", async () => {
    const id = await install();
    await configure(id);
    const calls: [string, unknown[]][] = [
      ["admit_catalog", [actor, randomUUID(), {}, "a".repeat(64)]], ["prepare_install", [actor, randomUUID(), catalog, "invariant", "guia-tarefas", "1.0.0", null]],
      ["revert_install", [actor, randomUUID(), id, 1]], ["remove_installation", [actor, randomUUID(), id, 1]],
      ["finish_install", [actor, randomUUID(), {}, "a".repeat(64), 1, "{}"]], ["fail_install", [actor, randomUUID(), "extension_download_failed"]],
      ["cancel_install", [actor, randomUUID()]], ["configure", [adminA, orgA, id, randomUUID(), 0, true, null]],
    ];
    for (const role of ["anon", "authenticated"] as const) {
      for (const table of ["extension_catalogs", "extension_artifacts", "extension_installations", "extension_operations"]) {
        await expect(withRole(role, `select * from ${table}`)).rejects.toMatchObject({ code: "42501" });
      }
      for (const [name, args] of calls) await expect(withRole(role, `select fn_extensions_${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`, args)).rejects.toMatchObject({ code: "42501" });
    }
    for (const table of ["extension_artifacts", "extension_installations"]) await expect(withRole("service_role", `delete from ${table}`)).rejects.toMatchObject({ code: "42501" });
    for (const role of ["anon", "authenticated"] as const) {
      await expect(withRole(role, "select * from fn_extensions_installation_counts($1)", [actor])).rejects.toMatchObject({ code: "42501" });
    }
    // A assinatura antiga do prepare, sem a precondição, não sobrevive como sobrecarga.
    expect((await query("select to_regprocedure('public.fn_extensions_prepare_install(uuid,uuid,uuid,text,text,text)') is null as sumiu")).rows[0].sumiu).toBe(true);
    expect((await query("select to_regprocedure('public.fn_extensions_installation_counts()') is null as sumiu")).rows[0].sumiu).toBe(true);
  });

  it("ator revogado, viewer, manager, convite não aceito e organização vizinha são recusados na RPC", async () => {
    const id = await install();
    for (const who of [viewer, manager, adminB]) await expect(configure(id, 0, true, null, randomUUID(), orgA, who)).rejects.toThrow("extension_forbidden");
    await query("update user_organizations set accepted_at=null where user_id=$1", [adminA]);
    await expect(configure(id)).rejects.toThrow("extension_forbidden");
    await query("update platform_admins set scope='support_readonly' where user_id=$1", [actor]);
    await expect(prepare()).rejects.toThrow("extension_forbidden");
    await query("update platform_admins set scope='full',revoked_at=now() where user_id=$1", [actor]);
    await expect(admit()).rejects.toThrow("extension_forbidden");
  });

  it("desfazer e remover são só de quem administra a instalação, nunca de quem administra uma organização", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    await atualizar(v11, 1);
    for (const who of [adminA, manager, viewer]) {
      await expect(desfazer(id, 2, randomUUID(), who)).rejects.toThrow("extension_forbidden");
      await expect(remover(id, 2, randomUUID(), who)).rejects.toThrow("extension_forbidden");
    }
    await query("update platform_admins set scope='support_readonly' where user_id=$1", [actor]);
    await expect(desfazer(id, 2)).rejects.toThrow("extension_forbidden");
    await expect(remover(id, 2)).rejects.toThrow("extension_forbidden");
    expect(await linhaDa(id)).toMatchObject({ revision: 2, version: "1.1.0", removed_at: null });
  });
});

describe("extensões: publicação transacional e recibos", () => {
  it("prepare e finish repetidos devolvem o mesmo recibo e um único artefato/ponteiro", async () => {
    const key = randomUUID();
    const p = await prepare(base, key);
    expect(p.status).toBe("preparing");
    expect((await query("select * from extension_installations")).rowCount).toBe(0);
    expect(await prepare(base, key)).toEqual(p);
    const done = await finish(key);
    expect(done.status).toBe("completed");
    expect(await finish(key)).toEqual(done);
    expect(await prepare(base, key)).toEqual(done);
    expect((await query("select * from extension_installations where catalog_id=$1", [catalog])).rowCount).toBe(1);
    await expect(prepare(artifact("outro-guia"), key)).rejects.toThrow("extension_idempotency_conflict");
    await expect(rpc("finish_install", [actor, key, { ...base.manifest, configuration: { density: "compact", show_description: true } }, base.entry.sha256, base.entry.byte_length, JSON.stringify(base.manifest)])).rejects.toThrow("extension_artifact_mismatch");
  });

  it("cancelamento impede conclusão tardia; falha terminal não libera a execução antiga", async () => {
    const p = await prepare();
    expect((await rpc("cancel_install", [actor, p.id])).status).toBe("cancelled");
    expect((await finish(p.id)).status).toBe("cancelled");
    expect((await query("select * from extension_installations where catalog_id=$1", [catalog])).rowCount).toBe(0);
    const retry = await prepare();
    const failed = await rpc("fail_install", [actor, retry.id, "extension_download_failed"]);
    expect(failed.status).toBe("failed");
    expect(await rpc("fail_install", [actor, retry.id, "extension_download_failed"])).toEqual(failed);
    expect(await finish(retry.id)).toEqual(failed);
    await expect(rpc("fail_install", [actor, retry.id, "corpo remoto malicioso"])).rejects.toThrow("extension_invalid_input");
    await expect(rpc("fail_install", [actor, retry.id, "extension_storage_failed"])).rejects.toThrow("extension_idempotency_conflict");
    const next = await prepare();
    expect((await finish(next.id)).status).toBe("completed");
  });

  it("admissão monotônica invalida preparação, preserva instalação e rejeita mesmo número divergente", async () => {
    const c = (await query("select * from extension_catalogs where id=$1", [catalog])).rows[0];
    const key = randomUUID();
    const admitted = await admit([base.entry], 1, c.origin, key);
    expect(await admit([base.entry], 1, c.origin, key)).toEqual(admitted);
    const p = await prepare();
    await admit([base.entry], 2, c.origin);
    expect((await finish(p.id)).status).toBe("cancelled");
    expect((await finish(p.id)).error_code).toBe("extension_catalog_stale");
    await expect(admit([base.entry], 1, c.origin)).rejects.toThrow("extension_catalog_revision_conflict");
    await expect(admit([{ ...base.entry, sha256: "f".repeat(64) }], 2, c.origin)).rejects.toThrow("extension_catalog_revision_conflict");
    const id = await install();
    await admit([], 3, c.origin);
    expect((await query("select id from extension_installations where id=$1", [id])).rowCount).toBe(1);
  });

  it("admissão repetida com a mesma chave e corpo diferente é conflito, não um segundo recibo", async () => {
    const key = randomUUID();
    const url = origin();
    const primeira = await admit([base.entry], 1, url, key);
    expect(await admit([base.entry], 1, url, key)).toEqual(primeira);
    // Mesma chave, catálogo diferente: devolver o recibo antigo esconderia que o pedido novo
    // não foi aplicado; aplicar criaria dois efeitos para uma chave.
    await expect(admit([], 2, url, key)).rejects.toThrow("extension_idempotency_conflict");
    await expect(admit([base.entry], 1, origin(), key)).rejects.toThrow("extension_idempotency_conflict");
    const recibos = await query("select count(*)::int n from extension_operations where id=$1", [key]);
    expect(recibos.rows[0].n).toBe(1);
    const cat = await query("select revision from extension_catalogs where origin=$1", [url]);
    expect(cat.rows[0].revision).toBe(1);
  });

  it("mesma versão/digest diferente conflita, atualizar exige a revisão vista, origens diferentes coexistem", async () => {
    await install();
    const c = (await query("select origin from extension_catalogs where id=$1", [catalog])).rows[0];
    await admit([{ ...base.entry, sha256: "f".repeat(64) }, artifact("guia-tarefas", "2.0.0").entry], 2, c.origin);
    await expect(prepare(base, randomUUID(), catalog, actor, 1)).rejects.toThrow("extension_version_conflict");
    await expect(prepare(artifact("guia-tarefas", "2.0.0"))).rejects.toThrow("extension_version_changed");
    expect((await prepare(artifact("guia-tarefas", "2.0.0"), randomUUID(), catalog, actor, 1)).kind).toBe("update");
    const other = (await admit()).catalog_id;
    await install(base, other);
    expect((await query("select * from extension_installations where publisher='invariant'")).rowCount).toBe(2);
  });

  it("bytes, hash, metadata e manifesto trocados não publicam nada", async () => {
    const p = await prepare();
    for (const args of [
      [base.manifest, "e".repeat(64), base.entry.byte_length], [base.manifest, base.entry.sha256, base.entry.byte_length + 1],
      [{ ...base.manifest, publisher: "invasor" }, base.entry.sha256, base.entry.byte_length],
      [{ ...base.manifest, permissions: ["tasks.read"] }, base.entry.sha256, base.entry.byte_length],
      [{ ...base.manifest, dependencies: ["codigo"] }, base.entry.sha256, base.entry.byte_length],
    ]) await expect(rpc("finish_install", [actor, p.id, ...args, JSON.stringify(base.manifest)])).rejects.toThrow("extension_artifact_mismatch");
    expect((await query("select * from extension_artifacts where sha256=$1", [base.entry.sha256])).rowCount).toBe(0);
    expect((await query("select status from extension_operations where id=$1", [p.id])).rows[0].status).toBe("preparing");
  });

  it("guarda os bytes UTF-8 exatos, rejeita reconstrução e saneia JSON inválido", async () => {
    const document = JSON.stringify(base.manifest, null, 2);
    const entry = { ...base.entry, sha256: createHash("sha256").update(document).digest("hex"), byte_length: Buffer.byteLength(document) };
    const c = (await query("select origin from extension_catalogs where id=$1", [catalog])).rows[0];
    await admit([entry], 2, c.origin);
    const p = await prepare();
    await expect(finish(p.id)).rejects.toThrow("extension_artifact_mismatch");
    await rpc("finish_install", [actor, p.id, base.manifest, entry.sha256, entry.byte_length, document]);
    expect((await query("select document from extension_artifacts where sha256=$1", [entry.sha256])).rows[0].document).toBe(document);
    const badDocument = "{invalid";
    const badEntry = { ...base.entry, name: "json-invalido", sha256: createHash("sha256").update(badDocument).digest("hex"), byte_length: Buffer.byteLength(badDocument) };
    await admit([entry, badEntry], 3, c.origin);
    const broken = await prepare(artifact("json-invalido"));
    await expect(rpc("finish_install", [actor, broken.id, artifact("json-invalido").manifest, badEntry.sha256, badEntry.byte_length, badDocument])).rejects.toMatchObject({ code: "P0001", message: "extension_artifact_mismatch" });
  });

  it("tetos de catálogo e identidades incluem preparações ainda publicáveis", async () => {
    for (let i = 1; i < 8; i++) await admit();
    await expect(admit()).rejects.toThrow("extension_catalog_limit");
    const items = Array.from({ length: 128 }, (_, i) => artifact(`limite-${i + 1}`));
    const c = (await query("select origin from extension_catalogs where id=$1", [catalog])).rows[0];
    await admit(items.map(x => x.entry), 2, c.origin);
    let first = "";
    for (const item of items) {
      const p = await prepare(item);
      if (!first) first = p.id;
    }
    const other = (await query("select id from extension_catalogs where id<>$1 limit 1", [catalog])).rows[0].id;
    await expect(prepare(base, randomUUID(), other)).rejects.toThrow("extension_installation_limit");
    await finish(first, items[0]);
    await expect(prepare(base, randomUUID(), other)).rejects.toThrow("extension_installation_limit");
    const cancelled = (await query("select id from extension_operations where status='preparing' limit 1")).rows[0].id;
    await rpc("cancel_install", [actor, cancelled]);
    expect((await prepare(base, randomUUID(), other)).status).toBe("preparing");
  }, 180_000);

  it("replay também revalida o ator vigente", async () => {
    const p = await prepare();
    await query("update platform_admins set revoked_at=now() where user_id=$1", [actor]);
    for (const attempt of [() => prepare(base, p.id), () => finish(p.id), () => rpc("fail_install", [actor, p.id, "extension_download_failed"]), () => rpc("cancel_install", [actor, p.id])]) await expect(attempt()).rejects.toThrow("extension_forbidden");
  });
});

describe("extensões: configuração com CAS e limite agregado", () => {
  it("desativar e reativar preservam configuração; replay conserva resultado original", async () => {
    const id = await install();
    const custom = { density: "compact", show_description: false };
    const key = randomUUID();
    const first = await configure(id, 0, true, custom, key);
    expect(first.result.organization_extension).toMatchObject({ revision: 1, enabled: true, configuration: custom });
    await configure(id, 1, false);
    const active = await configure(id, 2, true);
    expect(active.result.organization_extension).toMatchObject({ revision: 3, enabled: true, configuration: custom });
    expect(await configure(id, 0, true, custom, key)).toEqual(first);
    await expect(configure(id, 0, false, custom, key)).rejects.toThrow("extension_idempotency_conflict");
    await expect(configure(id, 1)).rejects.toThrow("extension_revision_conflict");
    await query("update user_organizations set revoked_at=now() where user_id=$1", [adminA]);
    await expect(configure(id, 0, true, custom, key)).rejects.toThrow("extension_forbidden");
  });

  it("mesma revisão concorrente só grava uma vez; mesma chave concorrente devolve recibo idêntico", async () => {
    const id = await install();
    const key = randomUUID();
    const [a, b] = await Promise.all([configure(id, 0, true, null, key), configure(id, 0, true, null, key)]);
    expect(a).toEqual(b);
    const race = await Promise.allSettled([configure(id, 1, false), configure(id, 1, true, { density: "compact", show_description: false })]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(race.find(r => r.status === "rejected")).toMatchObject({ reason: { message: "extension_revision_conflict" } });
  });

  it("duas ativações concorrentes disputam a oitava vaga sem afetar outra organização", async () => {
    const items = Array.from({ length: 9 }, (_, i) => artifact(`guia-${i + 1}`));
    const c = (await query("select origin from extension_catalogs where id=$1", [catalog])).rows[0];
    await admit(items.map(x => x.entry), 2, c.origin);
    const ids: string[] = [];
    for (const item of items) ids.push(await install(item));
    for (const id of ids.slice(0, 7)) await configure(id);
    const race = await Promise.allSettled(ids.slice(7).map(id => configure(id)));
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(race.find(r => r.status === "rejected")).toMatchObject({ reason: { message: "extension_active_limit" } });
    expect((await query("select count(*)::int n from organization_extensions where organization_id=$1 and enabled", [orgA])).rows[0].n).toBe(8);
    const ninthInstallation = ids[8];
    if (!ninthInstallation) throw new Error("Fixture incompleta: o teste exige nove extensões instaladas para disputar a oitava vaga");
    await configure(ninthInstallation, 0, true, null, randomUUID(), orgB, adminB);
  });
});

async function lockedClient(): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query("begin");
  await c.query("select pg_advisory_xact_lock(255,1)");
  return c;
}
describe("extensões: coordenação com atualização do core", () => {
  it("preparação bloqueia INSERT e transição dispatched, até cancelamento explícito", async () => {
    const p = await prepare();
    await expect(query("insert into system_update_runs(requested_by) values($1)", [actor])).rejects.toThrow("extension_preparation_in_progress");
    const update = (await query("insert into system_update_runs(requested_by,status) values($1,'failed') returning id", [actor])).rows[0].id;
    await expect(query("update system_update_runs set status='dispatched' where id=$1", [update])).rejects.toThrow("extension_preparation_in_progress");
    await rpc("cancel_install", [actor, p.id]);
    await query("update system_update_runs set status='dispatched' where id=$1", [update]);
    await expect(prepare()).rejects.toThrow("extension_core_update_in_progress");
    expect((await finish(p.id)).status).toBe("cancelled");
  });

  it("atualização em voo ganha trava antes de prepare; não surge preparação concorrente", async () => {
    const c = await lockedClient();
    try {
      await c.query("insert into system_update_runs(requested_by) values($1)", [actor]);
      const pending = prepare();
      const assertion = expect(pending).rejects.toThrow("extension_core_update_in_progress");
      await c.query("commit");
      await assertion;
    } finally { await c.query("rollback"); c.release(); }
  });

  it("preparação ainda não confirmada segura a atualização do core na trava, não por sorte de tempo", async () => {
    // O teste acima pega a trava por fora antes de inserir a atualização, então ele passa com ou
    // sem a trava do GATILHO. Aqui a ordem é a outra: a preparação existe numa transação aberta,
    // invisível para as demais conexões. Sem a trava do gatilho, o INSERT de `dispatched` não vê
    // o `preparing` e passa — é a corrida que a trava existe para fechar.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await a.query("select public.fn_extensions_prepare_install($1,$2,$3,$4,$5,$6,$7)", [
        actor, randomUUID(), catalog, base.entry.publisher, base.entry.name, base.entry.version, null,
      ]);
      await b.query("begin");
      await b.query("set local lock_timeout = '700ms'");
      await expect(b.query("insert into system_update_runs(requested_by) values($1)", [actor]))
        .rejects.toMatchObject({ code: "55P03" });
      await b.query("rollback");
      await a.query("commit");
      await expect(query("insert into system_update_runs(requested_by) values($1)", [actor]))
        .rejects.toThrow("extension_preparation_in_progress");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it("cancelamento sob trava encerra autoridade antes de finish tardio e permite atualizar", async () => {
    const p = await prepare();
    const c = await lockedClient();
    try {
      await c.query("select fn_extensions_cancel_install($1,$2)", [actor, p.id]);
      const late = finish(p.id);
      await c.query("commit");
      expect((await late).status).toBe("cancelled");
      await query("insert into system_update_runs(requested_by) values($1)", [actor]);
      expect((await query("select * from extension_installations where catalog_id=$1", [catalog])).rowCount).toBe(0);
    } finally { await c.query("rollback"); c.release(); }
  });

  it("mesma chave prepare concorrente não duplica; outra chave mesma identidade é recusada", async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([prepare(base, key), prepare(base, key)]);
    expect(a).toEqual(b);
    await expect(prepare()).rejects.toThrow("extension_preparation_in_progress");
  });
});

describe("extensões: atualizar, desfazer a última troca e remover", () => {
  it("atualizar troca o ponteiro, guarda o anterior e não toca nos vínculos das organizações", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    const custom = { density: "compact", show_description: false };
    await configure(id, 0, true, custom);
    await configure(id, 0, true, null, randomUUID(), orgB, adminB);
    await configure(id, 1, false, null, randomUUID(), orgB, adminB);
    const vinculos = () => query("select organization_id,enabled,configuration,revision,updated_by,deactivated_by_removal_at from organization_extensions where installation_id=$1 order by organization_id", [id]);
    const antesDosVinculos = (await vinculos()).rows;
    const antes = await linhaDa(id);
    const key = randomUUID();
    const preparo = await rpcBruto("prepare_install", [actor, key, catalog, "invariant", "guia-tarefas", "1.1.0", 1]);
    expect(preparo).toMatchObject({ kind: "update", status: "preparing", installation_id: id, organization_id: null, applied_now: true,
      result: { from_revision: 1, from_artifact_id: antes.artifact_id, from_version: "1.0.0" } });
    const args = [actor, key, v11.manifest, v11.entry.sha256, v11.entry.byte_length, JSON.stringify(v11.manifest)];
    const feito = await rpcBruto("finish_install", args);
    expect(feito).toMatchObject({ kind: "update", status: "completed", applied_now: true,
      result: { from_revision: 1, from_version: "1.0.0", to_version: "1.1.0", organizations_active: 1 } });
    const depois = await linhaDa(id);
    expect(depois).toMatchObject({ version: "1.1.0", previous_artifact_id: antes.artifact_id, revision: 2, removed_at: null });
    expect(depois.artifact_id).not.toBe(antes.artifact_id);
    expect(feito.result.to_artifact_id).toBe(depois.artifact_id);
    expect((await vinculos()).rows).toEqual(antesDosVinculos);
    const repeticao = await rpcBruto("finish_install", args);
    expect(repeticao.applied_now).toBe(false);
    expect({ ...repeticao, applied_now: true }).toEqual(feito);
    expect((await rpcBruto("prepare_install", [actor, key, catalog, "invariant", "guia-tarefas", "1.1.0", 1])).applied_now).toBe(false);
    expect(await linhaDa(id)).toEqual(depois);
  });

  it("toda preparação de atualização tem saída, e cada saída libera a atualização do sistema", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    const saidas: [string, (op: string) => Promise<unknown>, string, string | null][] = [
      ["falha", op => rpc("fail_install", [actor, op, "extension_download_failed"]), "failed", "extension_download_failed"],
      ["cancelamento por outro administrador", op => rpc("cancel_install", [actor2, op]), "cancelled", null],
      ["revisão nova do catálogo", () => readmitir([base.entry, v11.entry], 3), "cancelled", "extension_catalog_stale"],
    ];
    for (const [saida, sair, status, codigo] of saidas) {
      const p = await prepare(v11, randomUUID(), catalog, actor, 1);
      expect(p.kind, saida).toBe("update");
      await expect(query("insert into system_update_runs(requested_by) values($1)", [actor]), saida).rejects.toThrow("extension_preparation_in_progress");
      await sair(p.id);
      expect((await query("select status,error_code from extension_operations where id=$1", [p.id])).rows[0], saida).toEqual({ status, error_code: codigo });
      expect((await finish(p.id, v11)).status, saida).toBe(status);
      const run = (await query("insert into system_update_runs(requested_by) values($1) returning id", [actor])).rows[0].id;
      await query("update system_update_runs set status='success',finished_at=now() where id=$1", [run]);
    }
    expect(await linhaDa(id)).toMatchObject({ version: "1.0.0", revision: 1, previous_artifact_id: null });
  });

  it("a revisão vista é precondição: aba antiga não troca, não desfaz e não remove o que mudou depois", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    await expect(prepare(v11, randomUUID(), catalog, actor, 2)).rejects.toThrow("extension_version_changed");
    await atualizar(v11, 1);
    // ABA de versão: 1.0 → 1.1 → 1.0 pelo catálogo. A aba que viu a revisão 2 (1.1 com anterior 1.0)
    // quer voltar para 1.0; o anterior agora é a 1.1, e desfazer faria o oposto do que ela pediu.
    expect((await atualizar(base, 2)).kind).toBe("update");
    expect(await linhaDa(id)).toMatchObject({ version: "1.0.0", revision: 3 });
    await expect(desfazer(id, 2)).rejects.toThrow("extension_version_changed");
    await expect(prepare(v11, randomUUID(), catalog, actor, 2)).rejects.toThrow("extension_version_changed");
    // ABA de remoção: remover e reinstalar a MESMA versão; a remoção da aba antiga não apaga a reinstalação.
    await remover(id, 3);
    expect((await atualizar(base, 4)).kind).toBe("install");
    await expect(remover(id, 3)).rejects.toThrow("extension_version_changed");
    await expect(remover(id, 4)).rejects.toThrow("extension_version_changed");
    expect(await linhaDa(id)).toMatchObject({ version: "1.0.0", revision: 5, removed_at: null });
  });

  it("desfazer é a própria inversa, não baixa nada e funciona com a versão fora do catálogo", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    await configure(id);
    await atualizar(v11, 1);
    const antes = await linhaDa(id);
    await readmitir([], 3);
    const artefatos = (await query("select count(*)::int n from extension_artifacts")).rows[0].n;
    const volta = await rpcBruto("revert_install", [actor, randomUUID(), id, 2]);
    expect(volta).toMatchObject({ kind: "revert", status: "completed", applied_now: true, organization_id: null, installation_id: id,
      catalog_id: catalog, publisher: "invariant", name: "guia-tarefas", version: "1.0.0",
      result: { from_revision: 2, from_version: "1.1.0", to_version: "1.0.0", from_artifact_id: antes.artifact_id,
        to_artifact_id: antes.previous_artifact_id, organizations_active: 1 } });
    expect(await linhaDa(id)).toMatchObject({ version: "1.0.0", artifact_id: antes.previous_artifact_id, previous_artifact_id: antes.artifact_id, revision: 3 });
    await desfazer(id, 3);
    expect(await linhaDa(id)).toMatchObject({ version: "1.1.0", artifact_id: antes.artifact_id, previous_artifact_id: antes.previous_artifact_id, revision: 4 });
    expect((await query("select count(*)::int n from extension_artifacts")).rows[0].n).toBe(artefatos);
    expect(await vinculo(orgA, id)).toMatchObject({ enabled: true, revision: 1 });
  });

  it("desfazer recusa sem anterior, removida, preparação em curso e atualização recente do sistema", async () => {
    const v12 = artifact("guia-tarefas", "1.2.0");
    await readmitir([base.entry, v11.entry, v12.entry], 2);
    const id = await install();
    await expect(desfazer(id, 1)).rejects.toThrow("extension_no_previous_version");
    await atualizar(v11, 1);
    const p = await prepare(v12, randomUUID(), catalog, actor, 2);
    await expect(desfazer(id, 2)).rejects.toThrow("extension_preparation_in_progress");
    await rpc("cancel_install", [actor, p.id]);
    const run = (await query("insert into system_update_runs(requested_by,dispatched_at) values($1,now()-interval '1 minute') returning id", [actor])).rows[0].id;
    await expect(desfazer(id, 2)).rejects.toThrow("extension_core_update_in_progress");
    await expect(prepare(v12, randomUUID(), catalog, actor, 2)).rejects.toThrow("extension_core_update_in_progress");
    // Um `dispatched` de mais de 15 minutos é desfecho desconhecido para o app (RUN_STALE_AFTER_MS): não trava.
    await query("update system_update_runs set dispatched_at=now()-interval '16 minutes' where id=$1", [run]);
    expect((await desfazer(id, 2)).status).toBe("completed");
    await query("update system_update_runs set status='failed',finished_at=now() where id=$1", [run]);
    await remover(id, 3);
    await expect(desfazer(id, 4)).rejects.toThrow("extension_removed");
    await expect(desfazer(randomUUID(), 1)).rejects.toThrow("extension_installation_not_found");
  });

  it("remover desliga só os vínculos ativos, em todas as organizações, guarda a configuração e não espera o sistema", async () => {
    const outro = artifact("outro-guia");
    await readmitir([base.entry, outro.entry], 2);
    const id = await install();
    const segundo = await install(outro);
    const vizinha = await install(base, (await admit()).catalog_id);
    const custom = { density: "compact", show_description: false };
    await configure(id, 0, true, custom);
    await configure(id, 0, true, null, randomUUID(), orgB, adminB);
    await configure(segundo, 0, true);
    await configure(segundo, 0, true, null, randomUUID(), orgB, adminB);
    await configure(segundo, 1, false, null, randomUUID(), orgB, adminB);
    await configure(vizinha);
    // Tirar não espera o sistema: a remoção passa com uma atualização recém-disparada.
    const run = (await query("insert into system_update_runs(requested_by) values($1) returning id", [actor])).rows[0].id;
    const key = randomUUID();
    const removido = await rpcBruto("remove_installation", [actor, key, id, 1]);
    expect(removido).toMatchObject({ kind: "removal", status: "completed", applied_now: true, organization_id: null, installation_id: id,
      version: "1.0.0", result: { from_revision: 1, from_version: "1.0.0", organizations_disabled: [orgA, orgB], organizations_disabled_count: 2 } });
    const linha = await linhaDa(id);
    expect(linha).toMatchObject({ revision: 2, removed_by: actor });
    expect(linha.removed_at).not.toBeNull();
    for (const [org, configuracao] of [[orgA, custom], [orgB, base.manifest.configuration]] as const) {
      const v = await vinculo(org, id);
      expect(v).toMatchObject({ enabled: false, revision: 2, configuration: configuracao, updated_by: actor });
      expect(v.deactivated_by_removal_at).not.toBeNull();
    }
    const outraRemocao = await remover(segundo, 1);
    expect(outraRemocao.result).toMatchObject({ organizations_disabled: [orgA], organizations_disabled_count: 1 });
    expect(await vinculo(orgB, segundo)).toMatchObject({ enabled: false, revision: 2, updated_by: adminB, deactivated_by_removal_at: null });
    // A mesma identidade vinda de outro catálogo é outra instalação e continua ativa.
    expect(await vinculo(orgA, vizinha)).toMatchObject({ enabled: true, revision: 1 });
    const repeticao = await rpcBruto("remove_installation", [actor, key, id, 1]);
    expect({ ...repeticao, applied_now: true }).toEqual(removido);
    expect(repeticao.applied_now).toBe(false);
    await expect(remover(id, 2)).rejects.toThrow("extension_removed");
    expect(await linhaDa(id)).toEqual(linha);
    expect(await ativosEmRemovidas()).toBe(0);
    await query("update system_update_runs set status='failed',finished_at=now() where id=$1", [run]);
  });

  it("remover recusa preparação em curso da mesma identidade e instalação inexistente", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    const p = await prepare(v11, randomUUID(), catalog, actor, 1);
    await expect(remover(id, 1)).rejects.toThrow("extension_preparation_in_progress");
    await rpc("cancel_install", [actor, p.id]);
    await expect(remover(randomUUID(), 1)).rejects.toThrow("extension_installation_not_found");
    expect((await remover(id, 1)).status).toBe("completed");
  });

  it("configurar recusa a instalação removida; ativar apaga a marca da remoção e desativar a preserva", async () => {
    const id = await install();
    await configure(id);
    await remover(id, 1);
    await expect(configure(id, 2, true)).rejects.toThrow("extension_removed");
    await expect(configure(id, 2, false)).rejects.toThrow("extension_removed");
    await atualizar(base, 2);
    await configure(id, 2, false, { density: "compact", show_description: true });
    expect((await vinculo(orgA, id)).deactivated_by_removal_at).not.toBeNull();
    await configure(id, 3, true);
    expect(await vinculo(orgA, id)).toMatchObject({ enabled: true, revision: 4, deactivated_by_removal_at: null });
  });

  it("reinstalar limpa a remoção e o anterior, sobe a revisão e deixa as organizações por ativar", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    await configure(id);
    await atualizar(v11, 1);
    await remover(id, 2);
    // A linha removida ainda decide o digest: republicar a mesma versão com outros bytes é conflito.
    await readmitir([base.entry, { ...v11.entry, sha256: "f".repeat(64) }], 3);
    await expect(prepare(v11, randomUUID(), catalog, actor, 3)).rejects.toThrow("extension_version_conflict");
    await readmitir([base.entry, v11.entry], 4);
    const reinstalada = await atualizar(v11, 3);
    expect(reinstalada).toMatchObject({ kind: "install", status: "completed", installation_id: id });
    const linha = await linhaDa(id);
    expect(linha).toMatchObject({ version: "1.1.0", revision: 4, previous_artifact_id: null, removed_at: null, removed_by: null, installed_by: actor });
    const v = await vinculo(orgA, id);
    expect(v).toMatchObject({ enabled: false, revision: 2 });
    expect(v.deactivated_by_removal_at).not.toBeNull();
  });

  it("a mesma versão com outro digest é conflito também contra a versão anterior", async () => {
    await readmitir([base.entry, v11.entry], 2);
    await install();
    await atualizar(v11, 1);
    await readmitir([{ ...base.entry, sha256: "f".repeat(64) }, v11.entry], 3);
    await expect(prepare(base, randomUUID(), catalog, actor, 2)).rejects.toThrow("extension_version_conflict");
  });

  it("repetir uma conclusão antiga depois de outra troca devolve o recibo, sem acusar pacote adulterado", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const instalacao = await prepare();
    const instalada = await finish(instalacao.id);
    const id = instalada.installation_id as string;
    const preparo = await prepare(v11, randomUUID(), catalog, actor, 1);
    const atualizada = await finish(preparo.id, v11);
    expect(await finish(instalacao.id)).toEqual(instalada);
    await desfazer(id, 2);
    expect(await finish(preparo.id, v11)).toEqual(atualizada);
  });

  it("desfazer e remover com a mesma chave e outro pedido são conflito, não um segundo efeito", async () => {
    await readmitir([base.entry, v11.entry], 2);
    const id = await install();
    await atualizar(v11, 1);
    const k = randomUUID();
    const volta = await desfazer(id, 2, k);
    expect(await desfazer(id, 2, k)).toEqual(volta);
    await expect(desfazer(id, 3, k)).rejects.toThrow("extension_idempotency_conflict");
    await expect(remover(id, 3, k)).rejects.toThrow("extension_idempotency_conflict");
    const k2 = randomUUID();
    const removido = await remover(id, 3, k2);
    expect(await remover(id, 3, k2)).toEqual(removido);
    await expect(remover(id, 4, k2)).rejects.toThrow("extension_idempotency_conflict");
    await expect(remover(id, 3, k2, actor2)).rejects.toThrow("extension_idempotency_conflict");
    expect((await query("select count(*)::int n from extension_operations where id in ($1,$2)", [k, k2])).rows[0].n).toBe(2);
  });

  it("o teto de 128 conta só as não removidas, vale na reinstalação e não é consumido por atualização", async () => {
    // Uma revisão de catálogo aceita no máximo 128 entradas: 127 identidades e a 1.1.0 da primeira
    // ficam neste catálogo; a 128ª identidade e a que tenta passar do teto vêm de outra origem.
    const items = Array.from({ length: 127 }, (_, i) => artifact(`teto-${i + 1}`));
    const segundo = items[1];
    if (!segundo) throw new Error("Fixture incompleta: o teto exige 127 identidades neste catálogo");
    const primeiroNovo = artifact("teto-1", "1.1.0");
    const extra = artifact("teto-extra");
    await readmitir([...items.map(x => x.entry), primeiroNovo.entry], 2);
    const outro = (await admit([base.entry, extra.entry])).catalog_id as string;
    const ids: string[] = [];
    for (const item of items) ids.push(await install(item));
    await install(base, outro);
    await expect(prepare(extra, randomUUID(), outro)).rejects.toThrow("extension_installation_limit");
    const atualizacao = await prepare(primeiroNovo, randomUUID(), catalog, actor, 1);
    expect(atualizacao).toMatchObject({ kind: "update", status: "preparing" });
    await rpc("cancel_install", [actor, atualizacao.id]);
    await remover(ids[1] as string, 1);
    const p = await prepare(extra, randomUUID(), outro);
    expect(p.status).toBe("preparing");
    await expect(prepare(segundo, randomUUID(), catalog, actor, 2)).rejects.toThrow("extension_installation_limit");
    await finish(p.id, extra);
    await expect(prepare(segundo, randomUUID(), catalog, actor, 2)).rejects.toThrow("extension_installation_limit");
    await remover(ids[2] as string, 1);
    expect((await prepare(segundo, randomUUID(), catalog, actor, 2)).kind).toBe("install");
  }, 180_000);

  it("a contagem entre organizações só devolve números, e eles batem com a contagem direta", async () => {
    const outro = artifact("outro-guia");
    await readmitir([base.entry, outro.entry], 2);
    const id = await install();
    const segundo = await install(outro);
    await configure(id);
    await configure(id, 0, true, null, randomUUID(), orgB, adminB);
    await configure(segundo);
    await configure(segundo, 0, true, null, randomUUID(), orgB, adminB);
    await configure(segundo, 1, false, null, randomUUID(), orgB, adminB);
    await remover(segundo, 1);
    await atualizar(outro, 2);
    // A contagem atravessa organizações: quem administra só uma organização é recusado no banco.
    for (const who of [adminA, viewer]) {
      await expect(withRole("service_role", "select * from fn_extensions_installation_counts($1)", [who])).rejects.toThrow("extension_forbidden");
    }
    const contagem = await withRole("service_role", "select * from fn_extensions_installation_counts($1)", [actor]);
    expect(contagem.fields.map(f => f.name)).toEqual(["installation_id", "active_organizations", "awaiting_reactivation"]);
    const direta = await query(`select installation_id, count(*) filter (where enabled)::int active_organizations,
      count(*) filter (where not enabled and deactivated_by_removal_at is not null)::int awaiting_reactivation
      from organization_extensions group by installation_id`);
    const porId = (rows: { installation_id: string }[]) => Object.fromEntries(rows.map(r => [r.installation_id, r]));
    expect(porId(contagem.rows)).toEqual(porId(direta.rows));
    expect(porId(contagem.rows)[id]).toEqual({ installation_id: id, active_organizations: 2, awaiting_reactivation: 0 });
    expect(porId(contagem.rows)[segundo]).toEqual({ installation_id: segundo, active_organizations: 0, awaiting_reactivation: 1 });
  });
});

// Corrida entre ativar numa organização e remover da instalação. Duas armadilhas de prova, as duas
// medidas por sabotagem em 16/set:
//  1. Criar um vínculo NOVO trava a instalação pela checagem da chave estrangeira. As provas partem
//     de um vínculo que já existe, desativado.
//  2. O recibo do configure também referencia a instalação, então a ativação espera a remoção de
//     qualquer jeito. Com `lock_timeout` ela desiste nessa espera e a prova fica verde sem o FOR
//     SHARE. O defeito é o que acontece DEPOIS da espera: sem o FOR SHARE, a ativação já leu a
//     instalação como não removida e grava o vínculo ativo quando a remoção confirma. Por isso a
//     primeira prova deixa a ativação esperar (confirmado em pg_stat_activity) e exige o desfecho.
describe("extensões: corrida entre ativar numa organização e remover da instalação", () => {
  async function esperarBloqueio(pid: number) {
    for (let tentativa = 0; tentativa < 200; tentativa += 1) {
      const r = await query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
      if (r.rows[0]?.wait_event_type === "Lock") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("a segunda transação não chegou a esperar a primeira");
  }
  async function duasConexoes<T>(corpo: (a: PoolClient, b: PoolClient, pidB: number) => Promise<T>) {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const pidB = (await b.query("select pg_backend_pid() pid")).rows[0].pid as number;
      return await corpo(a, b, pidB);
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  }
  const desfecho = (pendente: Promise<unknown>) =>
    pendente.then(
      () => "concluiu",
      (error: Error) => error.message,
    );

  it("ativação que esperou uma remoção recebe extension_removed quando a remoção confirma", async () => {
    const id = await install();
    await configure(id, 0, true, null, randomUUID(), orgB, adminB);
    await configure(id);
    await configure(id, 1, false);
    await duasConexoes(async (a, b, pidB) => {
      await a.query("begin");
      await a.query("select public.fn_extensions_remove_installation($1,$2,$3,$4)", [actor, randomUUID(), id, 1]);
      const ativacao = desfecho(
        b.query("select public.fn_extensions_configure($1,$2,$3,$4,$5,$6,$7)", [adminA, orgA, id, randomUUID(), 2, true, null]),
      );
      await esperarBloqueio(pidB);
      await a.query("commit");
      expect(await ativacao).toBe("extension_removed");
    });
    expect(await vinculo(orgA, id)).toMatchObject({ enabled: false, revision: 2, deactivated_by_removal_at: null });
    expect(await ativosEmRemovidas()).toBe(0);
  });

  it("remoção que esperou uma ativação desliga o vínculo que ela acabou de gravar", async () => {
    const id = await install();
    await configure(id);
    await configure(id, 1, false);
    await duasConexoes(async (a, b, pidB) => {
      await a.query("begin");
      await a.query("select public.fn_extensions_configure($1,$2,$3,$4,$5,$6,$7)", [adminA, orgA, id, randomUUID(), 2, true, null]);
      const remocao = b.query("select public.fn_extensions_remove_installation($1,$2,$3,$4) result", [actor, randomUUID(), id, 1]);
      const resultado = remocao.then((r) => r.rows[0].result, (error: Error) => error.message);
      await esperarBloqueio(pidB);
      await a.query("commit");
      expect(await resultado).toMatchObject({ result: { organizations_disabled: [orgA] } });
    });
    expect(await vinculo(orgA, id)).toMatchObject({ enabled: false, revision: 4 });
    expect(await ativosEmRemovidas()).toBe(0);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lerFluxosAtivosDaOrganizacao } from "@/lib/agent-engine/agent/gancho-de-extensao";

// Prova nova, sem mudar os invariantes congelados: RPC real e duas organizações.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});
const actor = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
const viewer = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
const origin = `https://turno-${randomUUID()}.invariant.test`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const log = { info() {}, warn() {}, error() {} };
const permissions = ["turn.send", "turn.handoff"];
let catalog: string;

async function withRole(role: "service_role" | "authenticated" | "anon", sql: string, args: unknown[], user = adminA) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role })]);
    const result = await client.query(sql, args);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function rpc(name: string, args: unknown[]) {
  const result = await withRole("service_role", `select public.fn_extensions_${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`, args);
  return result.rows[0].result;
}

function artifact(version = "1.0.0", declared = permissions) {
  // Cópia isolada da fonte linear arquivada, declarando o contrato atual do turno.
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/extensoes", "laudo-linear-fonte3474.json"), "utf8"));
  manifest.host_api = { min: 3, max: 3 };
  manifest.publisher = "invariante-turno";
  manifest.name = "coleta-do-turno";
  manifest.version = version;
  manifest.permissions = declared;
  const { publisher, name, license, host_api, display } = manifest;
  const entry = { publisher, name, version, license, host_api, display, permissions: declared,
    sha256: hash(manifest), byte_length: Buffer.byteLength(JSON.stringify(manifest)) };
  return { manifest, entry };
}
const base = artifact();

async function admit(entries = [base.entry], revision = 1) {
  const snapshot = { format_version: 1, origin, revision, entries };
  const result = await rpc("admit_catalog", [actor, randomUUID(), snapshot, hash(snapshot)]);
  catalog = result.catalog_id;
}
async function install(item = base, expected: number | null = null) {
  const prepared = await rpc("prepare_install", [actor, randomUUID(), catalog, item.entry.publisher, item.entry.name, item.entry.version, expected]);
  return rpc("finish_install", [actor, prepared.id, item.manifest, item.entry.sha256, item.entry.byte_length, JSON.stringify(item.manifest)]);
}
function configure(id: string, revision: number, enabled: boolean, accepted: unknown = null,
  org = orgA, who = adminA, config: unknown = null, operation = randomUUID()) {
  // `pg` serializa array JS como array PostgreSQL; a RPC recebe JSONB.
  // O nulo continua sendo "preservar aceite", sem conceder nada novo.
  const acceptedJson = accepted === null ? null : JSON.stringify(accepted);
  return rpc("configure", [who, org, id, operation, revision, enabled, config, acceptedJson]);
}
async function binding(org: string, id: string) {
  return (await pool.query("select enabled,revision,accepted_permissions from public.organization_extensions where organization_id=$1 and installation_id=$2", [org, id])).rows[0];
}
async function installation(id: string) {
  return (await pool.query("select revision,artifact_id from public.extension_installations where id=$1", [id])).rows[0];
}
async function clean() {
  await pool.query("delete from public.extension_operations where actor_id=any($1::uuid[])", [[actor, adminA, adminB, viewer]]);
  await pool.query("delete from public.organization_extensions where organization_id=any($1::uuid[])", [[orgA, orgB]]);
  await pool.query("delete from public.extension_installations where catalog_id in(select id from public.extension_catalogs where origin=$1)", [origin]);
  await pool.query("delete from public.extension_artifacts a where a.manifest->>'publisher'='invariante-turno' and not exists(select 1 from public.extension_installations i where i.artifact_id=a.id or i.previous_artifact_id=a.id)");
  await pool.query("delete from public.extension_catalogs where origin=$1", [origin]);
}

beforeAll(async () => {
  for (const id of [actor, adminA, adminB, viewer]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@invariant.test`]);
  }
  for (const org of [orgA, orgB]) {
    await pool.query("insert into public.organizations(id,slug,legal_name,display_name) values($1,$2,'Organização sintética','Organização sintética')", [org, `turno-${org}`]);
  }
  for (const [user, org, role] of [[adminA, orgA, "admin"], [adminB, orgB, "admin"], [viewer, orgA, "viewer"]]) {
    await pool.query("insert into public.user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())", [user, org, role]);
  }
  await pool.query("insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'Prova de consentimento do turno')", [actor]);
});
beforeEach(async () => { await clean(); await admit(); });
afterAll(async () => { await clean(); await pool.end(); });

describe("aceite de turno no banco real", () => {
  it("instalar não autoriza; ativar exige todas as permissões derivadas do desfecho", async () => {
    const installed = await install();
    const id = installed.installation_id;
    expect(await binding(orgA, id)).toBeUndefined();
    await configure(id, 0, false);
    expect((await binding(orgA, id)).accepted_permissions).toEqual([]);
    for (const accepted of [null, ["turn.send"]]) {
      await expect(configure(id, 1, true, accepted)).rejects.toThrow("extension_permission_not_accepted");
    }
    expect((await binding(orgA, id)).revision).toBe(1);
    await configure(id, 1, true, permissions);
    expect(await binding(orgA, id)).toEqual({ enabled: true, revision: 2, accepted_permissions: permissions });
  });

  it("aceite de A não autoriza B e quem só vê não concede", async () => {
    const id = (await install()).installation_id;
    await configure(id, 0, true, permissions);
    await expect(configure(id, 0, true, null, orgB, adminB)).rejects.toThrow("extension_permission_not_accepted");
    await expect(configure(id, 0, true, permissions, orgB, adminA)).rejects.toThrow("extension_forbidden");
    await expect(configure(id, 1, true, permissions, orgA, viewer)).rejects.toThrow("extension_forbidden");
    expect(await binding(orgB, id)).toBeUndefined();
    const hidden = await withRole("authenticated", "select accepted_permissions from public.organization_extensions where organization_id=$1", [orgA], adminB);
    expect(hidden.rows).toEqual([]);
    await configure(id, 0, true, permissions, orgB, adminB);
    expect((await binding(orgB, id)).accepted_permissions).toEqual(permissions);
  });

  it("ativar, desligar, reativar e configurar aumentam a revisão; leitura e retry não aumentam", async () => {
    const id = (await install()).installation_id;
    const operation = randomUUID();
    await configure(id, 0, true, permissions, orgA, adminA, null, operation);
    const installedBefore = await installation(id);
    const first = await binding(orgA, id);
    expect(first.revision).toBe(1);
    const active = await lerFluxosAtivosDaOrganizacao(pool, orgA, log);
    expect(active).toHaveLength(1);
    expect(active[0]?.revisao).toBe(`${id}:1:1`);
    await lerFluxosAtivosDaOrganizacao(pool, orgA, log);
    await configure(id, 0, true, permissions, orgA, adminA, null, operation);
    expect(await binding(orgA, id)).toEqual(first);
    await configure(id, 1, false);
    expect(await lerFluxosAtivosDaOrganizacao(pool, orgA, log)).toEqual([]);
    expect((await binding(orgA, id)).revision).toBe(2);
    await configure(id, 2, true);
    expect((await binding(orgA, id)).revision).toBe(3);
    await configure(id, 3, true, null, orgA, adminA, { density: "compact", show_description: false });
    expect(await binding(orgA, id)).toEqual({ enabled: true, revision: 4, accepted_permissions: permissions });
    expect((await lerFluxosAtivosDaOrganizacao(pool, orgA, log))[0]?.revisao).toBe(`${id}:1:4`);
    expect(await installation(id)).toEqual(installedBefore);
  });

  it("atualização que mantém permissões aumenta revisão da instalação e preserva o vínculo", async () => {
    const id = (await install()).installation_id;
    await configure(id, 0, true, permissions);
    const link = await binding(orgA, id);
    const smaller = artifact("1.1.0");
    smaller.manifest.contributions.turn_flow.perguntas = smaller.manifest.contributions.turn_flow.perguntas.slice(0, 1);
    smaller.entry.sha256 = hash(smaller.manifest);
    smaller.entry.byte_length = Buffer.byteLength(JSON.stringify(smaller.manifest));
    await admit([base.entry, smaller.entry], 2);
    await install(smaller, 1);
    expect((await installation(id)).revision).toBe(2);
    expect(await binding(orgA, id)).toEqual(link);
    expect((await lerFluxosAtivosDaOrganizacao(pool, orgA, log))[0]?.revisao).toBe(`${id}:2:1`);
    await rpc("revert_install", [actor, randomUUID(), id, 2]);
    expect((await installation(id)).revision).toBe(3);
    expect((await lerFluxosAtivosDaOrganizacao(pool, orgA, log))[0]?.revisao).toBe(`${id}:3:1`);
  });

  it("a RPC real continua recusando mudança de permissões entre versões", async () => {
    const id = (await install()).installation_id;
    const changed = artifact("2.0.0", ["turn.send"]);
    changed.manifest.contributions.turn_flow.desfecho = { tipo: "assumir", texto: { "pt-BR": "Coleta encerrada", en: "Collection finished", hi: "संग्रह पूरा हुआ" } };
    changed.entry.sha256 = hash(changed.manifest);
    changed.entry.byte_length = Buffer.byteLength(JSON.stringify(changed.manifest));
    await admit([base.entry, changed.entry], 2);
    await expect(install(changed, 1)).rejects.toThrow("extension_permissions_changed");
    expect((await installation(id)).revision).toBe(1);
  });

  it("leitura opcional é um aceite separado, sem bloquear a coleta e sem conceder por instalação", async () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "extensoes/pacotes", "deskcomm", "consulta-de-laudos-1.0.0.json"), "utf8"));
    manifest.publisher = "invariante-turno";
    manifest.name = "coleta-com-contexto";
    const { publisher, name, version, license, host_api, display, permissions: declared } = manifest;
    const item = { manifest, entry: { publisher, name, version, license, host_api, display, permissions: declared,
      sha256: hash(manifest), byte_length: Buffer.byteLength(JSON.stringify(manifest)) } };
    await admit([base.entry, item.entry], 2);
    const id = (await install(item)).installation_id;
    await configure(id, 0, true, permissions);
    expect((await binding(orgA, id)).accepted_permissions).toEqual(permissions);
    expect((await lerFluxosAtivosDaOrganizacao(pool, orgA, log))[0]?.aceitas).not.toContain("turn.context");
    await configure(id, 1, true, [...permissions, "turn.context"]);
    expect((await binding(orgA, id)).accepted_permissions).toEqual([...permissions, "turn.context"]);
    expect(await binding(orgB, id)).toBeUndefined();
  });

  it("baseline inteiro reaplica com ON_ERROR_STOP=1 sobre aceite de leitura e o preserva", async () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "extensoes/pacotes", "deskcomm", "consulta-de-laudos-1.0.0.json"), "utf8"));
    manifest.publisher = "invariante-turno";
    manifest.name = "coleta-reaplicada";
    const { publisher, name, version, license, host_api, display, permissions: declared } = manifest;
    const item = { manifest, entry: { publisher, name, version, license, host_api, display, permissions: declared,
      sha256: hash(manifest), byte_length: Buffer.byteLength(JSON.stringify(manifest)) } };
    await admit([base.entry, item.entry], 2);
    const id = (await install(item)).installation_id;
    await configure(id, 0, true, [...permissions, "turn.context"]);
    const before = await binding(orgA, id);
    const replay = spawnSync("docker", ["exec", "-i", process.env.TEST_DB_CONTAINER!,
      "psql", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input: readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8"),
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    expect(replay.error, "psql precisa executar o baseline integral").toBeUndefined();
    expect(replay.status, replay.stderr.slice(-3000)).toBe(0);
    expect(replay.stderr.split("\n").filter((line) => /\b(ERROR|FATAL)\b/.test(line))).toEqual([]);
    expect(await binding(orgA, id)).toEqual(before);
    const check = await pool.query("select convalidated from pg_constraint where conrelid='public.organization_extensions'::regclass and conname='organization_extensions_accepted_permissions_check'");
    expect(check.rows).toEqual([{ convalidated: true }]);
  }, 300_000);

  it("a assinatura nova de configurar não é RPC pública e a antiga não sobrevive", async () => {
    const signature = "public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb,jsonb)";
    for (const role of ["anon", "authenticated"]) {
      expect((await pool.query("select has_function_privilege($1,$2,'execute') permitido", [role, signature])).rows[0].permitido).toBe(false);
    }
    expect((await pool.query("select to_regprocedure('public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb)') is null sumiu")).rows[0].sumiu).toBe(true);
  });
});

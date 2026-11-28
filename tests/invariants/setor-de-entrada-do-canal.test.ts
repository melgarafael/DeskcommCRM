/**
 * #5374 — O NÚMERO PODE ENTRAR DIRETO NUMA FILA (ADR-0008, D1).
 *
 * `channel_routing_policies.sector_id` é a fila de entrada do número. A
 * conversa desse número entra na fila (`trg_conversation_apply_channel_sector`)
 * quando NASCE e quando o contato que volta REABRE a conversa encerrada — a
 * conversa é 1:1 por (organização, contato, número), e `fn_service_inbound`
 * reabre a mesma linha por UPDATE. A distribuição passa a escolher entre os
 * membros da fila; isso já é do claim (9062). Sem setor na regra, nada muda.
 *
 * O que este arquivo prova, em Postgres real, pela MESMA porta da tela
 * (`fn_set_channel_routing_with_sector`, com sessão):
 *   1. o admin grava o setor e a conversa nova nasce nele;
 *   2. a conversa que já chega com setor fica com o dela;
 *   3. sem setor na regra (ou sem regra), a conversa nasce sem setor;
 *   4. a conversa encerrada que reabre sem fila entra na fila do número, e a
 *      que já tem fila (transferida antes) fica com a dela;
 *   5. com o módulo `setores` desligado, o gatilho não grava fila;
 *   6. viewer e manager são recusados (definir a fila é de admin), setor de
 *      outra organização é recusado e fila sem atendente ativo é recusada.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GOV_ADMIN as admin,
  GOV_AGENT_A as atendente,
  GOV_CONTACT_PROBE as contato,
  GOV_MANAGER as manager,
  GOV_ORG as org,
  GOV_SESSION as channel,
  GOV_VIEWER as viewer,
  seedGov,
} from "./gov-helpers";

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const CONVERSA = "cccccccc-4444-4000-8000-0000000053a4";
const OUTRA_ORG = "dddddddd-0000-4000-8000-0000000053a4";

async function asUser(user: string, text: string, args: unknown[] = [], aal = "aal1") {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

const gravarSetor = (setor: string | null, quem = admin) =>
  asUser(quem, "select fn_set_channel_routing_with_sector($1,$2,$3,$4,$5,$6) result", [
    org, channel, [], null, null, setor,
  ]);

const setorDaConversa = async () =>
  (await query("select sector_id from conversations where id=$1", [CONVERSA])).rows[0].sector_id as string | null;

const conversaNova = async (setor: string | null = null, status = "open") => {
  await query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,sector_id) values($1,$2,$3,$4,$5,$6)",
    [CONVERSA, org, contato, channel, status, setor],
  );
  return setorDaConversa();
};

/** Setor com um atendente ativo — a fila que a tela aceita. */
const setor = async (organizacao: string, nome: string, comAtendente = true) => {
  const id = (await query("insert into attendant_sectors (organization_id, name) values ($1,$2) returning id", [organizacao, nome])).rows[0].id as string;
  if (comAtendente) {
    await query(
      "insert into attendant_sector_members (organization_id, sector_id, user_id) values ($1,$2,$3) on conflict do nothing",
      [organizacao, id, atendente],
    );
  }
  return id;
};

const ligarSetores = () =>
  query("insert into platform_config (chave, valor) values ('MODULO_SETORES','ligado') on conflict (chave) do update set valor='ligado'");

beforeAll(async () => {
  seedGov();
  await query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'setor-de-entrada-outra','Outra','Outra') on conflict (id) do nothing",
    [OUTRA_ORG],
  );
});
afterAll(async () => {
  await query("delete from platform_config where chave='MODULO_SETORES'");
  await pool.end();
});
beforeEach(async () => {
  await ligarSetores();
  await query("delete from conversations where id=$1", [CONVERSA]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
});

describe("setor de entrada do número", () => {
  it("o admin grava o setor e a conversa nova nasce nele", async () => {
    const recepcao = await setor(org, "Recepção 5374");
    const r = await gravarSetor(recepcao);
    expect(r.rows[0].result).toMatchObject({ sector_id: recepcao, mode: "restricted_empty" });
    expect((await query("select sector_id from channel_routing_policies where organization_id=$1 and channel_session_id=$2", [org, channel])).rows[0].sector_id).toBe(recepcao);
    expect(await conversaNova()).toBe(recepcao);
  });

  it("a conversa que já chega com setor fica com o dela", async () => {
    const recepcao = await setor(org, "Recepção B 5374");
    const financeiro = await setor(org, "Financeiro 5374");
    await gravarSetor(recepcao);
    expect(await conversaNova(financeiro)).toBe(financeiro);
  });

  it("sem setor na regra, ou sem regra, a conversa nasce sem setor", async () => {
    await gravarSetor(null);
    expect(await conversaNova()).toBeNull();
    await query("delete from conversations where id=$1", [CONVERSA]);
    await query("delete from channel_routing_policies where organization_id=$1", [org]);
    expect(await conversaNova()).toBeNull();
  });

  it("contato que volta: a conversa encerrada reabre sem fila e entra na fila do número", async () => {
    // A conversa existia antes de a fila ser definida — o caso de toda
    // instalação que já atende. A reabertura é o UPDATE de fn_service_inbound.
    expect(await conversaNova(null, "closed")).toBeNull();
    const recepcao = await setor(org, "Recepção D 5374");
    await gravarSetor(recepcao);
    // Mexer na conversa encerrada sem reabri-la não a põe na fila.
    await query("update conversations set status='archived' where id=$1", [CONVERSA]);
    expect(await setorDaConversa()).toBeNull();
    await query("update conversations set status='open' where id=$1", [CONVERSA]);
    expect(await setorDaConversa()).toBe(recepcao);
  });

  it("conversa reaberta que já tem fila fica com a dela", async () => {
    const pedagogia = await setor(org, "Pedagogia 5374");
    expect(await conversaNova(pedagogia, "closed")).toBe(pedagogia);
    const secretaria = await setor(org, "Secretaria 5374");
    await gravarSetor(secretaria);
    await query("update conversations set status='open' where id=$1", [CONVERSA]);
    expect(await setorDaConversa()).toBe(pedagogia);
  });

  it("módulo setores desligado: a conversa nasce e reabre sem fila", async () => {
    const recepcao = await setor(org, "Recepção E 5374");
    await gravarSetor(recepcao);
    await query("delete from platform_config where chave='MODULO_SETORES'");
    expect(await conversaNova()).toBeNull();
    await query("update conversations set status='closed' where id=$1", [CONVERSA]);
    await query("update conversations set status='open' where id=$1", [CONVERSA]);
    expect(await setorDaConversa()).toBeNull();
  });

  it("viewer e manager são recusados; setor alheio e fila sem atendente também", async () => {
    const meu = await setor(org, "Recepção C 5374");
    await expect(gravarSetor(meu, viewer)).rejects.toMatchObject({ code: "42501" });
    await expect(gravarSetor(meu, manager)).rejects.toMatchObject({ code: "42501", message: "routing_forbidden" });
    const alheio = await setor(OUTRA_ORG, "Recepção alheia 5374", false);
    await expect(gravarSetor(alheio)).rejects.toMatchObject({ code: "22023", message: "routing_invalid_sector" });
    const vazia = await setor(org, "Fila vazia 5374", false);
    await expect(gravarSetor(vazia)).rejects.toMatchObject({ code: "22023", message: "routing_sector_without_members" });
    expect((await query("select count(*)::int n from channel_routing_policies where organization_id=$1", [org])).rows[0].n).toBe(0);
  });
});

/**
 * A OUVIDORIA REGISTRA, E O REGISTRO NÃO PASSA PELO FUNIL (#3611, fatia 1).
 *
 * Três garantias, e cada caso existe porque a sua ausência é um defeito que
 * ninguém veria na tela:
 *
 * 1. **Protocolo do SERVIDOR.** Um protocolo aceito do cliente é um número que
 *    a pessoa pode escolher — e escolher o número de outra manifestação. O
 *    caso que importa não é "sai um protocolo bonito", é o que ACONTECE quando
 *    alguém manda um: recusa, zero escrita.
 *
 * 2. **Sem card no funil.** É o controle central da issue. O dublê registra
 *    TODA escrita, então "registrar só escreve em `ouvidoria_manifestacoes`" é
 *    medido, não prometido: uma linha em `crm_leads` reprova o caso.
 *
 * 3. **Sem vazamento entre tenants.** A gravação roda com cliente de serviço (o
 *    canal não tem JWT), onde a RLS não separa nada: o predicado escrito à mão
 *    é a única cerca. O caso do contato de outra organização e o da leitura
 *    cruzada medem exatamente esse predicado — foi ele que a sabotagem removeu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { lerManifestacao } from "@/lib/ouvidoria/leitura";
import { gerarProtocolo, registrarManifestacao } from "@/lib/ouvidoria/registro";
import { OUTRA_ORG, ORG_ID, makeDb } from "@/tests/helpers/stages-db-double";

const CONTATO = "55555555-5555-4555-8555-555555555555";
const LIGADO = { ouvidoria: { ativa: true } };

function deps(db: ReturnType<typeof makeDb>, organizationId = ORG_ID) {
  return { supabase: db.client as unknown as SupabaseClient, organizationId };
}

function comContato(db: ReturnType<typeof makeDb>, org = ORG_ID) {
  db.tabelas.contacts.push({ id: CONTATO, organization_id: org, display_name: "Quem reclamou" });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. o protocolo
// ---------------------------------------------------------------------------

describe("gerarProtocolo — o número é do servidor", () => {
  it("segue OUV-AAAAMMDD-XXXXXXXX, com o dia em UTC", () => {
    const protocolo = gerarProtocolo(new Date("2026-10-28T23:30:00-03:00"), () =>
      Buffer.from([0x0a, 0x1b, 0x2c, 0x3d]),
    );

    // 29/10 em UTC — e é de propósito: o protocolo é identificador, não data de
    // exibição (a tela mostra `created_at` no fuso da organização).
    expect(protocolo).toBe("OUV-20261029-0A1B2C3D");
    expect(protocolo).toMatch(/^OUV-\d{8}-[0-9A-F]{8}$/);
  });

  it("dois protocolos seguidos não são o mesmo número", () => {
    expect(gerarProtocolo()).not.toBe(gerarProtocolo());
  });
});

// ---------------------------------------------------------------------------
// 2. o registro
// ---------------------------------------------------------------------------

describe("registrarManifestacao — a linha nasce com protocolo do servidor", () => {
  it("grava a manifestação com protocolo gerado aqui, status recebida", async () => {
    const db = makeDb({ organizationSettings: LIGADO });

    const resultado = await registrarManifestacao(deps(db), {
      texto: "  O pedido nunca chegou e ninguém respondeu.  ",
      canal: "whatsapp",
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.manifestacao.protocolo).toMatch(/^OUV-\d{8}-[0-9A-F]{8}$/);
    expect(resultado.manifestacao.status).toBe("recebida");
    expect(resultado.manifestacao.createdAt).toEqual(expect.any(String));

    // A escrita é EXATAMENTE esta: nem coluna do funil, nem protocolo vindo de
    // fora (ele é o que a função gerou).
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]!.table).toBe("ouvidoria_manifestacoes");
    expect(db.escritas[0]!.patch).toEqual({
      organization_id: ORG_ID,
      protocolo: resultado.manifestacao.protocolo,
      canal: "whatsapp",
      texto: "O pedido nunca chegou e ninguém respondeu.",
      contact_id: null,
      status: "recebida",
    });
  });

  it("⭐ protocolo vindo do cliente é RECUSADO, e nada é gravado", async () => {
    const db = makeDb({ organizationSettings: LIGADO });

    const resultado = await registrarManifestacao(deps(db), {
      texto: "Quero reclamar do atendimento.",
      canal: "web",
      // O cliente não escolhe o número: `strictObject` recusa o objeto inteiro.
      protocolo: "OUV-20260101-00000000",
    });

    expect(resultado).toEqual({ ok: false, erro: "validacao" });
    expect(db.escritas).toHaveLength(0);
  });

  it("⭐ registrar NÃO cria negócio no funil — nem lê o funil", async () => {
    const db = makeDb({ organizationSettings: LIGADO, leads: [] });
    db.tabelas.crm_stages.push({ id: "e1", organization_id: ORG_ID, pipeline_id: "p1" });

    const resultado = await registrarManifestacao(deps(db), {
      texto: "A entrega atrasou duas semanas.",
      canal: "telefone",
    });

    expect(resultado.ok).toBe(true);
    // O controle central da issue, medido nas três tabelas do funil.
    const tabelasEscritas = db.escritas.map((e) => e.table);
    expect(tabelasEscritas).toEqual(["ouvidoria_manifestacoes"]);
    expect(db.tabelas.crm_leads).toHaveLength(0);
    expect(db.tabelas.crm_lead_activities).toHaveLength(0);
    // Nenhuma RPC: o registro não chama a criação de negócio nem o evento.
    expect(db.rpcs).toHaveLength(0);
  });

  it("módulo desligado (ou sem a chave) não registra nada", async () => {
    for (const settings of [null, {}, { ouvidoria: { ativa: false } }, { ouvidoria: { ativa: "true" } }]) {
      const db = makeDb({ organizationSettings: settings });
      const resultado = await registrarManifestacao(deps(db), {
        texto: "Reclamação de um módulo desligado.",
        canal: "web",
      });

      // `"true"` como STRING é lixo, não liga: a régua é o booleano explícito.
      expect(resultado).toEqual({ ok: false, erro: "modulo_desligado" });
      expect(db.escritas).toHaveLength(0);
    }
  });

  it("texto vazio, canal inventado e texto acima do teto são validação", async () => {
    const db = makeDb({ organizationSettings: LIGADO });

    for (const entrada of [
      { texto: "   ", canal: "whatsapp" },
      { texto: "ok", canal: "pombo-correio" },
      { texto: "x".repeat(20001), canal: "whatsapp" },
      { texto: "ok", canal: "whatsapp", status: "concluida" },
      {},
    ]) {
      await expect(registrarManifestacao(deps(db), entrada)).resolves.toEqual({
        ok: false,
        erro: "validacao",
      });
    }
    expect(db.escritas).toHaveLength(0);
  });

  it("contato de OUTRA organização não é aceito como autor do relato", async () => {
    const db = comContato(makeDb({ organizationSettings: LIGADO }), OUTRA_ORG);

    const resultado = await registrarManifestacao(deps(db), {
      texto: "Relato com contato do vizinho.",
      canal: "web",
      contactId: CONTATO,
    });

    expect(resultado).toEqual({ ok: false, erro: "contato_invalido" });
    expect(db.escritas).toHaveLength(0);
  });

  it("contato da própria organização é gravado na linha", async () => {
    const db = comContato(makeDb({ organizationSettings: LIGADO }));

    const resultado = await registrarManifestacao(deps(db), {
      texto: "Relato identificado.",
      canal: "presencial",
      contactId: CONTATO,
    });

    expect(resultado.ok).toBe(true);
    expect(db.escritas[0]!.patch).toMatchObject({ contact_id: CONTATO });
  });

  it("colisão de protocolo repete UMA vez, com número novo", async () => {
    const db = makeDb({
      organizationSettings: LIGADO,
      writeError: (n) => (n === 1 ? { code: "23505", message: "duplicate key value" } : null),
    });

    const resultado = await registrarManifestacao(deps(db), {
      texto: "Duas manifestações no mesmo segundo.",
      canal: "whatsapp",
    });

    expect(resultado.ok).toBe(true);
    const protocolos = db.escritas.map((e) => (e.patch as Record<string, unknown>).protocolo);
    expect(protocolos).toHaveLength(2);
    expect(protocolos[0]).not.toBe(protocolos[1]);
  });

  it("erro do banco devolve `erro_ao_gravar` — nunca lança no turno do canal", async () => {
    const db = makeDb({
      organizationSettings: LIGADO,
      writeError: () => ({ code: "08006", message: "connection failure" }),
    });

    await expect(
      registrarManifestacao(deps(db), { texto: "Relato durante queda do banco.", canal: "web" }),
    ).resolves.toEqual({ ok: false, erro: "erro_ao_gravar" });
  });
});

// ---------------------------------------------------------------------------
// 3. a leitura
// ---------------------------------------------------------------------------

describe("lerManifestacao — a organização é a chave, sempre", () => {
  const MANIFESTACAO = {
    id: "66666666-6666-4666-8666-666666666666",
    organization_id: OUTRA_ORG,
    protocolo: "OUV-20261028-ABCD1234",
    canal: "whatsapp",
    texto: "Relato sigiloso da empresa vizinha.",
    contact_id: null,
    status: "recebida",
    created_at: "2026-10-28T12:00:00.000Z",
    updated_at: "2026-10-28T12:00:00.000Z",
  };

  it("⭐ outra organização NÃO lê a manifestação da vizinha", async () => {
    const db = makeDb({ manifestacoes: [MANIFESTACAO] });

    await expect(lerManifestacao(deps(db, ORG_ID), MANIFESTACAO.id)).resolves.toEqual({
      ok: false,
      erro: "nao_encontrada",
    });
    // A dona lê a mesma linha (o controle positivo do caso acima).
    await expect(lerManifestacao(deps(db, OUTRA_ORG), MANIFESTACAO.id)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("id que não é uuid responde `nao_encontrada`, sem consultar o banco", async () => {
    const db = makeDb({ manifestacoes: [MANIFESTACAO] });

    await expect(lerManifestacao(deps(db), "1")).resolves.toEqual({
      ok: false,
      erro: "nao_encontrada",
    });
    expect(db.escritas).toHaveLength(0);
  });

  it("a linha lida devolve o texto e o protocolo, com o contato opcional nulo", async () => {
    const db = makeDb({ manifestacoes: [MANIFESTACAO] });

    const resultado = await lerManifestacao(deps(db, OUTRA_ORG), MANIFESTACAO.id);

    expect(resultado).toEqual({
      ok: true,
      manifestacao: {
        id: MANIFESTACAO.id,
        protocolo: "OUV-20261028-ABCD1234",
        canal: "whatsapp",
        texto: "Relato sigiloso da empresa vizinha.",
        contactId: null,
        status: "recebida",
        createdAt: "2026-10-28T12:00:00.000Z",
        updatedAt: "2026-10-28T12:00:00.000Z",
      },
    });
  });
});

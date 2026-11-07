import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A pergunta do apagado a pedido na AGENDA DO APP, feita UMA vez por LOTE.
 *
 * A pergunta unitária (`fn_titular_apagado_a_pedido`) já barrava o titular
 * apagado neste caminho, mas era chamada DENTRO do laço: um round-trip por
 * contato, para sempre, mesmo quando a organização nunca apagou ninguém. Um
 * webhook `smb_app_state_sync` entrega `state_sync[]` com vários contatos, então
 * o desenho certo é o do lote: uma consulta (`fn_titulares_apagados_a_pedido`,
 * migration 9222) para todos, e zero por contato.
 *
 * Os seis lados que este arquivo mede:
 *   1. número do lote marcado ⇒ `ignored`, sem upsert e sem pergunta individual;
 *   2. contato normal ⇒ sincroniza igual (mesmo upsert, mesmo nome), e o lote de
 *      N contatos custa UMA consulta — nenhuma por contato;
 *   3. ficha JÁ anonimizada ⇒ `ignored: contato_anonimizado` (a marca da 0750
 *      não existe para quem foi anonimizado antes dela), sem upsert e sem nome;
 *   4. outra organização ⇒ a pergunta é feita com a organização da sessão, e o
 *      número de OUTRA organização não é pulado;
 *   5. lote com erro ⇒ cada evento cai na pergunta individual (falha fechada,
 *      sem parar o lote): o contato seguinte continua sincronizando;
 *   6. idempotência ⇒ rodar o mesmo lote duas vezes dá o mesmo resultado.
 */

const estado = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  contato: null as { id: string; phone_number: string | null; is_anonymized?: boolean } | null,
  lote: { data: [] as unknown, error: null as { message: string } | null },
  individual: { data: false as unknown, error: null as { message: string } | null },
  gravacoes: [] as Array<{ payload: Record<string, unknown>; filtros: Array<[string, unknown]> }>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => estado.contato,
  encontrarContatoPorTelefoneComAnonimizacao: async () => estado.contato,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: async () => undefined }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

import { ingestMetaAppContactSync } from "@/lib/channels/meta/ingest";
import {
  MOTIVO_CONTATO_ANONIMIZADO,
  MOTIVO_TITULAR_APAGADO,
  perguntarTitularesApagadosNoLote,
  telefonesDoLote,
} from "@/lib/channels/meta/titular-apagado";
import type { AppContactSyncEvent } from "@/lib/channels/meta/webhook";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";

/** Número de teste, e o MESMO em todas as asserções via `canonicalPhoneBR`. */
const TELEFONE = "5519999999999";
const OUTRO = "5519988887777";
/**
 * A outra grafia do MESMO número, tirada da própria regra do CRM em vez de
 * digitada à mão: erro de dígito aqui viraria um teste que passa medindo o
 * número errado.
 */
const SEM_NONO = phoneLookupVariants(OUTRO).sort((a, b) => a.length - b.length)[0]!;

function evento(phone: string, name = "Ana Souza"): AppContactSyncEvent {
  return {
    kind: "app_contact_sync",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    phone,
    name,
    action: "add",
  };
}

function adminFalso(orgDaSessao = "org-1"): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: { id: "session-1", organization_id: orgDaSessao },
          error: null,
        }),
      };
      return chain;
    }
    if (table === "contacts") {
      return {
        update: (payload: Record<string, unknown>) => {
          const registro = { payload, filtros: [] as Array<[string, unknown]> };
          estado.gravacoes.push(registro);
          const chain: Record<string, unknown> = {
            eq: (coluna: string, valor: unknown) => {
              registro.filtros.push([coluna, valor]);
              return chain;
            },
            then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
          };
          return chain;
        },
      };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_titulares_apagados_a_pedido") return estado.lote;
    if (name === "fn_titular_apagado_a_pedido") return estado.individual;
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const DONO = { organizationId: "org-1" } as never;
const chamadas = (nome: string) => estado.rpcs.filter((r) => r.name === nome);
const criouContato = () => chamadas("fn_upsert_wa_contact").length;

beforeEach(() => {
  estado.rpcs = [];
  estado.contato = null;
  estado.lote = { data: [], error: null };
  estado.individual = { data: false, error: null };
  estado.gravacoes = [];
});

describe("perguntarTitularesApagadosNoLote", () => {
  it("canonicaliza, tira repetido e faz UMA consulta com o lote inteiro", async () => {
    estado.lote = { data: [canonicalPhoneBR(TELEFONE)], error: null };

    const r = await perguntarTitularesApagadosNoLote(adminFalso(), "org-1", [
      TELEFONE,
      TELEFONE,
      OUTRO,
      "",
    ]);

    expect(chamadas("fn_titulares_apagados_a_pedido")).toHaveLength(1);
    expect(estado.rpcs[0]?.args).toMatchObject({
      p_org: "org-1",
      p_telefones: [canonicalPhoneBR(TELEFONE), canonicalPhoneBR(OUTRO)],
    });
    expect([...r.apagados]).toEqual([canonicalPhoneBR(TELEFONE)]);
    expect(r.erro).toBeUndefined();
  });

  it("lote sem telefone não consulta nada", async () => {
    const r = await perguntarTitularesApagadosNoLote(adminFalso(), "org-1", []);

    expect(estado.rpcs).toEqual([]);
    expect([...r.apagados]).toEqual([]);
  });

  it("erro e resposta fora do contrato NÃO viram 'ninguém apagado' em silêncio", async () => {
    estado.lote = { data: null, error: { message: "boom" } };
    const comErro = await perguntarTitularesApagadosNoLote(adminFalso(), "org-1", [TELEFONE]);
    expect(comErro.erro).toBe("boom");

    estado.lote = { data: null, error: null };
    const semLista = await perguntarTitularesApagadosNoLote(adminFalso(), "org-1", [TELEFONE]);
    expect(semLista.erro).toBe("resposta sem lista");
  });

  it("telefonesDoLote resolve variantes para a forma canônica do CRM", () => {
    expect(telefonesDoLote([OUTRO, SEM_NONO])).toEqual([canonicalPhoneBR(OUTRO)]);
  });
});

describe("a sincronização de contatos com o lote já respondido", () => {
  it("número do titular apagado: ignora, não cria e NÃO pergunta de novo por contato", async () => {
    const apagados = new Set([canonicalPhoneBR(TELEFONE)]);

    const r = await ingestMetaAppContactSync(adminFalso(), evento(TELEFONE), DONO, apagados);

    // A recriação é o defeito: esta asserção vem antes do desfecho.
    expect(criouContato()).toBe(0);
    expect(estado.gravacoes).toEqual([]);
    expect(r).toEqual({ status: "ignored", reason: MOTIVO_TITULAR_APAGADO });
    // Sem N+1: nenhuma pergunta individual, nem para este contato.
    expect(chamadas("fn_titular_apagado_a_pedido")).toEqual([]);
  });

  it("contato normal sincroniza igual, e 5 contatos custam UMA consulta no total", async () => {
    const telefones = [TELEFONE, OUTRO, "5519977776666", "5519966665555", "5519955554444"];
    const admin = adminFalso();

    const lote = await perguntarTitularesApagadosNoLote(admin, "org-1", telefones);
    const desfechos = [];
    for (const phone of telefones) {
      desfechos.push(await ingestMetaAppContactSync(admin, evento(phone, "Ana Souza"), DONO, lote.apagados));
    }

    expect(chamadas("fn_titulares_apagados_a_pedido")).toHaveLength(1);
    expect(chamadas("fn_titular_apagado_a_pedido")).toEqual([]);
    expect(criouContato()).toBe(5);
    expect(desfechos.every((d) => d.status === "synced")).toBe(true);
    // Mesmo upsert de hoje, e o nome da agenda no campo que só a equipe vê.
    expect(estado.gravacoes.map((g) => g.payload)).toEqual(
      telefones.map(() => ({ address_book_name: "Ana Souza" })),
    );
    expect(estado.gravacoes[0]?.filtros).toContainEqual(["is_anonymized", false]);
  });

  it("ficha JÁ anonimizada que ainda é achada pelo número: ignora, sem nome e sem telefone", async () => {
    estado.contato = { id: "contact-antigo", phone_number: null, is_anonymized: true };

    const r = await ingestMetaAppContactSync(adminFalso(), evento(TELEFONE), DONO, new Set());

    expect(criouContato()).toBe(0);
    expect(estado.gravacoes).toEqual([]);
    expect(r).toEqual({ status: "ignored", reason: MOTIVO_CONTATO_ANONIMIZADO });
  });

  it("ficha normal existente continua recebendo o nome da agenda", async () => {
    estado.contato = { id: "contact-1", phone_number: canonicalPhoneBR(OUTRO), is_anonymized: false };

    const r = await ingestMetaAppContactSync(adminFalso(), evento(OUTRO), DONO, new Set());

    expect(r).toEqual({ status: "synced", contactId: "contact-1" });
    // O upsert usa o telefone da FICHA, não a grafia do payload.
    expect(chamadas("fn_upsert_wa_contact")[0]?.args).toMatchObject({
      p_phone: canonicalPhoneBR(OUTRO),
    });
    expect(estado.gravacoes[0]?.payload).toEqual({ address_book_name: "Ana Souza" });
  });

  it("outra organização: a pergunta vai com a organização DA SESSÃO, e o número de lá não é pulado", async () => {
    estado.lote = { data: [], error: null };
    const admin = adminFalso("org-2");

    const lote = await perguntarTitularesApagadosNoLote(admin, "org-2", [TELEFONE]);
    const r = await ingestMetaAppContactSync(admin, evento(TELEFONE), { organizationId: "org-2" } as never, lote.apagados);

    expect(chamadas("fn_titulares_apagados_a_pedido")[0]?.args).toMatchObject({ p_org: "org-2" });
    expect(r.status).toBe("synced");
    expect(chamadas("fn_upsert_wa_contact")[0]?.args).toMatchObject({ p_org: "org-2" });
  });

  it("lote com erro: cai na pergunta individual, falha fechada, e NÃO para a fila", async () => {
    const lote = await perguntarTitularesApagadosNoLote(
      { rpc: async () => ({ data: null, error: { message: "sem função" } }) } as unknown as SupabaseClient,
      "org-1",
      [TELEFONE, OUTRO],
    );
    expect(lote.erro).toBe("sem função");

    // O MESMO que os chamadores fazem: lote sem resposta (erro) ⇒ `undefined`,
    // e a ingestão pergunta sozinha, uma vez, por contato.
    const semLote = lote.erro ? undefined : lote.apagados;
    estado.individual = { data: null, error: { message: "boom" } };
    const primeiro = await ingestMetaAppContactSync(adminFalso(), evento(TELEFONE), DONO, semLote);
    estado.individual = { data: false, error: null };
    const segundo = await ingestMetaAppContactSync(adminFalso(), evento(OUTRO), DONO, semLote);

    expect(primeiro.status).toBe("failed");
    expect(segundo.status).toBe("synced");
    expect(criouContato()).toBe(1);
  });
});

describe("idempotência", () => {
  it("o mesmo lote rodado duas vezes dá o mesmo resultado", async () => {
    estado.lote = { data: [canonicalPhoneBR(TELEFONE)], error: null };
    const admin = adminFalso();
    const lote = await perguntarTitularesApagadosNoLote(admin, "org-1", [TELEFONE, OUTRO]);

    const primeira = [];
    for (const phone of [TELEFONE, OUTRO]) {
      primeira.push(await ingestMetaAppContactSync(admin, evento(phone), DONO, lote.apagados));
    }
    const depoisDaPrimeira = criouContato();
    estado.rpcs = [];

    const segunda = [];
    for (const phone of [TELEFONE, OUTRO]) {
      segunda.push(await ingestMetaAppContactSync(admin, evento(phone), DONO, lote.apagados));
    }

    expect(segunda).toEqual(primeira);
    expect(segunda[0]).toEqual({ status: "ignored", reason: MOTIVO_TITULAR_APAGADO });
    expect(depoisDaPrimeira).toBe(1);
    expect(criouContato()).toBe(1);
  });
});

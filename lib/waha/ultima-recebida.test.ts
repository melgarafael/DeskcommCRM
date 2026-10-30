import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

import { chatIdDaUltimaRecebida, chatIndividualDaMensagem } from "./ultima-recebida";

/**
 * O dublê do Supabase guarda as respostas por tabela e anota cada filtro. A
 * cadeia é "thenable": o `await` no fim de `.limit(1)` resolve a resposta da
 * tabela, do mesmo jeito que o cliente real faz.
 */
let respostas: Record<string, { data: unknown; error: unknown }>;
let filtros: Record<string, string[]>;
let consultadas: string[];

function adminDeTeste(): SupabaseClient {
  return {
    from(tabela: string) {
      consultadas.push(tabela);
      filtros[tabela] ??= [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filtros[tabela]!.push(`${col}=${String(val)}`);
          return chain;
        },
        not: (col: string, op: string) => {
          filtros[tabela]!.push(`not:${col}:${op}`);
          return chain;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          filtros[tabela]!.push(`order:${col}:${opts.ascending ? "asc" : "desc"}`);
          return chain;
        },
        limit: () => chain,
        then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
          Promise.resolve(respostas[tabela] ?? { data: [], error: null }).then(ok, falha),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const ARGS = { organizationId: "org-A", conversationId: "conv-1", contactId: "ficha-1" };

beforeEach(() => {
  respostas = {};
  filtros = {};
  consultadas = [];
  mocks.warn.mockClear();
});

describe("chatIdDaUltimaRecebida — o número que a pessoa escreveu", () => {
  it("ficha SEM telefone extra → null, e nem consulta as mensagens", async () => {
    respostas = {
      contact_phones: { data: [], error: null },
      messages: { data: [{ external_id: "false_5515999998888@c.us_3EB0AAA" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBeNull();
    expect(consultadas).not.toContain("messages");
    // Sabotagem: tirar a 1ª consulta (a da ficha com extra) faz a ficha sem extra
    // consultar as mensagens e responder pelo chat delas — muda o envio de quem não
    // tem telefone extra, e este teste fica vermelho.
  });

  it("ficha COM extra e última mensagem recebida em @c.us → devolve esse chat", async () => {
    respostas = {
      contact_phones: { data: [{ id: "extra-1" }], error: null },
      messages: { data: [{ external_id: "false_5515999998888@c.us_3EB0AAA" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBe("5515999998888@c.us");
    // Sabotagem: devolver `null` sempre (sem ler a última recebida) deixa vermelho.
  });

  it("a última recebida em @lid também vale (é o endereço que o WhatsApp deu)", async () => {
    respostas = {
      contact_phones: { data: [{ id: "extra-1" }], error: null },
      messages: { data: [{ external_id: "false_100000000000001@lid_3A60443E83484256AF03" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBe("100000000000001@lid");
    // Sabotagem: filtrar só `@c.us` faz o @lid sumir e a resposta cair no principal.
  });

  it("última recebida de GRUPO → null (quem chama cai na regra de sempre)", async () => {
    respostas = {
      contact_phones: { data: [{ id: "extra-1" }], error: null },
      messages: { data: [{ external_id: "false_1203630@g.us_3EB0AAA" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBeNull();
    // Sabotagem: aceitar qualquer sufixo (sem o filtro de conversa individual) faz
    // a resposta de um grupo ir para o chat do grupo por este caminho, e deixa vermelho.
  });

  it("id de mensagem sem chat (a forma bare) → null", async () => {
    respostas = {
      contact_phones: { data: [{ id: "extra-1" }], error: null },
      messages: { data: [{ external_id: "3EB0AAA" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBeNull();
    // Sabotagem: trocar `chatIdFromWaMessageId` por `(id) => id` e tirar o filtro
    // individual devolve "3EB0AAA" como endereço, e deixa vermelho.
  });

  it("erro na consulta de extras → null, sem lançar, com warn só com a organização", async () => {
    respostas = { contact_phones: { data: null, error: { message: "banco caiu" } } };
    await expect(chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0]![1]).toMatchObject({ organization_id: "org-A" });
    // Sabotagem: deixar o erro subir (sem try/catch) faz o envio cair — este teste fica vermelho.
  });

  it("erro na consulta de mensagens → null, sem lançar", async () => {
    respostas = {
      contact_phones: { data: [{ id: "extra-1" }], error: null },
      messages: { data: null, error: { message: "timeout" } },
    };
    await expect(chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("contato nulo → null, sem consulta nenhuma", async () => {
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), { ...ARGS, contactId: null })).toBeNull();
    expect(consultadas).toEqual([]);
    // Sabotagem: consultar sem checar o contato deixa vermelho (o teste vê a consulta).
  });

  it("as DUAS consultas filtram pela organização da fonte confiável (multi-tenancy)", async () => {
    respostas = {
      contact_phones: { data: [{ id: "extra-1" }], error: null },
      messages: { data: [{ external_id: "false_5515999998888@c.us_3EB0AAA" }], error: null },
    };
    await chatIdDaUltimaRecebida(adminDeTeste(), ARGS);
    expect(filtros.contact_phones).toContain("organization_id=org-A");
    expect(filtros.contact_phones).toContain("contact_id=ficha-1");
    expect(filtros.messages).toContain("organization_id=org-A");
    expect(filtros.messages).toContain("conversation_id=conv-1");
    expect(filtros.messages).toContain("direction=inbound");
    // Sabotagem: tirar `.eq("organization_id", ...)` de qualquer das duas consultas
    // deixa vermelho (a RLS não protege o cliente administrador).
  });
});

describe("chatIndividualDaMensagem — só conversa individual", () => {
  it("aceita @c.us, @s.whatsapp.net e @lid com dígitos na frente", () => {
    expect(chatIndividualDaMensagem("5515999998888@c.us")).toBe("5515999998888@c.us");
    expect(chatIndividualDaMensagem("5515999998888@s.whatsapp.net")).toBe("5515999998888@s.whatsapp.net");
    expect(chatIndividualDaMensagem("100000000000001@lid")).toBe("100000000000001@lid");
  });

  it("recusa grupo, nulo, vazio e sufixo sem dígitos", () => {
    expect(chatIndividualDaMensagem("1203630@g.us")).toBeNull();
    expect(chatIndividualDaMensagem(null)).toBeNull();
    expect(chatIndividualDaMensagem("@c.us")).toBeNull();
    expect(chatIndividualDaMensagem("abc@lid")).toBeNull();
    // Sabotagem: aceitar qualquer sufixo (sem checagem) faz o grupo passar e deixa vermelho.
  });
});

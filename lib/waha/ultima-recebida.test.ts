import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

import { resolveWahaChatId } from "./send";
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
      contact_phones: { data: [{ phone_number: "+5515999998888" }], error: null },
      messages: { data: [{ external_id: "false_5515999998888@c.us_3EB0AAA" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBe("5515999998888@c.us");
    // Sabotagem: devolver `null` sempre (sem ler a última recebida) deixa vermelho.
  });

  it("a última recebida em @lid também vale (é o endereço que o WhatsApp deu)", async () => {
    respostas = {
      contact_phones: { data: [{ phone_number: "+5515999998888" }], error: null },
      messages: { data: [{ external_id: "false_100000000000001@lid_3A60443E83484256AF03" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBe("100000000000001@lid");
    // Sabotagem: filtrar só `@c.us` faz o @lid sumir e a resposta cair no principal.
  });

  it("última recebida de GRUPO → null (quem chama cai na regra de sempre)", async () => {
    respostas = {
      contact_phones: { data: [{ phone_number: "+5515999998888" }], error: null },
      messages: { data: [{ external_id: "false_1203630@g.us_3EB0AAA" }], error: null },
    };
    expect(await chatIdDaUltimaRecebida(adminDeTeste(), ARGS)).toBeNull();
    // Sabotagem: aceitar qualquer sufixo (sem o filtro de conversa individual) faz
    // a resposta de um grupo ir para o chat do grupo por este caminho, e deixa vermelho.
  });

  it("id de mensagem sem chat (a forma bare) → null", async () => {
    respostas = {
      contact_phones: { data: [{ phone_number: "+5515999998888" }], error: null },
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
      contact_phones: { data: [{ phone_number: "+5515999998888" }], error: null },
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
      contact_phones: { data: [{ phone_number: "+5515999998888" }], error: null },
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

describe("chatIdDaUltimaRecebida — o número tem de seguir na ficha", () => {
  type Linha = Record<string, unknown>;
  const ORG_A = "org-A";
  const ORG_B = "org-B";
  const PRINCIPAL = "+5511999990020";
  const EXTRA = "+5511999990022";
  const recebidaPor = (chat: string): Linha => ({
    organization_id: ORG_A,
    conversation_id: "conv-1",
    direction: "inbound",
    external_id: `false_${chat}_3EB0AAA`,
  });
  const contato = (phone_number: string | null, organization_id = ORG_A): Linha => ({
    id: "ficha-1",
    organization_id,
    phone_number,
  });
  const extra = (phone_number: string, organization_id = ORG_A): Linha => ({
    contact_id: "ficha-1",
    organization_id,
    phone_number,
  });

  /**
   * Dublê que FILTRA as linhas pelos `.eq()`, em vez de só anotá-los: tirar o filtro de
   * organização muda o resultado. `rlsOrg` faz o papel da RLS do cliente de sessão; o
   * cliente administrador não tem RLS e só conta com o filtro explícito.
   */
  function cliente(
    tabelas: { contacts?: Linha[]; contact_phones?: Linha[]; messages?: Linha[] },
    opcoes: { rlsOrg?: string; erroEm?: string } = {},
  ): SupabaseClient {
    return {
      from(tabela: keyof typeof tabelas) {
        consultadas.push(tabela);
        let linhas = (tabelas[tabela] ?? []).filter(
          (l) => !opcoes.rlsOrg || l.organization_id === opcoes.rlsOrg,
        );
        const resposta = (data: unknown) =>
          opcoes.erroEm === tabela ? { data: null, error: { message: "banco caiu" } } : { data, error: null };
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            linhas = linhas.filter((l) => l[col] === val);
            return chain;
          },
          not: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => resposta(linhas[0] ?? null),
          then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
            Promise.resolve(resposta(linhas)).then(ok, falha),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
  }

  it("número que saiu da ficha → null, e a resposta cai no principal", async () => {
    const chat = await chatIdDaUltimaRecebida(
      cliente({
        contacts: [contato(PRINCIPAL)],
        contact_phones: [extra(EXTRA)], // o outro extra saiu da ficha
        messages: [recebidaPor("5511999990021@c.us")],
      }),
      ARGS,
    );
    expect(chat).toBeNull();
    expect(
      resolveWahaChatId({
        isGroup: false,
        groupChatId: null,
        phoneNumber: PRINCIPAL,
        waIdentity: null,
        ultimoRecebidoChatId: chat,
      }),
    ).toBe("5511999990020@c.us");
    // Sabotagem: tirar a conferência da ficha devolve 5511999990021@c.us e deixa vermelho.
  });

  it("número que segue como extra → devolve o chat, sem gastar a leitura do principal", async () => {
    const chat = await chatIdDaUltimaRecebida(
      cliente({
        contact_phones: [extra(EXTRA)],
        messages: [recebidaPor("5511999990022@c.us")],
      }),
      ARGS,
    );
    expect(chat).toBe("5511999990022@c.us");
    expect(consultadas).not.toContain("contacts");
  });

  it("a última recebida pelo principal, com extra na ficha → devolve o chat", async () => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente({
          contacts: [contato(PRINCIPAL)],
          contact_phones: [extra(EXTRA)],
          messages: [recebidaPor("5511999990020@c.us")],
        }),
        ARGS,
      ),
    ).toBe("5511999990020@c.us");
    // Sabotagem: comparar só com os extras faz o principal perder o endereço e deixa vermelho.
  });

  it("nono dígito: o chat sem o 9 casa com a ficha com o 9, e o endereço não muda", async () => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente({
          contacts: [contato(PRINCIPAL)],
          contact_phones: [extra("+5531988887777")],
          messages: [recebidaPor("553188887777@c.us")],
        }),
        ARGS,
      ),
    ).toBe("553188887777@c.us");
    // Sabotagem: comparar por igualdade de string em vez de `samePhone` deixa vermelho.
  });

  it("@s.whatsapp.net passa pela mesma conferência", async () => {
    const tabelas = (numero: string) => ({
      contacts: [contato(PRINCIPAL)],
      contact_phones: [extra(numero)],
      messages: [recebidaPor("5511999990022@s.whatsapp.net")],
    });
    expect(await chatIdDaUltimaRecebida(cliente(tabelas(EXTRA)), ARGS)).toBe("5511999990022@s.whatsapp.net");
    expect(await chatIdDaUltimaRecebida(cliente(tabelas("+5511999990099")), ARGS)).toBeNull();
  });

  it("@lid não tem número para comparar: segue valendo, sem ler o principal", async () => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente(
          { contact_phones: [extra(EXTRA)], messages: [recebidaPor("100000000000001@lid")] },
          { erroEm: "contacts" },
        ),
        ARGS,
      ),
    ).toBe("100000000000001@lid");
    expect(consultadas).not.toContain("contacts");
    // Sabotagem: tratar @lid como número (sem o desvio) faz o endereço sumir e deixa vermelho.
  });

  it("falha na leitura do principal → null com warn: endereço não conferido não é usado", async () => {
    await expect(
      chatIdDaUltimaRecebida(
        cliente(
          { contact_phones: [extra(EXTRA)], messages: [recebidaPor("5511999990021@c.us")] },
          { erroEm: "contacts" },
        ),
        ARGS,
      ),
    ).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    // Sabotagem: devolver o chat quando a leitura falha deixa vermelho.
  });

  it("ficha que não voltou do banco, sem erro → null", async () => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente({ contact_phones: [extra(EXTRA)], messages: [recebidaPor("5511999990021@c.us")] }),
        ARGS,
      ),
    ).toBeNull();
  });

  // O número só existe na ficha de OUTRA organização: o cliente administrador (agente) não
  // tem RLS e depende do filtro explícito; o de sessão tem os dois.
  it.each([
    ["administrador", undefined],
    ["sessão", ORG_A],
  ])("outra organização não confere o número: cliente %s", async (_nome, rlsOrg) => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente(
          {
            // A linha da outra organização vem PRIMEIRO: sem o filtro, é ela que volta.
            contacts: [contato("+5511999990021", ORG_B), contato(PRINCIPAL)],
            contact_phones: [extra("+5511999990021", ORG_B), extra(EXTRA)],
            messages: [recebidaPor("5511999990021@c.us")],
          },
          { rlsOrg },
        ),
        ARGS,
      ),
    ).toBeNull();
    // Sabotagem: tirar `.eq("organization_id", ...)` de contact_phones ou de contacts
    // deixa vermelho o caso do administrador; o da sessão segue verde pela RLS.
  });

  it.each([
    ["administrador", undefined],
    ["sessão", ORG_A],
  ])("número na ficha da própria organização vale: cliente %s", async (_nome, rlsOrg) => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente(
          {
            contacts: [contato(PRINCIPAL)],
            contact_phones: [extra(EXTRA)],
            messages: [recebidaPor("5511999990020@c.us")],
          },
          { rlsOrg },
        ),
        ARGS,
      ),
    ).toBe("5511999990020@c.us");
  });

  it("contato só com o principal, sem linha em contact_phones → null, a regra de sempre", async () => {
    expect(
      await chatIdDaUltimaRecebida(
        cliente({ contacts: [contato(PRINCIPAL)], messages: [recebidaPor("5511999990020@c.us")] }),
        ARGS,
      ),
    ).toBeNull();
    expect(consultadas).toEqual(["contact_phones"]);
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

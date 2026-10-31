import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { fichaDoCrmParaOChat, telefonesDoChatParaFicha } from "@/lib/channels/historico/fichas-do-crm";

/**
 * O casamento do escopo "só contatos do CRM" (Spec 32 §1): a conversa do canal
 * só entra se casar uma FICHA VIVA da organização. Nunca cria ficha, e erro na
 * consulta lança (falha fechada, C16).
 */

type Ficha = {
  id: string;
  organization_id: string;
  phone_number: string | null;
  wa_lid: string | null;
  is_merged_into: string | null;
  is_anonymized: boolean;
};

const ORG = "org-1";
const viva = (over: Partial<Ficha> & Pick<Ficha, "id">): Ficha => ({
  organization_id: ORG,
  phone_number: null,
  wa_lid: null,
  is_merged_into: null,
  is_anonymized: false,
  ...over,
});

/** Imita o builder do PostgREST: filtros encadeados, `limit`, e o efeito no `await`. */
function bancoDeFichas(linhas: Ficha[], erro: string | null = null) {
  const consultas: Array<{ cols: string; filtros: number }> = [];
  const admin = {
    from(tabela: string) {
      if (tabela !== "contacts") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select(cols: string) {
          const filtros: Array<(l: Ficha) => boolean> = [];
          let limite = Number.POSITIVE_INFINITY;
          const q = {
            eq: (c: keyof Ficha, v: unknown) => (filtros.push((l) => l[c] === v), q),
            is: (c: keyof Ficha, v: unknown) => (filtros.push((l) => l[c] === v), q),
            in: (c: keyof Ficha, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
            limit: (n: number) => ((limite = n), q),
            then: (ok: (v: unknown) => unknown) => {
              consultas.push({ cols, filtros: filtros.length });
              if (erro) return Promise.resolve(ok({ data: null, error: { message: erro } }));
              const achadas = linhas.filter((l) => filtros.every((f) => f(l))).slice(0, limite);
              return Promise.resolve(ok({ data: achadas, error: null }));
            },
          };
          return q;
        },
      };
    },
  };
  return { admin, consultas };
}

describe("fichaDoCrmParaOChat (Spec 32 §1, escopo só CRM)", () => {
  it("acha a ficha pelo telefone exato", async () => {
    const { admin } = bancoDeFichas([viva({ id: "ct-1", phone_number: "+5511987654321" })]);
    const achada = await fichaDoCrmParaOChat(admin as never, {
      organizationId: ORG,
      telefones: ["+5511987654321"],
      lid: null,
    });
    expect(achada).toEqual({ contactId: "ct-1" });
    // Sabotagem: nenhuma das grafias acha a ficha (telefone não consultado) faz este caso ficar vermelho.
  });

  it("o @lid da ficha vence os telefones: a ficha pelo lid é a escolhida, mesmo com outro telefone batendo", async () => {
    const { admin } = bancoDeFichas([
      viva({ id: "ct-por-telefone", phone_number: "+5511987654321" }),
      viva({ id: "ct-por-lid", wa_lid: "111111111111111" }),
    ]);
    const achada = await fichaDoCrmParaOChat(admin as never, {
      organizationId: ORG,
      telefones: ["+5511987654321"],
      lid: "111111111111111",
    });
    expect(achada).toEqual({ contactId: "ct-por-lid" });
    // Sabotagem: consultar os telefones antes do lid faz o ct-por-telefone vencer.
  });

  it("entre as grafias do mesmo número (nono dígito), vence a canônica, qualquer que seja a ordem", async () => {
    const semNono = viva({ id: "ct-sem-nono", phone_number: "+551187654321" });
    const comNono = viva({ id: "ct-com-nono", phone_number: "+5511987654321" });
    const { admin: a } = bancoDeFichas([semNono, comNono]);
    const { admin: b } = bancoDeFichas([comNono, semNono]);
    const args = { organizationId: ORG, telefones: ["+5511987654321"], lid: null };
    expect(await fichaDoCrmParaOChat(a as never, args)).toEqual({ contactId: "ct-com-nono" });
    expect(await fichaDoCrmParaOChat(b as never, args)).toEqual({ contactId: "ct-com-nono" });
    // Sabotagem: `.limit(1)` sem a escolha da canônica faz o resultado depender da ordem do banco.
  });

  it("não acha ficha fundida, anonimizada ou de OUTRA organização", async () => {
    const { admin } = bancoDeFichas([
      viva({ id: "fundida", phone_number: "+5511987654321", is_merged_into: "outra" }),
      viva({ id: "anon", phone_number: "+5511987654321", is_anonymized: true }),
      viva({ id: "outra-org", phone_number: "+5511987654321", organization_id: "org-2" }),
    ]);
    const achada = await fichaDoCrmParaOChat(admin as never, {
      organizationId: ORG,
      telefones: ["+5511987654321"],
      lid: null,
    });
    expect(achada).toBeNull();
    // Sabotagem: tirar um dos filtros (fundida, anonimizada ou organização) faz a ficha errada aparecer.
  });

  it("sem telefone nem lid, ou sem nada batendo: null, sem consultar", async () => {
    const { admin, consultas } = bancoDeFichas([viva({ id: "x", phone_number: "+5511987654321" })]);
    expect(await fichaDoCrmParaOChat(admin as never, { organizationId: ORG, telefones: [], lid: null })).toBeNull();
    expect(consultas).toHaveLength(0);
    expect(await fichaDoCrmParaOChat(admin as never, { organizationId: ORG, telefones: ["+5521999990000"], lid: null })).toBeNull();
  });

  it("erro na consulta LANÇA (falha fechada, C16): nunca vira 'sem ficha'", async () => {
    const { admin } = bancoDeFichas([viva({ id: "x", phone_number: "+5511987654321" })], "conexao caiu");
    await expect(
      fichaDoCrmParaOChat(admin as never, { organizationId: ORG, telefones: ["+5511987654321"], lid: null }),
    ).rejects.toThrow("fichas_do_crm: conexao caiu");
    // Sabotagem: devolver null no erro (como `encontrarContatoPorTelefone`) faz este caso ficar vermelho.
  });

  it("a organização entra em toda consulta (lid e telefone)", async () => {
    const { admin, consultas } = bancoDeFichas([]);
    await fichaDoCrmParaOChat(admin as never, { organizationId: ORG, telefones: ["+5511987654321"], lid: "111" });
    // Uma de lid, uma de telefone; cada uma com organização, fundido e anonimizado: 3 filtros + o próprio.
    expect(consultas).toHaveLength(2);
    expect(consultas.every((c) => c.filtros >= 3)).toBe(true);
  });
});

describe("telefonesDoChatParaFicha", () => {
  it("junta o telefone do chat, o que o canal resolveu para o lid e o remoteJidAlt das mensagens, sem repetir", () => {
    const telefones = telefonesDoChatParaFicha(
      "111111111111111@lid",
      "5511987654321",
      [{ id: "false_111111111111111@lid_X", from: "111111111111111@lid", fromMe: false, _data: { key: { remoteJidAlt: "5511987654321@s.whatsapp.net" } } } as never],
    );
    expect(telefones).toEqual(["5511987654321"]);
    // Sabotagem: não olhar o remoteJidAlt faz a conversa de um @lid sem telefone resolvido ficar de fora.
  });

  it("chat de telefone usa o próprio número", () => {
    expect(telefonesDoChatParaFicha("5511900000001@s.whatsapp.net", null, [])).toEqual(["5511900000001"]);
  });
});


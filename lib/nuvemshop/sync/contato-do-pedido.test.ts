import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(),
}));
vi.mock("@/lib/contacts/cpf", async (importarOriginal) => ({
  ...(await importarOriginal<Record<string, unknown>>()),
  camposCpfParaGravar: vi.fn(async () => ({})),
}));

import { pedidoNuvemshopSchema } from "./pedido-nuvemshop";
import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import {
  decidirContato,
  extrairChaves,
  resolverContatoDoPedido,
  type ChavesDoContato,
} from "./contato-do-pedido";

const base = {
  id: 1, total: "1.00", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("extrairChaves", () => {
  it("prefere os campos contact_* e normaliza", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({
      ...base,
      contact_phone: "(11) 99999-0000",
      contact_email: "  Ana@Ex.COM ",
      contact_identification: "123.456.789-09",
      contact_name: "Ana",
      customer: { phone: "+5521888880000", email: "outra@ex.com", name: "Outra" },
    }));
    expect(c).toEqual({ telefone: "+5511999990000", email: "ana@ex.com", cpf: "12345678909", nome: "Ana" });
  });

  it("cai para customer.* e billing_phone", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({
      ...base,
      customer: { billing_phone: "21988880000", email: "b@ex.com", identification: "98765432100", name: "Bia" },
    }));
    expect(c).toEqual({ telefone: "+5521988880000", email: "b@ex.com", cpf: "98765432100", nome: "Bia" });
  });

  it("telefone estrangeiro com + é preservado (Tiendanube AR)", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_phone: "+54 9 11 1234-5678" }));
    expect(c.telefone).toBe("+5491112345678");
  });

  it("documento que não é CPF (CNPJ, DNI) não vira chave", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_identification: "12.345.678/0001-90" }));
    expect(c.cpf).toBeNull();
  });

  it("e-mail sem @ é descartado", () => {
    expect(extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_email: "sem-arroba" })).email).toBeNull();
  });
});

const chaves = (over: Partial<ChavesDoContato> = {}): ChavesDoContato => ({
  telefone: "+5511999990000", email: "ana@ex.com", cpf: "12345678909", nome: "Ana", ...over,
});

describe("decidirContato", () => {
  it("nenhuma chave → sem_chave", () => {
    expect(decidirContato(chaves({ telefone: null, email: null, cpf: null }), [])).toEqual({ acao: "sem_chave" });
  });

  it("telefone vence e-mail divergente", () => {
    const d = decidirContato(chaves(), [
      { id: "por-email", name: "X", email: "ana@ex.com", cpf_hash: null, via: "email" },
      { id: "por-telefone", name: "Ana", email: "outra@ex.com", cpf_hash: "h", via: "telefone" },
    ]);
    expect(d).toEqual({ acao: "usar", contatoId: "por-telefone", completar: {} });
  });

  it("completa só campos vazios", () => {
    const d = decidirContato(chaves(), [{ id: "c1", name: null, email: null, cpf_hash: null, via: "email" }]);
    expect(d).toEqual({ acao: "usar", contatoId: "c1", completar: { name: "Ana", email: "ana@ex.com", cpf: "12345678909" } });
  });

  it("só CPF casa", () => {
    const d = decidirContato(chaves({ telefone: null, email: null }), [
      { id: "c2", name: "Ana", email: "x@y.com", cpf_hash: "h", via: "cpf" },
    ]);
    expect(d).toMatchObject({ acao: "usar", contatoId: "c2" });
  });

  it("sem candidato e com chave → criar, nome cai para telefone", () => {
    expect(decidirContato(chaves({ nome: null, email: null, cpf: null }), [])).toEqual({
      acao: "criar",
      dados: { name: "+5511999990000", phone_number: "+5511999990000", email: null, cpf: null },
    });
  });
});

// ---- efeito: resolverContatoDoPedido com dublê encadeável do admin ----

type Resp = { data?: unknown; error?: { code?: string } | null };
interface Chamada {
  table: string;
  op: "select" | "update" | "insert";
  filtros: Array<[string, string, unknown]>;
  payload?: unknown;
}

function criarAdmin(respostas: Resp[]) {
  const chamadas: Chamada[] = [];
  const admin = {
    from(table: string) {
      const c: Chamada = { table, op: "select", filtros: [] };
      chamadas.push(c);
      const resolver = (): Resp => respostas.shift() ?? { data: null, error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: unknown) => ((c.op = "update"), (c.payload = patch), b),
        insert: (row: unknown) => ((c.op = "insert"), (c.payload = row), b),
        eq: (k: string, v: unknown) => (c.filtros.push(["eq", k, v]), b),
        is: (k: string, v: unknown) => (c.filtros.push(["is", k, v]), b),
        maybeSingle: async () => resolver(),
        then: (ok: (r: Resp) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve(resolver()).then(ok, ko),
      };
      return b;
    },
  };
  return { admin: admin as never, chamadas };
}

const ORG = "org-1";
const ctx = { orgId: ORG, storeId: "loja-9", customerId: "cli-7" };
const telefoneMock = vi.mocked(encontrarContatoPorTelefoneComNome);

describe("resolverContatoDoPedido", () => {
  beforeEach(() => {
    telefoneMock.mockReset();
    telefoneMock.mockResolvedValue(null);
  });

  it("buscas por e-mail e CPF filtram organização, não mesclado e não anonimizado", async () => {
    const { admin, chamadas } = criarAdmin([]);
    await resolverContatoDoPedido(admin, ctx, chaves({ telefone: null }));
    const buscas = chamadas.filter((c) => c.op === "select");
    expect(buscas).toHaveLength(2);
    for (const b of buscas) {
      expect(b.table).toBe("contacts");
      expect(b.filtros).toContainEqual(["eq", "organization_id", ORG]);
      expect(b.filtros).toContainEqual(["is", "is_merged_into", null]);
      expect(b.filtros).toContainEqual(["eq", "is_anonymized", false]);
    }
  });

  it("contato achado com nome vazio: update só com name, com organização", async () => {
    telefoneMock.mockResolvedValue({ id: "c1", phone_number: null, name: null });
    const { admin, chamadas } = criarAdmin([
      { data: { id: "c1", name: null, email: "ja@ex.com", cpf_hash: "h" } },
    ]);
    const id = await resolverContatoDoPedido(admin, ctx, chaves());
    expect(id).toBe("c1");
    const upd = chamadas.filter((c) => c.op === "update");
    expect(upd).toHaveLength(1);
    expect(upd[0]?.payload).toEqual({ name: "Ana" });
    expect(upd[0]?.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(upd[0]?.filtros).toContainEqual(["eq", "id", "c1"]);
  });

  it("contato completo: nenhum update", async () => {
    telefoneMock.mockResolvedValue({ id: "c1", phone_number: null, name: "X" });
    const { admin, chamadas } = criarAdmin([
      { data: { id: "c1", name: "X", email: "e@ex.com", cpf_hash: "h" } },
    ]);
    await resolverContatoDoPedido(admin, ctx, chaves());
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("sem candidato: insert com source e source_metadata", async () => {
    const { admin, chamadas } = criarAdmin([
      { data: null }, { data: null }, { data: { id: "novo" }, error: null },
    ]);
    const id = await resolverContatoDoPedido(admin, ctx, chaves({ telefone: null }));
    expect(id).toBe("novo");
    const ins = chamadas.find((c) => c.op === "insert");
    expect(ins?.table).toBe("contacts");
    expect(ins?.payload).toMatchObject({
      organization_id: ORG,
      source: "nuvemshop",
      source_metadata: { store_id: "loja-9", customer_id: "cli-7" },
    });
  });

  it("insert com 23505: re-seleciona e devolve o vencedor", async () => {
    const { admin } = criarAdmin([
      { data: null }, { data: null },
      { data: null, error: { code: "23505" } },
      { data: { id: "vencedor", name: "Ana", email: "ana@ex.com", cpf_hash: "h" } },
    ]);
    const id = await resolverContatoDoPedido(admin, ctx, chaves({ telefone: null }));
    expect(id).toBe("vencedor");
  });

  it("erro na busca por e-mail lança, sem PII", async () => {
    const { admin } = criarAdmin([{ data: null, error: { code: "PGRST116" } }]);
    await expect(resolverContatoDoPedido(admin, ctx, chaves({ telefone: null }))).rejects.toThrow(
      "contato_busca:PGRST116",
    );
  });

  it("erro na busca por CPF lança", async () => {
    const { admin } = criarAdmin([{ data: null }, { data: null, error: { code: "57014" } }]);
    await expect(resolverContatoDoPedido(admin, ctx, chaves({ telefone: null }))).rejects.toThrow(
      "contato_busca:57014",
    );
  });

  it("erro ao reler o contato achado por telefone lança", async () => {
    telefoneMock.mockResolvedValue({ id: "c1", phone_number: null, name: null });
    const { admin } = criarAdmin([{ data: null, error: {} }]);
    await expect(resolverContatoDoPedido(admin, ctx, chaves())).rejects.toThrow("contato_busca:sem_code");
  });

  it("sem nenhuma chave: devolve null sem tocar o banco", async () => {
    const { admin, chamadas } = criarAdmin([]);
    expect(await resolverContatoDoPedido(admin, ctx, chaves({ telefone: null, email: null, cpf: null }))).toBeNull();
    expect(chamadas).toHaveLength(0);
  });
});

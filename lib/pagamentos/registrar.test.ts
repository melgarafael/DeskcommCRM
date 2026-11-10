import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  operacao,
  valorDoFiltro,
  type BancoFalso,
  type Cadeia,
  type Resposta,
} from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ erro: vi.fn(), aviso: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.aviso, error: h.erro, info: vi.fn() } }));

import { hashDoToken } from "./assinatura";
import { registrarRecebimento, type Recebimento } from "./registrar";

const ORG = "cccccccc-0000-4000-8000-000000000001";
const CONV = "cccccccc-0000-4000-8000-000000000002";
const LEAD = "cccccccc-0000-4000-8000-000000000004";
const REC = "cccccccc-0000-4000-8000-000000000005";
const CONTATO = "cccccccc-0000-4000-8000-000000000006";

const recebimento = (over: Partial<Recebimento> = {}): Recebimento => ({
  id: REC,
  organization_id: ORG,
  conversation_id: CONV,
  lead_id: LEAD,
  provedor: "infinitepay",
  external_id: null,
  valor_cents: 15000,
  moeda: "BRL",
  status: "pendente",
  pago_em: null,
  ...over,
});

interface Mundo {
  conversa: { id: string; contact_id: string | null } | null;
  leads: Array<{ id: string }>;
  insert: Resposta;
}

let m: Mundo;
let banco: BancoFalso;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "conversations") return { data: m.conversa };
  if (c.tabela === "crm_leads") return { data: m.leads };
  if (c.tabela === "pagamento_recebimentos") return m.insert;
  return {};
}

const pedido = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  conversationId: CONV,
  provedor: "infinitepay" as const,
  valorCents: 15000,
  ...over,
});

const inserido = () =>
  argumentos(banco.cadeias.find((c) => c.tabela === "pagamento_recebimentos")!, "insert")?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  m = { conversa: { id: CONV, contact_id: CONTATO }, leads: [{ id: LEAD }], insert: { data: recebimento() } };
  banco = bancoFalso(responder);
});

describe("registrar o recebimento na conversa", () => {
  it("⭐ cria o recebimento pendente, ligado ao negócio aberto do contato, e devolve o segredo da URL", async () => {
    const r = await registrarRecebimento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: true, recebimento: { id: REC, status: "pendente" } });
    if (!r.ok) return;
    const linha = inserido();
    expect(linha).toMatchObject({ organization_id: ORG, conversation_id: CONV, lead_id: LEAD, status: "pendente" });
    // Só o HASH vai para o banco, e é o hash DO segredo devolvido.
    expect(linha.aviso_token_hash).toBe(hashDoToken(r.token));
    expect(JSON.stringify(linha)).not.toContain(r.token);
  });

  it("⭐ cada registro tem o SEU segredo: dois registros, dois hashes diferentes", async () => {
    const a = await registrarRecebimento(banco.cliente as never, pedido());
    const b = await registrarRecebimento(banco.cliente as never, pedido());
    expect(a.ok && b.ok && a.token !== b.token).toBe(true);
  });

  it("⭐ conversa de OUTRA organização: 404, e nada é gravado", async () => {
    m.conversa = null;
    const r = await registrarRecebimento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, status: 404 });
    const leitura = banco.cadeias.find((c) => c.tabela === "conversations")!;
    expect(valorDoFiltro(leitura, "eq", "organization_id")).toBe(ORG);
    expect(banco.cadeias.filter((c) => c.tabela === "pagamento_recebimentos")).toEqual([]);
  });

  it("contato com dois negócios abertos: não adivinha, `lead_id` fica nulo", async () => {
    m.leads = [{ id: LEAD }, { id: "cccccccc-0000-4000-8000-0000000000ff" }];
    await registrarRecebimento(banco.cliente as never, pedido());
    expect(inserido().lead_id).toBeNull();
  });

  it("conversa sem contato: registra sem negócio", async () => {
    m.conversa = { id: CONV, contact_id: null };
    await registrarRecebimento(banco.cliente as never, pedido());
    expect(inserido().lead_id).toBeNull();
    expect(banco.cadeias.filter((c) => c.tabela === "crm_leads")).toEqual([]);
  });

  it.each([0, -1, 1.5, 100_000_001])("valor %s: 422 sem tocar no banco", async (valorCents) => {
    const r = await registrarRecebimento(banco.cliente as never, pedido({ valorCents }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(banco.cadeias).toEqual([]);
  });

  it("falha ao gravar: 500, e o erro é logado sem o segredo", async () => {
    m.insert = { error: { code: "42501", message: "rls" } };
    const r = await registrarRecebimento(banco.cliente as never, pedido());
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(h.erro).toHaveBeenCalled();
    expect(operacao(banco.cadeias.find((c) => c.tabela === "pagamento_recebimentos")!)).toBe("insert");
  });
});

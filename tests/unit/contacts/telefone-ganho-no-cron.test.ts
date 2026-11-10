import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3315 — o CRON de telefones emite `contact.phone_added` quando descobre o
 * número por trás da identidade opaca e tira a ficha do vazio.
 *
 * Este é o único caminho dos quatro que preenche o telefone DEPOIS, por
 * varredura: o contato já existe (nasceu só com o id opaco do WhatsApp), a
 * tabela de tradução do canal aprende o número com o tempo, e é aqui que ele
 * entra. Quem era dono da ficha nunca soube, porque nada avisava a automação.
 *
 * Os três lados que o arquivo prende:
 *
 *   1. EMITE UMA vez, com o CONTATO CERTO (é `c.id`, não o da sessão sorteada) e
 *      o número canônico — o mesmo que o UPDATE gravou.
 *   2. NÃO emite quando o UPDATE não casou linha: entre a seleção do lote e a
 *      gravação há I/O de rede por contato, e a ficha pode ter ganhado número por
 *      outra via. `carimbar` devolve `false` exatamente nesse caso.
 *   3. NÃO emite quando o canal não respondeu — sem telefone não há ganho nenhum,
 *      e o carimbo sozinho (o `phone_lookup_at` da fila) não é um ganho.
 */

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
let emitidos: Array<Record<string, unknown>>;
let contatos: Record<string, unknown>[];
/** A ficha como ela está no banco — é o ESTADO que faz `.is(…, null)` morder. */
let ficha: { phone_number: string | null };
let sessao: Record<string, unknown> | null;
let phoneResolvido: string | null;

/** Número SINTÉTICO do teste — nunca copiado de log (a saída das ferramentas redige). */
const TELEFONE = "+5541991234567";

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: [string, unknown][] = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => {
            if (tabela === "contacts" && op === "select") return ok({ data: contatos, error: null });
            if (tabela === "contacts" && op === "update") {
              const casou = filtros.every(([chave, valor]) => {
                const [tipo, coluna] = chave.split(":");
                if (coluna === "phone_number") {
                  return tipo === "is" ? ficha.phone_number === null : ficha.phone_number === valor;
                }
                return true;
              });
              if (!casou) return ok({ data: [], error: null });
              if (payload && "phone_number" in (payload as Record<string, unknown>)) {
                ficha.phone_number = (payload as { phone_number: string }).phone_number;
              }
              return ok({ data: [{ id: "c1" }], error: null });
            }
            return ok({ data: [{ id: "x" }], error: null });
          };
        }
        if (prop === "maybeSingle") {
          return async () => ({ data: sessao ? { channel_sessions: sessao } : null, error: null });
        }
        return (...args: unknown[]) => {
          if (["eq", "is", "not", "or"].includes(String(prop))) {
            filtros.push([`${String(prop)}:${String(args[0])}`, args[1]]);
          }
          if (["update", "eq", "is", "not", "or", "select"].includes(String(prop))) {
            ops.push({ tabela, op: `${op}.${String(prop)}`, payload: args[0] });
          }
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "emit_event") emitidos.push(args);
      return { data: "evt-1", error: null };
    },
  }),
}));

vi.mock("@/lib/channels", async (orig) => {
  const real = await orig<typeof import("@/lib/channels")>();
  return {
    ...real,
    getAdapter: () => ({
      provider: "waha",
      resolvePhoneForIdentity: async () => phoneResolvido,
    }),
  };
});

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "s3cr3t", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { GET } = await import("@/app/api/v1/cron/contact-phones/route");

const chamar = (secret = "s3cr3t") =>
  GET(
    new Request("http://localhost/api/v1/cron/contact-phones", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }) as never,
  );

const ganhos = () => emitidos.filter((e) => e.p_event_type === "contact.phone_added");

beforeEach(() => {
  ops.length = 0;
  emitidos = [];
  contatos = [{ id: "c1", organization_id: "org", wa_identity: "lid:123" }];
  ficha = { phone_number: null };
  sessao = { provider: "waha", waha_session_name: "sess", status: "WORKING", archived_at: null };
  phoneResolvido = TELEFONE;
});

describe("#3315 — o cron emite o telefone ganho", () => {
  it("descobriu o número e gravou: emite UMA vez, com o contato e a org dele", async () => {
    await chamar();
    expect(ganhos()).toHaveLength(1);
    expect(ganhos()[0]).toMatchObject({
      p_event_type: "contact.phone_added",
      p_entity_kind: "contact",
      p_entity_id: "c1",
      p_organization_id: "org",
      p_payload: { phone_number: phoneResolvido },
    });
    // O payload carrega o MESMO valor que a linha recebeu.
    expect(ganhos()[0]!.p_payload).toMatchObject({ phone_number: ficha.phone_number });
  });

  it("a resposta do cron continua contando o resolvido", async () => {
    const r = await chamar();
    expect(await r.json()).toMatchObject({ data: { varridos: 1, resolvidos: 1 } });
  });

  it("o UPDATE não casou linha (a ficha ganhou número por outra via): NÃO emite", async () => {
    // É a corrida que o próprio carimbar descreve: entre selecionar o lote e
    // gravar há I/O de rede por contato, e sobrescrever apagaria o dado fresco.
    ficha = { phone_number: "+5541999990000" };
    const r = await chamar();
    expect(ganhos()).toHaveLength(0);
    expect(await r.json()).toMatchObject({ data: { resolvidos: 0, sem_resposta: 1 } });
  });

  it("o canal não respondeu: carimba e NÃO emite — sem telefone não há ganho", async () => {
    phoneResolvido = null;
    const r = await chamar();
    expect(ganhos()).toHaveLength(0);
    expect(await r.json()).toMatchObject({ data: { resolvidos: 0, sem_resposta: 1 } });
  });

  it("sem canal utilizável: carimba e NÃO emite", async () => {
    sessao = null;
    const r = await chamar();
    expect(ganhos()).toHaveLength(0);
    expect(await r.json()).toMatchObject({ data: { sem_canal: 1 } });
  });
});

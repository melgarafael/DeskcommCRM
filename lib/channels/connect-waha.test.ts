import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectWahaChannel, renomearSessaoParaOTeto } from "./connect-waha";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const org = "20000000-0000-4000-8000-000000000001";
const key = "20000000-0000-4000-8000-000000000002";
const channel = { id: key, organization_id: org, waha_session_name: "owned", status: "STARTING", archived_at: null };
/**
 * A linha como o banco a devolve. `reservado` é o que
 * `fn_reserve_channel_connection` retorna — e ela sobrescreve `status` com
 * `STARTING` antes do `returning`, então o status que chega ao código de
 * conexão NUNCA é o status real do canal. `phone_number`, sim.
 */
function fixture(linha: Partial<typeof channel> & { phone_number?: string | null } = {}) {
  const finishes: Record<string, unknown>[] = [];
  const noBanco = { ...channel, phone_number: null as string | null, ...linha };
  const reservado = { ...noBanco, status: "STARTING" };
  const nomeInicial = reservado.waha_session_name;
  /** Nomes gravados por UPDATE, na ordem. Vazio = ninguém renomeou. */
  const renomeios: string[] = [];
  const db = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "fn_reserve_channel_connection") return { data: { channel: reservado, receipt_id: key, lease_token: key, replay: false }, error: null };
    finishes.push(args);
    return { data: { ...noBanco, waha_session_name: renomeios.at(-1) ?? nomeInicial, status: args.p_status }, error: null };
  }),
    // Simula o WHERE de verdade: cada filtro é conferido contra `noBanco`, e a
    // linha só é atualizada se TODOS casarem. Sem isso o teste não distingue
    // "a guarda está no UPDATE" de "a guarda sumiu do UPDATE".
    from: vi.fn(() => {
      let casa = true;
      let pendente: Record<string, unknown> | null = null;
      const builder = {
        update(row: Record<string, unknown>) { pendente = row; return builder; },
        eq(coluna: string, valor: unknown) { casa &&= (noBanco as Record<string, unknown>)[coluna] === valor; return builder; },
        is(coluna: string, valor: unknown) { casa &&= ((noBanco as Record<string, unknown>)[coluna] ?? null) === valor; return builder; },
        neq(coluna: string, valor: unknown) { casa &&= (noBanco as Record<string, unknown>)[coluna] !== valor; return builder; },
        select() { return builder; },
        async maybeSingle() {
          if (casa && pendente) renomeios.push(pendente.waha_session_name as string);
          return { data: casa ? { id: noBanco.id } : null, error: null };
        },
      };
      return builder;
    }),
  } as unknown as SupabaseClient;
  const transport = { getVerifiedSession: vi.fn(async () => null),
    createSession: vi.fn(async (nome: string) => ({ created: true, session: { name: nome, status: "STOPPED" } })),
    startExistingSession: vi.fn(async (nome: string) => ({ name: nome, status: "SCAN_QR_CODE" })),
    deleteSession: vi.fn(async () => {}), stopSession: vi.fn(async () => {}) };
  return { db, transport, finishes, renomeios, input: { organizationId: org, idempotencyKey: key, userId: key, requestId: key } };
}
describe("conexão recuperável", () => {
  it("publica somente o status confirmado pelo transporte e pelo DB", async () => {
    const f = fixture(); const result = await connectWahaChannel(f.db, f.db, f.transport, f.input);
    expect(result.channel.status).toBe("SCAN_QR_CODE");
    expect(f.finishes.map((c) => c.p_status)).toEqual(["remote_created", "SCAN_QR_CODE"]);
  });
  it("timeout de criação não atesta ausência e preserva FAILED para reparo", async () => {
    const f = fixture(); f.transport.createSession.mockRejectedValue(new Error("timeout"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)).toMatchObject({ p_status: "FAILED" });
  });
  it("falha após criação própria preserva remoto e marca FAILED", async () => {
    const f = fixture(); f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)).toMatchObject({ p_status: "FAILED" });
  });
  it("nova tentativa reutiliza a mesma identidade após falha", async () => {
    const f = fixture(); f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    f.transport.createSession.mockResolvedValue({ created: false, session: { name: "owned", status: "STOPPED" } });
    f.transport.startExistingSession.mockResolvedValue({ name: "owned", status: "SCAN_QR_CODE" });
    expect((await connectWahaChannel(f.db, f.db, f.transport, f.input)).channel.status).toBe("SCAN_QR_CODE");
    expect(f.transport.createSession).toHaveBeenNthCalledWith(2, "owned");
    expect(f.transport.startExistingSession).toHaveBeenNthCalledWith(2, "owned");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
  it("sessão já existente não é propriedade de compensação da chamada", async () => {
    const f = fixture(); f.transport.createSession.mockResolvedValue({ created: false, session: { name: "owned", status: "STOPPED" } });
    f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
  it("lease perdida proíbe compensação destrutiva", async () => {
    const f = fixture(); f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    vi.mocked(f.db.rpc).mockImplementation(((name: string) => Promise.resolve( name === "fn_reserve_channel_connection"
      ? { data: { channel, receipt_id: key, lease_token: key, replay: false }, error: null } as never
      : { data: null, error: { message: "connection_lease_lost", code: "55P03" } })) as unknown as typeof f.db.rpc);
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow();
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
  it("replay confirmado não toca no transporte", async () => {
    const f = fixture();
    vi.mocked(f.db.rpc).mockResolvedValue({ data: { channel: { ...channel, status: "SCAN_QR_CODE" }, receipt_id: key, replay: true }, error: null } as never);
    expect((await connectWahaChannel(f.db, f.db, f.transport, f.input)).replay).toBe(true);
    expect(f.transport.createSession).not.toHaveBeenCalled();expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
});

/**
 * O nome de 69 caracteres que a 0228/0230 gerava (`org_<32>_<32>`). É o que o
 * WAHA recusa com `400 name must be shorter than or equal to 54 characters`.
 */
const NOME_LEGADO = `org_${org.replaceAll("-", "")}_${key.replaceAll("-", "")}`;

describe("nome de sessão fora do teto do WAHA", () => {
  it("o nome legado tem mesmo 69 caracteres", () => {
    expect(NOME_LEGADO).toHaveLength(69);
  });

  it("canal que nunca pareou é CURADO: o transporte recebe um nome dentro do teto", async () => {
    const f = fixture({ waha_session_name: NOME_LEGADO, phone_number: null });
    const resultado = await connectWahaChannel(f.db, f.db, f.transport, f.input);
    expect(f.renomeios).toHaveLength(1);
    const novo = f.renomeios[0]!;
    expect(novo.length).toBeLessThanOrEqual(54);
    expect(novo).toMatch(/^org_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(f.transport.createSession).toHaveBeenCalledWith(novo);
    expect(f.transport.startExistingSession).toHaveBeenCalledWith(novo);
    expect(f.transport.createSession).not.toHaveBeenCalledWith(NOME_LEGADO);
    expect(resultado.channel.status).toBe("SCAN_QR_CODE");
  });

  it("canal PAREADO e parado NÃO é renomeado: recusa com motivo, sem tocar o transporte", async () => {
    // O caso que a guarda por `status` sozinha perde. A reserva devolve
    // `status: "STARTING"` mesmo para um canal que estava parado, então quem
    // protege aqui é `phone_number` — e renomear desligaria o CRM da sessão
    // que existe no disco do WAHA.
    const f = fixture({ waha_session_name: NOME_LEGADO, phone_number: "5511999990000", status: "STOPPED" });
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toMatchObject({
      code: "connection_session_name_too_long", status: 409,
      technical: { waha_session_name: NOME_LEGADO, comprimento: 69, teto: 54 },
    });
    expect(f.renomeios).toEqual([]);
    expect(f.transport.createSession).not.toHaveBeenCalled();
    expect(f.transport.startExistingSession).not.toHaveBeenCalled();
    expect(f.transport.stopSession).not.toHaveBeenCalled();
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)).toMatchObject({ p_status: "FAILED", p_reason: "session_name_too_long" });
  });

  it("canal pareado E WORKING também não é renomeado", async () => {
    const f = fixture({ waha_session_name: NOME_LEGADO, phone_number: "5511999990000", status: "WORKING" });
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toMatchObject({ code: "connection_session_name_too_long" });
    expect(f.renomeios).toEqual([]);
  });

  it("nome exatamente no teto (54) segue pelo caminho normal, sem renomeio", async () => {
    const nome = "o".repeat(54);
    const f = fixture({ waha_session_name: nome });
    expect((await connectWahaChannel(f.db, f.db, f.transport, f.input)).channel.status).toBe("SCAN_QR_CODE");
    expect(f.transport.createSession).toHaveBeenCalledWith(nome);
    expect(f.renomeios).toEqual([]);
  });

  it("nome que o banco gera desde a 0232 (45) segue pelo caminho normal", async () => {
    const nome = `org_${org.replaceAll("-", "").slice(0, 8)}_${key.replaceAll("-", "")}`;
    expect(nome).toHaveLength(45);
    const f = fixture({ waha_session_name: nome });
    expect((await connectWahaChannel(f.db, f.db, f.transport, f.input)).channel.status).toBe("SCAN_QR_CODE");
    expect(f.transport.startExistingSession).toHaveBeenCalledWith(nome);
    expect(f.renomeios).toEqual([]);
  });
});

/**
 * A decisão em memória (`podeRenomearSessaoDoWaha`) e a guarda no WHERE do
 * UPDATE são DOIS caminhos com a mesma saída — e por isso apagar um deixa os
 * testes do caminho de conectar verdes. Estes casos chamam o UPDATE direto,
 * sem passar pela decisão, que é o único jeito de a guarda do WHERE ser vigiada
 * de fato.
 */
describe("renomearSessaoParaOTeto — a guarda também mora no WHERE", () => {
  const alvo = { id: key, organization_id: org, waha_session_name: NOME_LEGADO };

  it("linha PAREADA não casa no UPDATE: ninguém é renomeado e a função recusa", async () => {
    const f = fixture({ waha_session_name: NOME_LEGADO, phone_number: "5511999990000", status: "STOPPED" });
    await expect(renomearSessaoParaOTeto(f.db, alvo)).rejects.toMatchObject({
      code: "connection_session_name_too_long", status: 409,
      technical: { renomeio_recusado: true },
    });
    expect(f.renomeios).toEqual([]);
  });

  it("linha WORKING não casa no UPDATE", async () => {
    const f = fixture({ waha_session_name: NOME_LEGADO, phone_number: null, status: "WORKING" });
    // A reserva sobrescreve o status com STARTING, então aqui o `neq` precisa
    // ver o estado da TABELA — que é o que este dublê guarda.
    await expect(renomearSessaoParaOTeto(f.db, alvo)).rejects.toMatchObject({ code: "connection_session_name_too_long" });
    expect(f.renomeios).toEqual([]);
  });

  it("linha que nunca pareou casa e recebe o nome novo", async () => {
    const f = fixture({ waha_session_name: NOME_LEGADO, phone_number: null, status: "FAILED" });
    const novo = await renomearSessaoParaOTeto(f.db, alvo);
    expect(novo).toMatch(/^org_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(f.renomeios).toEqual([novo]);
  });
});

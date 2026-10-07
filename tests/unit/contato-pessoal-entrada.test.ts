import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";

/**
 * ENTRADA DE PESSOAL: GUARDA, MAS ESCONDE — E NÃO GERA NADA (spec 21, etapa 6).
 *
 * O inbound de contato pessoal grava contato/conversa/mensagem e o carimbo de
 * não-lida como hoje (isso acontece antes, no ingest), mas a pós-entrada não
 * gera NADA: sem negócio, sem IA (fila e resposta), sem follow-up, sem
 * campanha. Defesa dupla: a pós-entrada retorna cedo E o nascimento do lead
 * recusa com `contato_pessoal` (cobre o voice-agent, que chama direto, e
 * qualquer chamador futuro).
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Mover o corte para ANTES do `aplicarOptOut`: o caso "STOP de pessoal ainda
 *   bloqueia" cai (o `is_blocked` nunca é gravado).
 * - Tirar a recusa do nascimento: o caso "nascimento recusa pessoal" cai (e o
 *   worker de voz voltaria a criar lead de pessoal).
 * - Tirar o `return` cedo: os casos "não gera nada" caem (despacho/follow-up
 *   voltam a rodar para pessoal).
 * Linha para reverter: `lib/channels/pos-entrada.ts` (corte) e
 * `lib/leads/nascimento-do-lead.ts` (recusa).
 */

const audit = vi.fn(async () => {});
const garantirLeadDaConversa = vi.fn(
  async () => ({ criado: true, leadId: "lead-1" }) as never,
);
const encerraDemanda = vi.fn(async () => ({ lead: {}, jaEstava: false }) as never);
const acelerarPipelineDeEventos = vi.fn(async () => {});

vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: (...a: unknown[]) => encerraDemanda(...(a as [])),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: (...a: unknown[]) => garantirLeadDaConversa(...(a as [])),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarPipelineDeEventos: (...a: unknown[]) =>
    acelerarPipelineDeEventos(...(a as [])),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehContatoDoNumeroInterno: vi.fn(async () => false),
}));

let contatoPessoal = false;
let ultimoUpdate: Record<string, unknown> | null = null;
let rpcChamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];

/** Elo encadeável mínimo do PostgREST, com o efeito no `await`/`maybeSingle`. */
interface Elo {
  eq(coluna: string, valor: unknown): Elo;
  order(coluna: string, opcoes?: unknown): Elo;
  limit(n: number): Elo;
  is(coluna: string, valor: unknown): Elo;
  not(coluna: string, op: string, valor: unknown): Elo;
  gte(coluna: string, valor: unknown): Elo;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then(resolve: (v: { data: unknown[]; error: null }) => void): Promise<void>;
}

function consulta(tabela: string): Elo {
  const q: Elo = {
    eq: () => q,
    order: () => q,
    limit: () => q,
    is: () => q,
    not: () => q,
    gte: () => q,
    async maybeSingle() {
      if (tabela === "contacts") return { data: { is_personal: contatoPessoal }, error: null };
      if (tabela === "channel_sessions") return { data: { metadata: {} }, error: null };
      return { data: null, error: null };
    },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      // Leitura aguardada direto (negócios abertos de quem pediu para parar).
      return Promise.resolve({ data: [], error: null }).then(resolve);
    },
  };
  return q;
}

const admin = {
  from(tabela: string) {
    return {
      update(payload: Record<string, unknown>) {
        ultimoUpdate = payload;
        const q: Elo = {
          eq: () => q,
          order: () => q,
          limit: () => q,
          is: () => q,
          not: () => q,
          gte: () => q,
          async maybeSingle() {
            return { data: null, error: null };
          },
          then(resolve: (v: { data: unknown[]; error: null }) => void) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return q;
      },
      select: () => consulta(tabela),
    };
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    rpcChamadas.push({ nome, args });
    return { error: null };
  },
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "oi, tudo bem?",
  nomeDoContato: "Cliente",
  requestId: "req-1",
  origem: "canal_de_teste",
};

async function rodar(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, ...over });
}

beforeEach(() => {
  contatoPessoal = false;
  ultimoUpdate = null;
  rpcChamadas = [];
  audit.mockClear();
  garantirLeadDaConversa.mockClear();
  garantirLeadDaConversa.mockResolvedValue({ criado: true, leadId: "lead-1" } as never);
  encerraDemanda.mockClear();
  acelerarPipelineDeEventos.mockClear();
});

describe("pós-entrada de contato pessoal não gera nada", () => {
  it("não chama IA (fila e resposta), follow-up nem nascimento", async () => {
    contatoPessoal = true;
    await rodar();

    expect(garantirLeadDaConversa, "negócio não nasce de pessoal").not.toHaveBeenCalled();
    expect(acelerarPipelineDeEventos, "follow-up quente não acorda").not.toHaveBeenCalled();
    expect(
      rpcChamadas.filter((c) => c.args.p_event_type === "ai_agent.dispatch_requested"),
      "nenhum turno é enfileirado",
    ).toHaveLength(0);
    expect(audit, "nem auditoria de efeito").not.toHaveBeenCalled();
  });

  it("STOP de pessoal ainda bloqueia (opt-out continua na frente)", async () => {
    contatoPessoal = true;
    await rodar({ texto: "quero PARAR de receber" });

    expect(ultimoUpdate).toMatchObject({ is_blocked: true, blocked_reason: "stop_keyword" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.blocked" }),
    );
    // ...mas mesmo bloqueando, nada além disso acontece.
    expect(
      rpcChamadas.filter((c) => c.args.p_event_type === "ai_agent.dispatch_requested"),
    ).toHaveLength(0);
    expect(garantirLeadDaConversa).not.toHaveBeenCalled();
  });

  it("contato normal segue gerando tudo como antes", async () => {
    contatoPessoal = false;
    await rodar();

    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(acelerarPipelineDeEventos).toHaveBeenCalledTimes(1);
    expect(
      rpcChamadas.filter((c) => c.args.p_event_type === "ai_agent.dispatch_requested"),
    ).toHaveLength(1);
  });
});

describe("nascimento do lead recusa pessoal (segunda defesa)", () => {
  function bancoDoNascimento(pessoal: boolean, bloqueado = false) {
    return {
      from() {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                async maybeSingle() {
                  return {
                    data: {
                      is_blocked: bloqueado,
                      is_personal: pessoal,
                      display_name: "Fulano",
                      name: null,
                      phone_number: "+5511999999999",
                      source: "whatsapp",
                      source_metadata: null,
                      first_service_at: null,
                    },
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      },
    } as never;
  }

  it("pessoal devolve contato_pessoal (nunca contato_bloqueado)", async () => {
    const real = await vi.importActual<typeof import("@/lib/leads/nascimento-do-lead")>(
      "@/lib/leads/nascimento-do-lead",
    );
    const r = await real.garantirLeadDaConversa(bancoDoNascimento(true), {
      organizationId: "org-1",
      contactId: "contato-1",
      conversationId: "conversa-1",
      nomeDoContato: "Fulano",
    });
    expect(r).toEqual({ criado: false, motivo: "contato_pessoal" });
  });

  it("bloqueado continua devolvendo contato_bloqueado", async () => {
    const real = await vi.importActual<typeof import("@/lib/leads/nascimento-do-lead")>(
      "@/lib/leads/nascimento-do-lead",
    );
    const r = await real.garantirLeadDaConversa(bancoDoNascimento(false, true), {
      organizationId: "org-1",
      contactId: "contato-1",
      conversationId: "conversa-1",
      nomeDoContato: "Fulano",
    });
    expect(r).toEqual({ criado: false, motivo: "contato_bloqueado" });
  });
});

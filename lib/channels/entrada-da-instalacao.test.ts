/**
 * `resolverEntradaDaInstalacao` — de quem é um evento que chegou pelo webhook
 * ÚNICO da instalação.
 *
 * O que este arquivo prova, com banco e segredo dublados:
 *   1. sem webhook registrado, a entrada não existe (404); assinatura que não
 *      confere é recusada ANTES de qualquer leitura do banco — o corpo não
 *      escolhe nada sem ela;
 *   2. evento com conta: a sessão de um clique ATIVA daquela conta, nunca uma de
 *      chave própria nem arquivada (filtros conferidos);
 *   3. conta desconhecida e conta em duas sessões: descartadas, sem escolher;
 *   4. evento de número sem conta: a sessão daquele número; número de ninguém,
 *      descartado; o `webhook.test` do painel, descartado.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ segredo: vi.fn() }));
vi.mock("./zernio/webhook-da-instalacao", () => ({ segredoDoWebhookDaInstalacao: h.segredo }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { resolverEntradaDaInstalacao } from "./entrada-da-instalacao";

const SEGREDO = "segredo-da-instalacao-de-teste-0123456789";
const CONTA = "b".repeat(24);

function assinado(evento: Record<string, unknown>, segredo = SEGREDO) {
  const corpo = JSON.stringify(evento);
  const headers = new Headers({
    "x-zernio-signature": createHmac("sha256", segredo).update(corpo, "utf8").digest("hex"),
  });
  return { corpo, headers };
}

function banco(linhas: Record<string, unknown>[]) {
  const consultas: Array<Record<string, unknown>> = [];
  const admin = {
    from: (tabela: string) => {
      const f: Record<string, unknown> = { tabela };
      consultas.push(f);
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((f[k] = v), q),
        is: (k: string, v: unknown) => ((f[`is:${k}`] = v), q),
        limit: (n: number) => ((f.limit = n), q),
        then: (resolve: (r: unknown) => void) => resolve({ data: linhas, error: null }),
      };
      return q;
    },
  };
  return { admin: admin as never, consultas };
}

const sessao = (id: string, telefone: string | null = "+5511987650001") => ({
  id,
  organization_id: `org-${id}`,
  provider: "zernio",
  display_name: "Loja",
  phone_number: telefone,
  archived_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.segredo.mockResolvedValue(SEGREDO);
});

describe("autenticação", () => {
  it("sem webhook registrado na instalação: 404, sem ler o banco", async () => {
    h.segredo.mockResolvedValue(null);
    const { admin, consultas } = banco([sessao("a")]);
    const { corpo, headers } = assinado({ event: "message.received", account: { id: CONTA } });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toEqual({
      tipo: "recusa",
      status: 404,
      motivo: "sem_webhook_da_instalacao",
    });
    expect(consultas).toEqual([]);
  });

  it("assinatura com outro segredo: 401, sem ler o banco", async () => {
    const { admin, consultas } = banco([sessao("a")]);
    const { corpo, headers } = assinado(
      { event: "message.received", account: { id: CONTA } },
      "outro-segredo-qualquer-123456",
    );
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toMatchObject({
      tipo: "recusa",
      status: 401,
    });
    expect(consultas).toEqual([]);
  });
});

describe("roteamento", () => {
  it("evento com conta: a sessão de um clique ATIVA daquela conta", async () => {
    const { admin, consultas } = banco([sessao("a")]);
    const { corpo, headers } = assinado({ event: "message.received", account: { id: CONTA } });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toEqual({
      tipo: "sessao",
      sessao: sessao("a"),
      secret: SEGREDO,
    });
    expect(consultas[0]).toMatchObject({
      tabela: "channel_sessions",
      provider: "zernio",
      zernio_credencial_da_instalacao: true,
      "is:archived_at": null,
      zernio_account_id: CONTA,
      limit: 2,
    });
  });

  it("conta que nenhuma conexão de um clique tem: descartada", async () => {
    const { admin } = banco([]);
    const { corpo, headers } = assinado({ event: "message.received", account: { id: CONTA } });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toEqual({
      tipo: "ignorar",
      motivo: "conta_desconhecida",
    });
  });

  it("conta em duas sessões ativas: descartada, sem escolher uma", async () => {
    const { admin } = banco([sessao("a"), sessao("b")]);
    const { corpo, headers } = assinado({ event: "message.received", account: { id: CONTA } });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toEqual({
      tipo: "ignorar",
      motivo: "conta_em_mais_de_uma_sessao",
    });
  });

  it("evento de número sem conta: a sessão daquele número", async () => {
    const { admin, consultas } = banco([
      sessao("a", "+5511987650001"),
      sessao("b", "+5511987650002"),
    ]);
    const { corpo, headers } = assinado({
      event: "whatsapp.number.suspended",
      number: { phoneNumber: "5511987650002" },
    });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toMatchObject({
      tipo: "sessao",
      sessao: { id: "b" },
    });
    expect(consultas[0]).not.toHaveProperty("zernio_account_id");
  });

  it("número que não é de nenhuma conexão: descartado", async () => {
    const { admin } = banco([sessao("a", "+5511987650001")]);
    const { corpo, headers } = assinado({
      event: "whatsapp.number.suspended",
      number: { phoneNumber: "+5511987659999" },
    });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toEqual({
      tipo: "ignorar",
      motivo: "numero_desconhecido",
    });
  });

  it("o teste do painel do provedor (sem conta nem número): descartado com 200", async () => {
    const { admin, consultas } = banco([sessao("a")]);
    const { corpo, headers } = assinado({ event: "webhook.test", message: "test" });
    expect(await resolverEntradaDaInstalacao(admin, corpo, headers)).toEqual({
      tipo: "ignorar",
      motivo: "evento_sem_conta",
    });
    expect(consultas).toEqual([]);
  });
});

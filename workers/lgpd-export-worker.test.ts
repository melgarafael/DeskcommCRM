// @vitest-environment node
/**
 * DOIS EMISSORES, UMA EXPORTAÇÃO (issue #2751).
 *
 * O webhook da Nuvemshop e a aprovação emitiam `lgpd.data_request_received` cada
 * um; com dois drenos (o laço do worker e o cron) os dois eventos podem rodar em
 * PARALELO — e, antes da reivindicação, os dois exportavam: `attempts=2` e dois
 * `lgpd.export_generated` na trilha, com o PDF montado em dobro.
 *
 * Este arquivo roda o `processLgpdExport` de VERDADE com as bordas dubladas. O
 * banco falso entende os filtros que o PostgREST receberia (`eq`, `neq`,
 * `or(...is.null / lt...)`) e é o único lugar onde a "linha" muda; os dublês de
 * PDF/upload/e-mail contam cada efeito.
 *
 * O caso ⭐ é o que fica vermelho se o segundo emissor voltar a exportar: a
 * primeira execução é travada DENTRO da coleta (a janela exata da corrida) e a
 * segunda roda por inteiro nesse meio-tempo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";

const d = vi.hoisted(() => ({
  adminAtual: { valor: null as unknown },
  collectExportData: vi.fn(),
  renderLgpdPdf: vi.fn(),
  signPdfPades: vi.fn(),
  isPadesConfigured: vi.fn(),
  sendExportEmail: vi.fn(),
  audit: vi.fn(),
  perfilDaOrganizacao: vi.fn(),
  marcaDaSaida: vi.fn(),
  valorDaInstalacao: vi.fn(),
  partesDoArquivoDoTitular: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => d.adminAtual.valor,
}));
vi.mock("@/lib/lgpd/export-collector", () => ({ collectExportData: d.collectExportData }));
vi.mock("@/lib/lgpd/pdf-renderer", () => ({ renderLgpdPdf: d.renderLgpdPdf }));
vi.mock("@/lib/lgpd/pades-signer", () => ({
  signPdfPades: d.signPdfPades,
  isPadesConfigured: d.isPadesConfigured,
}));
vi.mock("@/lib/lgpd/email-delivery", () => ({
  sendExportEmail: d.sendExportEmail,
  hashEmail: (email: string) => `hash:${email}`,
  EmailNotConfigured: class EmailNotConfigured extends Error {},
  EmailSendFailed: class EmailSendFailed extends Error {},
}));
vi.mock("@/lib/audit", () => ({ audit: d.audit }));
vi.mock("@/lib/legal/perfil-do-pais", () => ({ perfilDaOrganizacao: d.perfilDaOrganizacao }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: d.marcaDaSaida }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: d.valorDaInstalacao }));
vi.mock("@/lib/lgpd/copia-do-titular", () => ({
  partesDoArquivoDoTitular: d.partesDoArquivoDoTitular,
}));

import { processLgpdExport } from "@/workers/lgpd-export-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const PEDIDO = "22222222-2222-4222-8222-222222222222";

type Pedido = Record<string, unknown>;

/**
 * Banco falso com a LINHA do pedido e a semântica dos filtros que o PostgREST
 * aplica: `eq`, `neq`, `lt` e `or(termo,termo)` com `col.is.null` /
 * `col.lt.valor`. O UPDATE só toca as linhas que casam TODOS os filtros — é
 * isto que a reivindicação usa como trava.
 */
function criarBancoFalso(iniciais: Pedido[]) {
  const pedidos = new Map<string, Pedido>(iniciais.map((p) => [p.id as string, { ...p }]));
  const efeitos = { uploads: [] as string[], rpcs: [] as string[] };

  const avaliarTermo = (p: Pedido, termo: string): boolean => {
    const [col = "", op = "", ...resto] = termo.split(".");
    const valor = resto.join(".");
    if (op === "is" && valor === "null") return p[col] === null || p[col] === undefined;
    if (op === "lt") return p[col] != null && String(p[col]) < valor;
    throw new Error(`filtro nao suportado no banco falso: ${termo}`);
  };

  type Pred = (p: Pedido) => boolean;

  class Cadeia {
    ops: Pred[] = [];
    patch: Pedido | null = null;

    eq(col: string, val: unknown) {
      this.ops.push((p) => p[col] === val);
      return this;
    }
    neq(col: string, val: unknown) {
      this.ops.push((p) => p[col] !== val);
      return this;
    }
    or(expr: string) {
      const termos = expr.split(",");
      this.ops.push((p) => termos.some((t) => avaliarTermo(p, t.trim())));
      return this;
    }
    select(_colunas: string) {
      return this;
    }
    private executar(): { data: Pedido[]; error: null } {
      const casadas = [...pedidos.values()].filter((p) => this.ops.every((f) => f(p)));
      if (this.patch) for (const p of casadas) Object.assign(p, this.patch);
      return { data: casadas, error: null };
    }
    maybeSingle() {
      const { data } = this.executar();
      return { data: data[0] ?? null, error: null };
    }
    then(onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve(this.executar()).then(onF, onR);
    }
  }

  const admin = {
    from(tabela: string) {
      if (tabela !== "lgpd_requests") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        update: (patch: Pedido) => {
          const c = new Cadeia();
          c.patch = patch;
          return c;
        },
        select: (_colunas: string) => new Cadeia(),
      };
    },
    rpc: async (nome: string) => {
      efeitos.rpcs.push(nome);
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          efeitos.uploads.push(path);
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://exemplo.invalid/${bucket}/${path}` },
          error: null,
        }),
      }),
    },
  };

  return {
    admin,
    efeitos,
    pedido: () => ({ ...(pedidos.get(PEDIDO) as Pedido) }),
  };
}

function pedidoNove(extra: Partial<Pedido> = {}): Pedido {
  return {
    id: PEDIDO,
    organization_id: ORG,
    request_type: "data_request",
    status: "received",
    attempts: 0,
    request_payload: { delivery: { method: "email", address: "titular@exemplo.invalid" } },
    contact_id: null,
    external_customer_id: null,
    export_claimed_at: null,
    result: null,
    ...extra,
  };
}

const ADMIN = "33333333-3333-4333-8333-333333333333";

/** Evento da APROVAÇÃO (o payload que `approve/route.ts` grava) — o único que exporta. */
function evento(id: string): EventRow {
  return {
    id,
    organization_id: ORG,
    event_type: "lgpd.data_request_received",
    entity_kind: "lgpd_request",
    entity_id: PEDIDO,
    payload: {
      request_id: PEDIDO,
      manually_approved: true,
      approved_by: ADMIN,
      approved_reason: "conferido com o titular",
    },
    metadata: { manually_approved: true },
    consumed_by: [],
    attempts: 0,
  };
}

/** Evento SEM aprovação — o que o webhook da Nuvemshop emitia até o doc 134. */
function eventoSemAprovacao(id: string): EventRow {
  return {
    ...evento(id),
    payload: { request_id: PEDIDO, organization_id: ORG, delivery: { method: "email", address: "titular@exemplo.invalid" } },
    metadata: { store_id: "123" },
  };
}

const dadosDeExport = () => ({ contact: { email: null }, fuso: "America/Sao_Paulo" });

beforeEach(() => {
  vi.clearAllMocks();
  d.collectExportData.mockImplementation(async () => dadosDeExport());
  d.renderLgpdPdf.mockImplementation(async () => Buffer.from("%PDF-falso"));
  d.signPdfPades.mockImplementation(async () => ({
    signed: Buffer.from("%PDF-assinado"),
    sha256: "sha256-falso",
    signed_pades: false,
    warning: null,
  }));
  d.isPadesConfigured.mockImplementation(() => false);
  d.sendExportEmail.mockImplementation(async () => ({ messageId: "msg-1" }));
  d.audit.mockImplementation(async () => undefined);
  d.perfilDaOrganizacao.mockImplementation(async () => ({ codigo: "BR", calendario: { feriados: [] } }));
  d.marcaDaSaida.mockImplementation(async () => ({ nome: "Organização", logoUrl: null, accentHex: "#123456" }));
  d.valorDaInstalacao.mockImplementation(async () => ({ valor: null }));
  d.partesDoArquivoDoTitular.mockImplementation(() => (async function* () {
    yield "{}";
  })());
});

describe("a exportação do titular é reivindicada por pedido (issue #2751)", () => {
  it("⭐ dois eventos do mesmo pedido (dois cliques, ou retry + clique) geram UMA exportação", async () => {
    const banco = criarBancoFalso([pedidoNove()]);
    d.adminAtual.valor = banco.admin;

    // A primeira execução (evento do webhook) para DENTRO da coleta — a janela
    // exata em que o segundo evento (da aprovação) chega em outro dreno.
    let soltar: () => void = () => {};
    d.collectExportData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          soltar = () => resolve(dadosDeExport());
        }),
    );

    const primeira = processLgpdExport(evento("e1"));
    await vi.waitFor(() => expect(d.collectExportData).toHaveBeenCalledTimes(1));

    const segunda = await processLgpdExport(evento("e2"));
    expect(segunda.status).toBe("skipped");
    expect(segunda.detail).toBe("already_in_flight");

    soltar();
    const resultado = await primeira;
    expect(resultado.status).toBe("ok");

    expect(d.renderLgpdPdf, "o segundo emissor voltou a montar o PDF").toHaveBeenCalledTimes(1);
    expect(d.sendExportEmail, "o segundo emissor voltou a mandar o e-mail").toHaveBeenCalledTimes(1);
    expect(banco.efeitos.uploads.filter((p) => p.endsWith("/report.pdf"))).toHaveLength(1);
    expect(banco.efeitos.uploads.filter((p) => p.endsWith("/data.json"))).toHaveLength(1);
    expect(banco.pedido().attempts, "attempts contou as duas execuções").toBe(1);
    expect(banco.pedido().status).toBe("completed");
  });

  it("reivindicação VENCIDA é retomada (processo derrubado no meio)", async () => {
    const banco = criarBancoFalso([
      pedidoNove({
        status: "processing",
        attempts: 1,
        export_claimed_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      }),
    ]);
    d.adminAtual.valor = banco.admin;

    const resultado = await processLgpdExport(evento("e3"));
    expect(resultado.status).toBe("ok");
    expect(banco.pedido().attempts).toBe(2);
    expect(banco.pedido().status).toBe("completed");
  });

  it("reivindicação FRESCA não é retomada, mesmo sem ninguém rodando agora", async () => {
    const banco = criarBancoFalso([
      pedidoNove({ status: "processing", attempts: 1, export_claimed_at: new Date().toISOString() }),
    ]);
    d.adminAtual.valor = banco.admin;

    const resultado = await processLgpdExport(evento("e4"));
    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toBe("already_in_flight");
    expect(d.renderLgpdPdf).not.toHaveBeenCalled();
  });

  it("falha LIMPA a reivindicação e o retry não espera a janela de órfã", async () => {
    const banco = criarBancoFalso([pedidoNove()]);
    d.adminAtual.valor = banco.admin;

    d.collectExportData.mockRejectedValueOnce(new Error("coleta falhou"));
    const falha = await processLgpdExport(evento("e5"));
    expect(falha.status).toBe("error");
    expect(banco.pedido().status).toBe("received");
    expect(banco.pedido().export_claimed_at).toBeNull();

    // O retry imediato (mesmo antes dos 10 min) reivindica de novo.
    const retry = await processLgpdExport(evento("e6"));
    expect(retry.status).toBe("ok");
    expect(banco.pedido().attempts).toBe(2);
  });

  it("falha de e-mail TAMBÉM limpa a reivindicação (o retry do Resend não espera)", async () => {
    const banco = criarBancoFalso([pedidoNove()]);
    d.adminAtual.valor = banco.admin;

    d.sendExportEmail.mockRejectedValueOnce(new Error("resend fora do ar"));
    const falha = await processLgpdExport(evento("e8"));
    expect(falha.status).toBe("error");
    expect(banco.pedido().status).toBe("received");
    expect(banco.pedido().export_claimed_at).toBeNull();

    const retry = await processLgpdExport(evento("e9"));
    expect(retry.status).toBe("ok");
    expect(banco.pedido().attempts).toBe(2);
  });

  it("erro do banco na reivindicação devolve error, e o evento não é consumido", async () => {
    const banco = criarBancoFalso([pedidoNove()]);
    // O UPDATE da reivindicação falha sem gravar (statement timeout): a linha
    // não muda e o PostgREST devolve `error`.
    const fromOriginal = banco.admin.from.bind(banco.admin);
    d.adminAtual.valor = {
      ...banco.admin,
      from: (tabela: string) => {
        const t = fromOriginal(tabela);
        return {
          ...t,
          update: (patch: Pedido) =>
            Object.assign(t.update(patch), {
              select: async () => ({
                data: null,
                error: { code: "57014", message: "canceling statement due to statement timeout" },
              }),
            }),
        };
      },
    };

    const resultado = await processLgpdExport(evento("e10"));
    expect(resultado.status, "o dreno consumiria o evento e o pedido ficaria sem export").toBe("error");
    expect(resultado.detail).toBe("claim_failed: 57014");
    expect(d.renderLgpdPdf).not.toHaveBeenCalled();
    expect(banco.efeitos.uploads).toHaveLength(0);
    expect(d.sendExportEmail).not.toHaveBeenCalled();
  });

  it("pedido concluído não reexporta", async () => {
    const banco = criarBancoFalso([pedidoNove({ status: "completed", attempts: 1 })]);
    d.adminAtual.valor = banco.admin;

    const resultado = await processLgpdExport(evento("e7"));
    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toBe("already_completed");
    expect(d.renderLgpdPdf).not.toHaveBeenCalled();
    expect(d.sendExportEmail).not.toHaveBeenCalled();
  });
});

describe("o pedido da Nuvemshop espera a aprovação (doc 134, opção A)", () => {
  it("⭐ antes da aprovação nada é montado nem enviado; depois do clique, é enviado", async () => {
    const banco = criarBancoFalso([pedidoNove()]);
    d.adminAtual.valor = banco.admin;

    // O evento sem a marca da aprovação (o do webhook, ainda na fila de quem
    // atualiza) é consumido sem efeito: o pedido continua esperando o clique.
    const antes = await processLgpdExport(eventoSemAprovacao("n1"));
    expect(antes.status).toBe("skipped");
    expect(antes.detail).toBe("awaiting_approval");
    expect(d.collectExportData, "montou o arquivo antes da aprovação").not.toHaveBeenCalled();
    expect(d.renderLgpdPdf).not.toHaveBeenCalled();
    expect(d.sendExportEmail, "enviou ao titular antes da aprovação").not.toHaveBeenCalled();
    expect(banco.efeitos.uploads).toHaveLength(0);
    expect(banco.pedido().status, "o pedido deixou de esperar o clique").toBe("received");
    expect(banco.pedido().attempts).toBe(0);
    expect(banco.pedido().export_claimed_at).toBeNull();

    // O admin aprova: a rota emite o evento com a marca, e o envio acontece.
    const depois = await processLgpdExport(evento("n2"));
    expect(depois.status).toBe("ok");
    expect(d.sendExportEmail).toHaveBeenCalledTimes(1);
    expect(d.sendExportEmail.mock.calls[0]?.[0]).toMatchObject({ to: "titular@exemplo.invalid" });
    expect(banco.pedido().status).toBe("completed");
  });

  it("a marca precisa do autor: manually_approved sem approved_by não exporta", async () => {
    const banco = criarBancoFalso([pedidoNove()]);
    d.adminAtual.valor = banco.admin;

    const semAutor = evento("n3");
    semAutor.payload = { request_id: PEDIDO, manually_approved: true };
    const resultado = await processLgpdExport(semAutor);
    expect(resultado.detail).toBe("awaiting_approval");
    expect(d.sendExportEmail).not.toHaveBeenCalled();
    expect(banco.pedido().status).toBe("received");
  });
});

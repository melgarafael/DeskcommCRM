/**
 * O PEDIDO DE DADOS SEM E-MAIL NÃO PODE TRAVAR EM "PROCESSANDO" CALADO.
 *
 * Medido na prova pela tela do #2669 (vps-teste, 11/10): sem transporte de
 * e-mail, o worker gravava `pending_review`, o CHECK do banco recusava (23514),
 * e o worker não lia o erro — auditava `lgpd.export_generated`, devolvia `ok` ao
 * dispatcher (sem retentativa) e o pedido ficava em `processing` para sempre.
 *
 * A migration 0651 faz o banco aceitar o estado (`tests/invariants/pedido-lgpd-
 * sem-email-vira-revisao-pendente.test.ts`). Este arquivo prende a OUTRA metade:
 * se o banco recusar o desfecho de novo, por qualquer razão, o worker falha
 * fechado — não audita o que não aconteceu, devolve `error` e devolve o pedido à
 * fila com o código do erro. Os casos 1 e 3 ficam vermelhos com o update de volta
 * ao fire-and-forget; o caso 2 é o controle de que o caminho bom continua bom.
 *
 * E a rota do detalhe passa a dar o link do PDF para `pending_review` — é o
 * arquivo que o operador entrega à mão (caso 4). Desde a #2341 ela dá também o
 * do `data.json`: o pacote é dois arquivos, e o caminho manual — justamente o
 * de quem não recebeu e-mail — entregava um só (casos 6 e 7).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as EmailDelivery from "@/lib/lgpd/email-delivery";

type Patch = Record<string, unknown>;
const estado = vi.hoisted(() => ({
  updates: [] as Patch[],
  recusarPendingReview: false,
  pedido: {} as Record<string, unknown>,
  semTransporte: true,
  detalhe: null as Record<string, unknown> | null,
  assinados: [] as string[],
}));

vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/lgpd/repository", () => ({ findLgpdRequest: async () => estado.pedido }));
vi.mock("@/lib/lgpd/export-collector", () => ({
  collectExportData: async () => ({ contact: { email: null } }),
}));
vi.mock("@/lib/lgpd/pdf-renderer", () => ({ renderLgpdPdf: async () => Buffer.from("pdf") }));
vi.mock("@/lib/lgpd/pades-signer", () => ({
  isPadesConfigured: () => false,
  signPdfPades: async (b: Buffer) => ({ signed: b, sha256: "abc", signed_pades: false, warning: "pades_key_missing" }),
}));
vi.mock("@/lib/lgpd/copia-do-titular", () => ({ partesDoArquivoDoTitular: function* () {} }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({}) }));
vi.mock("@/lib/legal/perfil-do-pais", () => ({ perfilDaOrganizacao: async () => ({ codigo: "BR" }) }));
vi.mock("@/lib/lgpd/email-delivery", async (original) => {
  const real = await original<typeof EmailDelivery>();
  return {
    ...real,
    sendExportEmail: async () => {
      if (estado.semTransporte) throw new real.EmailNotConfigured();
      return { messageId: "m1" };
    },
  };
});
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { idioma: "pt-BR" }, org: { orgId: ORG_DA_SESSAO } }),
}));
const ORG_DA_SESSAO = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      // Leitura da rota do detalhe: a linha do pedido e um rastro de audit vazio.
      select: () => {
        const q: Record<string, unknown> = {
          eq: () => q,
          or: () => q,
          order: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: estado.detalhe, error: null }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
        };
        return q;
      },
      update: (patch: Patch) => {
        estado.updates.push(patch);
        const recusa = estado.recusarPendingReview && patch.status === "pending_review";
        // `data` responde à reivindicação atômica do worker (#2751: update…select("id")):
        // uma linha devolvida = este evento reivindicou o pedido e segue exportando.
        const resposta = {
          data: [{ id: "reivindicado" }],
          error: recusa
            ? {
                code: "23514",
                message: 'new row for relation "lgpd_requests" violates check constraint',
                details: "Failing row contains (… titular@exemplo.test …)",
              }
            : null,
        };
        const q = {
          eq: () => q,
          neq: () => q,
          or: () => q,
          select: () => q,
          then: (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok),
        };
        return q;
      },
    }),
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        createSignedUrl: async (caminho: string) => {
          estado.assinados.push(caminho);
          return { data: { signedUrl: "https://storage.test/x" }, error: null };
        },
      }),
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processLgpdExport } from "@/workers/lgpd-export-worker";
import { GET as detalhe } from "@/app/api/v1/lgpd/requests/[id]/route";

const ORG = ORG_DA_SESSAO;
const PEDIDO = "22222222-2222-4222-8222-222222222222";
// Desde o #2897 (doc 134) o worker só exporta o evento que a rota de aprovação
// emite, com `manually_approved` + `approved_by`. Este teste mede o pedido SEM
// e-mail DEPOIS de aprovado, então o evento leva a marca da aprovação.
const APROVADOR = "33333333-3333-4333-8333-333333333333";
const evento = {
  id: 1,
  organization_id: ORG,
  entity_id: PEDIDO,
  payload: { request_id: PEDIDO, manually_approved: true, approved_by: APROVADOR },
} as unknown as EventRow;

const auditouExportado = () =>
  vi.mocked(audit).mock.calls.some(([e]) => (e as { action: string }).action === "lgpd.export_generated");

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(logger.error).mockClear();
  estado.updates = [];
  estado.recusarPendingReview = false;
  estado.semTransporte = true;
  estado.pedido = {
    id: PEDIDO,
    organization_id: ORG,
    status: "received",
    request_type: "data_request",
    attempts: 0,
    contact_id: null,
    external_customer_id: null,
    request_payload: { delivery: { address: "titular@exemplo.test" } },
  };
});

describe("lgpd-export-worker: o desfecho pending_review é conferido", () => {
  it("1. sem transporte e o banco recusa: não audita 'exportado', devolve error e devolve o pedido à fila", async () => {
    estado.recusarPendingReview = true;

    const r = await processLgpdExport(evento);

    expect(r.status).toBe("error");
    expect(auditouExportado()).toBe(false);
    const ultimo = estado.updates[estado.updates.length - 1]!;
    expect(ultimo.status).toBe("received");
    expect(String(ultimo.error_message)).toContain("23514");
    // De volta à fila sem reivindicação pendurada (#2751): o retry não espera a janela de órfã.
    expect(ultimo.export_claimed_at).toBeNull();
    // Só o código sai do erro: o detalhe do Postgres traz a linha, e a linha traz o e-mail.
    expect(JSON.stringify(estado.updates)).not.toContain("titular@exemplo.test");
    expect(logger.error).toHaveBeenCalled();
  });

  it("2. controle: sem transporte e o banco aceita, o pedido fica em pending_review e audita", async () => {
    const r = await processLgpdExport(evento);

    expect(r).toMatchObject({ status: "ok", detail: "email_not_configured" });
    expect(estado.updates.at(-1)).toMatchObject({
      status: "pending_review",
      error_message: "email_not_configured",
      result: { pdf_path: `${ORG}/${PEDIDO}/report.pdf`, json_path: `${ORG}/${PEDIDO}/data.json` },
    });
    expect(auditouExportado()).toBe(true);
  });

  it("3. titular sem endereço e o banco recusa: mesma falha fechada", async () => {
    estado.recusarPendingReview = true;
    estado.pedido = { ...estado.pedido, request_payload: {} };

    const r = await processLgpdExport(evento);

    expect(r.status).toBe("error");
    expect(auditouExportado()).toBe(false);
    expect(estado.updates.at(-1)?.status).toBe("received");
  });
});

describe("GET /api/v1/lgpd/requests/[id]: o pacote da revisão pendente chega ao operador", () => {
  const pedirDetalhe = async (status: string, result: Record<string, unknown> = {
    pdf_path: `${ORG}/${PEDIDO}/report.pdf`,
  }) => {
    estado.assinados = [];
    estado.detalhe = {
      id: PEDIDO,
      organization_id: ORG,
      status,
      result,
    };
    const resposta = await detalhe({} as never, { params: Promise.resolve({ id: PEDIDO }) });
    return (await resposta.json()) as {
      data: { signed_pdf_url: string | null; signed_json_url: string | null };
    };
  };

  it("4. pending_review com PDF gerado devolve o link assinado", async () => {
    const corpo = await pedirDetalhe("pending_review");
    expect(corpo.data.signed_pdf_url).toBe("https://storage.test/x");
    expect(estado.assinados).toEqual([`${ORG}/${PEDIDO}/report.pdf`]);
    // Resultado anterior ao `json_path`: não há arquivo, e a rota não inventa um.
    expect(corpo.data.signed_json_url).toBeNull();
  });

  it("5. controle: processing não ganha link", async () => {
    const corpo = await pedirDetalhe("processing");
    expect(corpo.data.signed_pdf_url).toBeNull();
    expect(corpo.data.signed_json_url).toBeNull();
    expect(estado.assinados).toEqual([]);
  });

  it("6. ⭐ pending_review devolve as DUAS ligações: o PDF e a cópia que ele resume (#2341)", async () => {
    const corpo = await pedirDetalhe("pending_review", {
      pdf_path: `${ORG}/${PEDIDO}/report.pdf`,
      json_path: `${ORG}/${PEDIDO}/data.json`,
    });

    expect(corpo.data.signed_pdf_url).toBe("https://storage.test/x");
    expect(
      corpo.data.signed_json_url,
      "o operador é quem entrega à mão, e a tela não lhe dá o arquivo de dados",
    ).toBe("https://storage.test/x");
    // As duas assinaturas, na ordem em que o pacote é entregue.
    expect(estado.assinados).toEqual([`${ORG}/${PEDIDO}/report.pdf`, `${ORG}/${PEDIDO}/data.json`]);
  });

  it("7. completed também entrega as duas (o titular que abriu o link depois)", async () => {
    const corpo = await pedirDetalhe("completed", {
      pdf_path: `${ORG}/${PEDIDO}/report.pdf`,
      json_path: `${ORG}/${PEDIDO}/data.json`,
    });
    expect(corpo.data.signed_pdf_url).toBe("https://storage.test/x");
    expect(corpo.data.signed_json_url).toBe("https://storage.test/x");
  });
});

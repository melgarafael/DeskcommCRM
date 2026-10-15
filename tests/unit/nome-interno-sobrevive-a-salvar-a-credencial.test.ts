/**
 * O nome interno da conexão (Renomear, #2802) sobrevive a salvar a credencial de novo.
 *
 * `channel_sessions.display_name` tem dois donos em sequência: o provedor batiza a
 * conexão (nome verificado do número), e depois o operador a renomeia. Os três
 * caminhos que regravam a credencial — canal oficial, provedor parceiro e o parceiro
 * que espelha a Cloud API — gravavam o nome do provedor a cada envio, e o nome dado
 * à mão voltava ao do provedor sem aviso. O pareamento por QR já preservava
 * (`coalesce(display_name, ...)` no banco); aqui os três seguem a mesma regra.
 *
 * Handler REAL de ponta a ponta (renomear → salvar credencial → ler a linha), sobre
 * um dublê que aplica os filtros e guarda o estado. E a outra metade: a primeira
 * conexão continua recebendo o nome do provedor.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhas: [] as Array<Record<string, unknown>>,
  validarOficial: vi.fn(),
  validarParceiro: vi.fn(),
  validarEspelho: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "cifrado"),
  decryptWebhookSecret: vi.fn(async () => null),
}));
vi.mock("@/lib/webhooks/url-publica", () => ({
  basePublicaDaInstalacao: () => "https://crm.test",
  basePublicaDoWebhookMeta: () => "https://crm.test",
}));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: h.validarOficial,
}));
vi.mock("@/lib/channels/meta/webhook-da-sessao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarWebhookDaSessao: vi.fn(async () => null),
}));
vi.mock("@/lib/channels/connect", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  validatePartnerCredentials: h.validarParceiro,
}));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  canalGraphParceiroLigado: () => true,
  GRAPH_PARTNER_LABEL: "Parceiro",
}));
vi.mock("@/lib/channels/graph-parceiro/validate-credentials", () => ({
  validateGraphPartnerCredentials: h.validarEspelho,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubleDoBanco() }));

import { PATCH as renomear } from "@/app/api/v1/channel-sessions/[id]/name/route";
import { POST as salvarEspelho } from "@/app/api/v1/channels/graph-partner/route";
import { POST as salvarOficial } from "@/app/api/v1/channels/official/route";
import { POST as salvarParceiro } from "@/app/api/v1/channels/partner/route";
import { CHANNEL_PROVIDER_DATAFY, CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { PARTNER_CHANNEL_PROVIDER } from "@/lib/channels/connect";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

/** Só o que estas rotas pedem ao banco: filtro por igualdade, update, insert. */
function dubleDoBanco() {
  return {
    from() {
      const filtros: Array<[string, unknown]> = [];
      let op: "select" | "update" | "insert" = "select";
      let corpo: Record<string, unknown> = {};
      let unica = false;
      let comRetorno = false;
      const casam = () =>
        h.linhas.filter((l) => filtros.every(([c, v]) => (l[c] ?? null) === v));
      const executar = () => {
        if (op === "insert") {
          const nova = { id: CANAL, archived_at: null, ...corpo };
          h.linhas.push(nova);
          return { data: nova, error: null };
        }
        const achadas = casam();
        if (op === "update") {
          for (const l of achadas) Object.assign(l, corpo);
          if (!comRetorno) return { data: null, error: null };
        }
        return { data: unica ? (achadas[0] ?? null) : achadas, error: null };
      };
      const q = {
        select: () => ((comRetorno = true), q),
        eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
        is: (c: string, v: unknown) => (filtros.push([c, v]), q),
        order: () => q,
        limit: () => q,
        maybeSingle: () => ((unica = true), q),
        single: () => ((unica = true), q),
        update: (p: Record<string, unknown>) => ((op = "update"), (corpo = p), (comRetorno = false), q),
        insert: (p: Record<string, unknown>) => ((op = "insert"), (corpo = p), q),
        then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(executar()).then(ok, erro),
      };
      return q;
    },
  };
}

const pedido = (url: string, method: string, body: unknown) =>
  new NextRequest(`https://crm.test${url}`, { method, body: JSON.stringify(body) });

async function renomearPara(nome: string) {
  const r = await renomear(pedido(`/api/v1/channel-sessions/${CANAL}/name`, "PATCH", { display_name: nome }), {
    params: Promise.resolve({ id: CANAL }),
  });
  expect(r.status).toBe(200);
}

function canal(provider: string): Record<string, unknown> {
  return {
    id: CANAL,
    organization_id: ORG,
    provider,
    display_name: "Nome do provedor",
    webhook_path_token: "tok123456789",
    archived_at: null,
    status: "WORKING",
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

const CAMINHOS = [
  {
    nome: "canal oficial",
    provider: CHANNEL_PROVIDER_META,
    salvar: () =>
      salvarOficial(
        pedido("/api/v1/channels/official", "POST", {
          phone_number_id: "1234567",
          waba_id: "7654321",
          token: "t".repeat(30),
        }),
      ),
  },
  {
    nome: "provedor parceiro",
    provider: PARTNER_CHANNEL_PROVIDER,
    salvar: () =>
      salvarParceiro(pedido("/api/v1/channels/partner", "POST", { account_id: "conta-1", api_key: "k".repeat(20) })),
  },
  {
    nome: "parceiro que espelha a Cloud API",
    provider: CHANNEL_PROVIDER_DATAFY,
    salvar: () => salvarEspelho(pedido("/api/v1/channels/graph-partner", "POST", { token: "x".repeat(30) })),
  },
];

beforeEach(() => {
  h.linhas.length = 0;
  h.validarOficial.mockResolvedValue({ ok: true, displayPhoneNumber: "5531999990000", verifiedName: "Nome do provedor" });
  h.validarParceiro.mockResolvedValue({ ok: true, phoneNumber: "5531999990000", displayName: "Nome do provedor", qualityRating: null });
  h.validarEspelho.mockResolvedValue({
    ok: true,
    phoneNumberId: "1234567",
    wabaId: "7654321",
    displayPhoneNumber: "5531999990000",
    verifiedName: "Nome do provedor",
  });
});

describe.each(CAMINHOS)("$nome", ({ provider, salvar }) => {
  it("renomear → salvar a credencial de novo → o nome dado à mão continua", async () => {
    h.linhas.push(canal(provider));
    await renomearPara("WA | Fixo 7906");

    const r = await salvar();

    expect(r.status).toBe(200);
    expect(h.linhas).toHaveLength(1);
    expect(h.linhas[0]!.display_name).toBe("WA | Fixo 7906");
  });

  it("a primeira conexão continua recebendo o nome do provedor", async () => {
    const r = await salvar();

    expect(r.status).toBe(200);
    expect(h.linhas).toHaveLength(1);
    expect(h.linhas[0]!.display_name).toBe("Nome do provedor");
  });
});

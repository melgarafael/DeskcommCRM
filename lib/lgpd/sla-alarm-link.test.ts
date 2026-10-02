import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O LINK DO E-MAIL DE PRAZO DA LGPD LEVA AO PEDIDO, COM A EMPRESA SUSPENSA OU NÃO
 * (acabamento 7 do PR 1; spec da cobrança §4 "LGPD: nunca bloqueada").
 *
 * `/app/lgpd/requests/<id>` passa pelo layout de `/app`, que manda a empresa
 * parada para `/account-suspended` SEM o pedido — o DPO caía na lista, com o
 * prazo legal correndo. E escolher a porta no ENVIO erra quando a empresa muda
 * de estado antes do clique. O link é sempre a porta neutra `/lgpd/pedido/<id>`,
 * que decide no clique (`app/lgpd/pedido/[id]/route.ts`).
 */
const enviado = vi.hoisted(() => ({ html: "", text: "" }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: vi.fn(async (e: { html: string; text: string }) => {
    enviado.html = e.html;
    enviado.text = e.text;
    return { ok: true };
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));

import { triggerSlaAlarm } from "./sla-alarm";
import type { LgpdRequest } from "./types";

const ID = "22222222-2222-4222-8222-222222222222";
const pedido = {
  id: ID,
  organization_id: "00000000-0000-4000-8000-00000000000b",
  request_type: "data_request",
  status: "pending",
  attempts: 0,
  received_at: "2026-09-20T12:00:00.000Z",
  due_at: "2026-09-27T12:00:00.000Z",
  request_payload: {},
} as unknown as LgpdRequest;

async function alarmar() {
  await triggerSlaAlarm({
    request: pedido,
    threshold: "data_request_d5",
    organizationDpoEmail: "dpo@empresa.test",
    organizationName: "Empresa B",
    marca: { nome: "CRM", accent: "#000000", accentFg: "#ffffff" } as never,
  });
}

beforeEach(() => {
  enviado.html = "";
  enviado.text = "";
});

describe("sla-alarm: o link do e-mail abre o pedido", () => {
  it("o link é a porta neutra, nem /app nem o hub: quem decide é o clique", async () => {
    await alarmar();
    expect(enviado.html).toContain(`href="https://crm.test/lgpd/pedido/${ID}"`);
    expect(enviado.text).toContain(`https://crm.test/lgpd/pedido/${ID}`);
    expect(enviado.text).not.toContain("/app/lgpd/requests/");
    expect(enviado.text).not.toContain("/account-suspended");
  });
});

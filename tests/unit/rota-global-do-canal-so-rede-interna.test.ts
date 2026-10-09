import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota GLOBAL do webhook do canal (sem token) só atende a rede interna.
 *
 * O WAHA da stack chama `http://app:3000` pela rede do Docker; tudo que vem de
 * fora atravessa um proxy de borda (Caddy, Traefik, Nginx Proxy Manager, túnel)
 * e deve usar a rota por token. A regra mora na aplicação para valer igual em
 * qualquer modo de instalação.
 *
 * Os cabeçalhos dos casos "interna" e "Traefik" são os MEDIDOS em
 * `webhook_events_log` de uma instalação real (08/10/2026; o endereço público
 * foi trocado por um de exemplo): 82 entregas da rota global, todas com
 * `x-forwarded-for: 10.0.4.x` e `x-forwarded-proto: http` — que o próprio Next
 * preenche —, e 5 da rota por token via Traefik, com `x-real-ip`,
 * `x-forwarded-server` e `https`.
 */

let clientesCriados = 0;
const arquivados: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    clientesCriados += 1;
    return {
      from: () => ({
        insert: (linha: Record<string, unknown>) => {
          arquivados.push(linha);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
      rpc: async () => ({ data: "segredo-decifrado-longo", error: null }),
    };
  },
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({
    data: {
      id: "sess-1",
      organization_id: "org-1",
      waha_session_name: "default",
      webhook_secret_encrypted: "\\x00",
      status: "WORKING",
      is_warmup_complete: true,
      warmup_started_at: null,
    },
    error: null,
  }),
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

vi.mock("@/lib/waha/webhook-auth", () => ({
  authenticateWahaWebhook: () => ({ ok: true, signatureVerified: true }),
}));

vi.mock("@/lib/waha/ingest", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dispatchWahaEvent: async () => undefined,
}));

import { POST as postGlobal } from "@/app/api/v1/webhooks/waha/route";
import { POST as postPorToken } from "@/app/api/v1/webhooks/waha/[token]/route";
import { chegouPelaBorda } from "@/lib/http/ip-do-cliente";
import { limparMemoriaDeSessoes } from "@/lib/waha/sessao-do-webhook";

const EVENTO = {
  event: "message",
  session: "default",
  payload: { id: "wamid.REDE", from: "5531988887777@c.us", body: "oi" },
};

const pedido = (cabecalhos: Record<string, string>) =>
  ({
    text: async () => JSON.stringify(EVENTO),
    headers: new Headers({ "x-webhook-hmac": "sha512=abc", ...cabecalhos }),
  }) as never;

/** O que o Next entrega à rota quando o WAHA chama pela rede do Docker. */
const INTERNA = { "x-forwarded-for": "10.0.4.3", "x-forwarded-proto": "http", "x-forwarded-port": "3000" };

const PELA_BORDA: Record<string, Record<string, string>> = {
  "Caddy (x-forwarded-for público)": { "x-forwarded-for": "200.160.2.3", "x-forwarded-proto": "http" },
  "Caddy atrás do Docker (endereço privado, mas https)": { "x-forwarded-for": "172.18.0.1", "x-forwarded-proto": "https" },
  "Traefik (medido)": {
    "x-forwarded-for": "200.160.2.3",
    "x-forwarded-proto": "https",
    "x-forwarded-server": "coolify-proxy",
    "x-real-ip": "200.160.2.3",
  },
  "x-real-ip sozinho (Nginx Proxy Manager)": { "x-real-ip": "10.0.4.9" },
  "Nginx Proxy Manager com x-forwarded-for de dois saltos": {
    "x-forwarded-for": "10.0.4.3, 200.160.2.3",
    "x-real-ip": "200.160.2.3",
  },
  "x-forwarded-for com salto público no fim": { "x-forwarded-for": "10.0.4.3, 200.160.2.3" },
  forwarded: { forwarded: "for=200.160.2.3;proto=https" },
  "cf-connecting-ip": { "cf-connecting-ip": "200.160.2.3" },
  "x-forwarded-for que não é endereço": { "x-forwarded-for": "desconhecido" },
};

beforeEach(() => {
  limparMemoriaDeSessoes();
  clientesCriados = 0;
  arquivados.length = 0;
});

describe("rota global: o que atravessou a borda pública recebe 404 sem tocar o banco", () => {
  for (const [nome, cabecalhos] of Object.entries(PELA_BORDA)) {
    it(nome, async () => {
      const res = await postGlobal(pedido(cabecalhos));

      expect(res.status).toBe(404);
      expect(clientesCriados, "a recusa tocou o banco").toBe(0);
      expect(arquivados).toHaveLength(0);
    });
  }
});

describe("rota global: a rede interna segue o fluxo de hoje", () => {
  it.each([
    ["como o Next entrega a chamada do WAHA (medido)", INTERNA],
    ["IPv4 dentro de IPv6", { "x-forwarded-for": "::ffff:172.18.0.5", "x-forwarded-proto": "http" }],
    ["loopback", { "x-forwarded-for": "127.0.0.1" }],
    ["sem cabeçalho de encaminhamento nenhum", {}],
  ])("%s", async (_nome, cabecalhos) => {
    const res = await postGlobal(pedido(cabecalhos));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { accepted: true } });
    expect(arquivados).toHaveLength(1);
  });
});

describe("a rota por token é pública de propósito e não muda", () => {
  it("chegando pela borda (Traefik medido), ela atende", async () => {
    const res = await postPorToken(pedido(PELA_BORDA["Traefik (medido)"]!), {
      params: Promise.resolve({ token: "token-da-rota-de-producao-0001" }),
    });

    expect(res.status).toBe(200);
    expect(arquivados).toHaveLength(1);
  });
});

describe("chegouPelaBorda — a régua sozinha", () => {
  it("todos os casos de borda são borda e os internos não", () => {
    for (const cabecalhos of Object.values(PELA_BORDA)) {
      expect(chegouPelaBorda(new Headers(cabecalhos)), JSON.stringify(cabecalhos)).toBe(true);
    }
    expect(chegouPelaBorda(new Headers(INTERNA))).toBe(false);
    expect(chegouPelaBorda(new Headers())).toBe(false);
  });
});

// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";
import { DEFAULT_SENTRY_DSN } from "@/lib/sentry/dsn";
import {
  CAMINHO_DO_TUNEL,
  TETO_DO_ENVELOPE_EM_BYTES,
  TETO_POR_IP,
  recusaDoTunelDoSentry,
} from "@/lib/sentry/tunel";

/**
 * O túnel do Sentry (`tunnelRoute` em `next.config.ts`) é um rewrite do Next
 * que o `proxy.ts` alcança antes. Sem entrada em `PUBLIC_PATHS`, o envelope de
 * erro do navegador recebia 307 para `/login` e nunca chegava ao Sentry — com
 * ou sem sessão (issue #5091). O próprio comentário do Sentry no
 * `next.config.ts` avisa: a rota não pode casar com o middleware.
 */
// O proxy lê `env.SENTRY_DSN` no import: a instalação do teste aceitou o Sentry
// da comunidade, que é o que o `install.sh` grava no "sim".
vi.hoisted(() => {
  process.env.SENTRY_DSN = "comunidade";
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

const RAIZ = process.cwd();

// O que o SDK monta a partir do DSN da comunidade (`client/tunnelRoute.js`).
const QUERY_DA_COMUNIDADE = "o=4509908078559232&p=4509908083212288&r=us";
const DSN_SEM_REGIAO = "https://chave@o123.ingest.sentry.io/456";

let ipSequencial = 0;
function envelope(
  caminhoComQuery: string,
  { metodo = "POST", tamanho = "2", ip }: { metodo?: string; tamanho?: string | null; ip?: string } = {},
): NextRequest {
  const headers = new Headers({ "x-forwarded-for": ip ?? `203.0.113.${++ipSequencial}` });
  if (tamanho !== null) headers.set("content-length", tamanho);
  return new NextRequest(`https://crm.exemplo${caminhoComQuery}`, {
    method: metodo,
    headers,
    body: metodo === "GET" ? undefined : "{}",
  });
}

function rotaDoTunel(): string {
  const config = fs.readFileSync(path.join(RAIZ, "next.config.ts"), "utf8");
  const rota = config.match(/tunnelRoute:\s*"([^"]+)"/)?.[1];
  if (!rota) throw new Error("tunnelRoute não encontrado em next.config.ts");
  return rota;
}

describe("túnel do Sentry alcançável sem sessão (#5091)", () => {
  it("o caminho configurado em tunnelRoute é público", () => {
    // Amarrado ao valor do config: renomear o túnel sem mexer aqui reprova.
    expect(isPublicPath(rotaDoTunel())).toBe(true);
  });

  it("a guarda do proxy vigia o mesmo caminho do tunnelRoute", () => {
    expect(CAMINHO_DO_TUNEL).toBe(rotaDoTunel());
  });

  it("POST do envelope sem sessão não vira 3xx para /login", async () => {
    const { proxy } = await import("@/proxy");
    const r = await proxy(envelope(`${rotaDoTunel()}?${QUERY_DA_COMUNIDADE}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
  });

  it("a entrada é ancorada — não abre sub-path nem vizinho", () => {
    expect(isPublicPath("/monitoring/x")).toBe(false);
    expect(isPublicPath("/monitoringx")).toBe(false);
    expect(isPublicPath("/app/monitoring")).toBe(false);
  });
});

describe("guarda do túnel: só o projeto desta instalação, com teto", () => {
  const recusa = (req: NextRequest, dsn: string | undefined = "comunidade") =>
    recusaDoTunelDoSentry(req, dsn);

  it("a query do teste é a que o SDK monta do DSN da comunidade", () => {
    expect(DEFAULT_SENTRY_DSN).toContain("@o4509908078559232.ingest.us.sentry.io/4509908083212288");
  });

  it("o envelope do SDK desta instalação passa", async () => {
    expect(await recusa(envelope(`/monitoring?${QUERY_DA_COMUNIDADE}`))).toBeNull();
    expect(await recusa(envelope("/monitoring?o=123&p=456"), DSN_SEM_REGIAO)).toBeNull();
  });

  it("telemetria desligada ou DSN fora do Sentry SaaS: o túnel não existe (404)", async () => {
    for (const dsn of [undefined, "", "off", "https://k@sentry.exemplo.com/1"]) {
      const r = await recusaDoTunelDoSentry(envelope(`/monitoring?${QUERY_DA_COMUNIDADE}`), dsn);
      expect(r?.status).toBe(404);
    }
  });

  it("projeto, organização ou região que não são os do DSN: 404", async () => {
    for (const query of [
      "o=1&p=2&r=us",
      "o=4509908078559232&p=2&r=us",
      "o=1&p=4509908083212288&r=us",
      "o=4509908078559232&p=4509908083212288&r=de",
      "o=4509908078559232&p=4509908083212288",
    ]) {
      expect((await recusa(envelope(`/monitoring?${query}`)))?.status).toBe(404);
    }
    expect((await recusa(envelope("/monitoring?o=123&p=456&r=us"), DSN_SEM_REGIAO))?.status).toBe(404);
  });

  it("parâmetro repetido: 404", async () => {
    for (const extra of ["o=1", "p=2", "r=de"]) {
      const req = envelope(`/monitoring?${QUERY_DA_COMUNIDADE}&${extra}`);
      expect((await recusa(req))?.status).toBe(404);
    }
  });

  it("só POST (405)", async () => {
    const r = await recusa(envelope(`/monitoring?${QUERY_DA_COMUNIDADE}`, { metodo: "GET" }));
    expect(r?.status).toBe(405);
    expect(r?.headers.get("allow")).toBe("POST");
  });

  it("tamanho não declarado: 411; acima do teto: 413", async () => {
    const q = `/monitoring?${QUERY_DA_COMUNIDADE}`;
    expect((await recusa(envelope(q, { tamanho: null })))?.status).toBe(411);
    expect((await recusa(envelope(q, { tamanho: String(TETO_DO_ENVELOPE_EM_BYTES + 1) })))?.status).toBe(413);
    expect(await recusa(envelope(q, { tamanho: String(TETO_DO_ENVELOPE_EM_BYTES) }))).toBeNull();
  });

  it("rajada do mesmo IP: 429 depois do teto, outro IP segue", async () => {
    const q = `/monitoring?${QUERY_DA_COMUNIDADE}`;
    for (let i = 0; i < TETO_POR_IP; i++) {
      expect(await recusa(envelope(q, { ip: "198.51.100.7" }))).toBeNull();
    }
    const estourou = await recusa(envelope(q, { ip: "198.51.100.7" }));
    expect(estourou?.status).toBe(429);
    expect(estourou?.headers.get("retry-after")).not.toBeNull();
    expect(await recusa(envelope(q, { ip: "198.51.100.8" }))).toBeNull();
  });

  it("o proxy aplica a guarda antes da lista pública", async () => {
    const { proxy } = await import("@/proxy");
    const r = await proxy(envelope("/monitoring?o=1&p=2&r=us"));
    expect(r.status).toBe(404);
  });
});

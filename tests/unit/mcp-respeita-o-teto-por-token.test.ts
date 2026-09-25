import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TETO DE CHAMADAS NO MCP (Spec 11 §7).
 *
 * ─── Por que isto existe ────────────────────────────────────────────────────
 * O `/api/mcp` expõe 63 tools atrás de um Bearer e NÃO tem teto nenhum. A
 * Spec 11 §7 especifica os três desde 2026-05-05 — 60/min por token, 600/min
 * por organização, 30/min para escrita — e o `-32004` que a §2.3 mapeia não
 * existe em lugar nenhum do repo. A capacidade de contar já existe e roda em
 * seis pontos (`lib/ai/dispatcher/rate-limit.ts`); faltava ligá-la nesta porta.
 *
 * ─── O teto de ESCRITA é o que protege o número de WhatsApp ─────────────────
 * Trinta escritas por minuto inclui `crm_send_whatsapp_message`. O canal por
 * QR (WAHA) é cliente não-oficial: o WhatsApp restringe e bane por VOLUME, e
 * bane o número, não a sessão. Um agente externo em laço sem teto não derruba
 * o servidor — derruba o número da operação, e disso não há desfazer. Por isso
 * S7 cobra que a recusa aconteça ANTES do handler, não depois.
 *
 * ─── Por que o teto por ORGANIZAÇÃO não é redundante ────────────────────────
 * `api_tokens` (baseline.sql:1259) não tem limite de quantidade: quem quer
 * mais cota emite mais token. O teto por token, sozinho, é contornável por
 * quem já está dentro — o da organização é o que fecha isso.
 */
import { verificarTetoMcp } from "@/lib/mcp/rate-limit";
import type { McpAuthResult } from "@/lib/mcp/auth";

const chamadas: { bucket: string; limit: number; windowSec: number }[] = [];
/** bucket -> quantas chamadas já foram contadas nesta janela (dublê). */
let contador: Record<string, number> = {};

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (bucket: string, limit: number, windowSec: number) => {
    chamadas.push({ bucket, limit, windowSec });
    const count = (contador[bucket] ?? 0) + 1;
    contador[bucket] = count;
    return { allowed: count <= limit, count, limit, window_sec: windowSec };
  },
}));

function auth(over: Partial<McpAuthResult> = {}): McpAuthResult {
  return {
    organizationId: "org-A",
    role: "manager",
    actor: { type: "api_token", id: "tok-1" } as McpAuthResult["actor"],
    apiTokenId: "tok-1",
    scopes: ["mcp:read", "mcp:write"],
    ...over,
  };
}

/** Consome `n` chamadas de um bucket sem passar pelo código sob teste. */
function jaConsumiu(bucket: string, n: number): void {
  contador[bucket] = n;
}

beforeEach(() => {
  chamadas.length = 0;
  contador = {};
});

describe("teto de chamadas do MCP", () => {
  it("S1 — recusa a chamada que passa do teto por token", async () => {
    jaConsumiu("mcp:tok:tok-1", 60);
    await expect(verificarTetoMcp(auth(), "read")).rejects.toMatchObject({
      mcpCode: -32004,
      httpStatus: 429,
    });
  });

  it("S1b — a chamada dentro do teto passa", async () => {
    await expect(verificarTetoMcp(auth(), "read")).resolves.toBeUndefined();
  });

  it("S2 — leitura não consome a cota de escrita", async () => {
    jaConsumiu("mcp:w:tok-1", 30);
    // Escrita esgotada, mas quem chega é LEITURA: passa.
    await expect(verificarTetoMcp(auth(), "read")).resolves.toBeUndefined();
    expect(chamadas.some((c) => c.bucket === "mcp:w:tok-1")).toBe(false);
  });

  it("S3 — escrita tem teto próprio, mais apertado que o do token", async () => {
    jaConsumiu("mcp:w:tok-1", 30);
    await expect(verificarTetoMcp(auth(), "write")).rejects.toMatchObject({
      mcpCode: -32004,
    });
    // O teto do token (60) estava livre — quem barrou foi o de escrita.
    expect(contador["mcp:tok:tok-1"] ?? 0).toBeLessThanOrEqual(1);
  });

  it("S4 — o teto por organização é agregado entre tokens", async () => {
    jaConsumiu("mcp:org:org-A", 600);
    // Token NOVO, cota de token zerada — e ainda assim recusa.
    await expect(
      verificarTetoMcp(auth({ apiTokenId: "tok-2" }), "read"),
    ).rejects.toMatchObject({ mcpCode: -32004 });
  });

  it("S5 — uma organização no teto não afeta a outra", async () => {
    jaConsumiu("mcp:org:org-A", 600);
    await expect(
      verificarTetoMcp(auth({ organizationId: "org-B", apiTokenId: "tok-9" }), "read"),
    ).resolves.toBeUndefined();
  });

  it("usa os números da Spec 11 §7 — 60 por token, 600 por org, 30 por escrita", async () => {
    await verificarTetoMcp(auth(), "write");
    const porBucket = Object.fromEntries(chamadas.map((c) => [c.bucket, c.limit]));
    expect(porBucket["mcp:tok:tok-1"]).toBe(60);
    expect(porBucket["mcp:org:org-A"]).toBe(600);
    expect(porBucket["mcp:w:tok-1"]).toBe(30);
    expect(chamadas.every((c) => c.windowSec === 60)).toBe(true);
  });

  it("S6 — a recusa diz quando tentar de novo", async () => {
    jaConsumiu("mcp:tok:tok-1", 60);
    await expect(verificarTetoMcp(auth(), "read")).rejects.toThrow(/60s|minuto/i);
  });

  it("handoff conta como leitura — não consome a cota de escrita", async () => {
    jaConsumiu("mcp:w:tok-1", 30);
    await expect(verificarTetoMcp(auth(), "handoff")).resolves.toBeUndefined();
  });
});

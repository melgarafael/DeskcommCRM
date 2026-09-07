import { z } from "zod";

/** Fatos do endpoint server/version, sem credenciais nem corpo livre de erro. */
const serverIdentity = z.object({
  version: z.string().max(100).optional(),
  engine: z.string().max(100).optional(),
  tier: z.string().max(100).optional(),
});

export interface WahaServerCapabilities {
  version: string | null;
  engine: string | null;
  tier: string | null;
  multipleSessions: "supported" | "unsupported" | "unknown";
}

export function describeWahaServer(input: unknown): WahaServerCapabilities {
  const parsed = serverIdentity.safeParse(input);
  const facts = parsed.success ? parsed.data : {};
  return {
    version: facts.version ?? null,
    engine: facts.engine ?? null,
    tier: facts.tier ?? null,
    // Prova local qa-waha-core: somente duas SCAN_QR_CODE, sem pairing/envio.
    // Nenhuma combinação não medida recebe bloqueio por tier ou idade.
    multipleSessions: facts.version === "2026.7.2" && facts.engine === "NOWEB" ? "supported" : "unknown",
  };
}

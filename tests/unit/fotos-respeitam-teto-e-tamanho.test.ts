import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Achados da revisão adversarial do #1502.
const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("fotos do catálogo", () => {
  it("o send_message só manda as fotos que cabem no teto de mensagens do turno", () => {
    const turno = ler("lib/agent-engine/agent/inbound-turn.ts");
    const chamada = turno.slice(0, turno.indexOf("return enviarComFotos("));
    const recorte = chamada.slice(chamada.lastIndexOf("send: (finalBody"));
    // O teto é medido antes de CADA foto (`restantes`), depois do texto — que,
    // acima do teto de legenda, sai à parte e também gasta o teto. O
    // comportamento é provado em lib/agent-engine/agent/fotos-do-produto.test.ts.
    const envio = turno.slice(turno.indexOf("return enviarComFotos("));
    expect(envio.slice(0, envio.indexOf("});"))).toMatch(/restantes:\s*\(\)\s*=>\s*maxSendsPerTurn\s*-\s*seq/);
    expect(recorte).not.toMatch(/fotosDoProduto\.slice\(0,/);
  });

  it("a rota de upload recusa pelo Content-Length antes de ler o corpo", () => {
    const rota = ler("app/api/v1/products/[id]/fotos/route.ts");
    const precheck = rota.indexOf('req.headers.get("content-length")');
    const leitura = rota.indexOf("req.formData()");
    expect(precheck).toBeGreaterThan(-1);
    expect(precheck).toBeLessThan(leitura);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarTextoNosFollowups, inboundEhDestaPergunta, textoDoPayloadInbound } from "./aplicar-inbound";

describe("textoDoPayloadInbound", () => {
  it("lê body_preview do evento emitido pelo banco", () => {
    expect(textoDoPayloadInbound({ body_preview: "  Ian  ", contact_id: "x" })).toBe("Ian");
  });

  it("vazio quando o payload não traz texto", () => {
    expect(textoDoPayloadInbound({ contact_id: "x" })).toBe("");
  });

  it("lê body cru quando não há preview", () => {
    expect(textoDoPayloadInbound({ body: "sim" })).toBe("sim");
  });
});

describe("inboundEhDestaPergunta", () => {
  it("o SIM da pergunta anterior não conta na espera seguinte", () => {
    expect(inboundEhDestaPergunta("2026-08-25T18:11:00.000Z", "2026-08-25T19:18:00.000Z")).toBe(false);
  });

  it("a resposta depois da pergunta conta", () => {
    expect(inboundEhDestaPergunta("2026-08-25T19:25:00.000Z", "2026-08-25T19:19:00.000Z")).toBe(true);
  });
});

describe("aplicarTextoNosFollowups — uma mensagem, uma pergunta", () => {
  const fonte = () => readFileSync(join(process.cwd(), "lib/followup/aplicar-inbound.ts"), "utf8");

  it("filtra waiting_reply com inboundEhDestaPergunta (não reaproveita texto velho)", () => {
    const src = fonte();
    expect(src).toMatch(/inboundEhDestaPergunta\(enviadaEm, enrollment\.updated_at\)/);
    expect(src).toMatch(/if \(!enviadaEm \|\| !inboundEhDestaPergunta/);
  });

  it("não tem 2ª passada cega fora do loop (regressão: confirm + endereço no mesmo request)", () => {
    const src = fonte();
    // Uma chamada só, dentro do for — a 2ª passada solta reaplicava o texto
    // que enfileirou a confirmação de nome como se fosse o SIM.
    const chamadas = src.match(/await aplicarTextoAosEnrollmentsEmEspera\(/g) ?? [];
    expect(chamadas.length).toBe(1);
    expect(src).toMatch(/for \(let i = 0; i < 6; i\+\+\) \{[\s\S]*aplicarTextoAosEnrollmentsEmEspera/);
  });
});

/**
 * Banco de mentira que só anota quais tabelas foram tocadas. Toda leitura volta
 * vazia, exceto `organizations`, que devolve o status pedido.
 */
function bancoQueAnota(statusDaOrg: string): { admin: SupabaseClient; tabelas: string[] } {
  const tabelas: string[] = [];
  const admin = {
    from(tabela: string) {
      tabelas.push(tabela);
      const resposta =
        tabela === "organizations" ? { data: { status: statusDaOrg }, error: null } : { data: [], error: null };
      // Qualquer filtro encadeia; `maybeSingle` e o `await` direto resolvem.
      const encadeia: object = new Proxy(
        {},
        {
          get(_alvo, metodo) {
            if (metodo === "then") {
              return (ok: (r: unknown) => unknown) => Promise.resolve(resposta).then(ok);
            }
            if (metodo === "maybeSingle") {
              return async () => (tabela === "organizations" ? resposta : { data: null, error: null });
            }
            return () => encadeia;
          },
        },
      );
      return encadeia;
    },
  } as unknown as SupabaseClient;
  return { admin, tabelas };
}

describe("aplicarTextoNosFollowups — org parada", () => {
  const sinal = { organizationId: "org-1", contactId: "contato-1", texto: "sim" };

  it("org suspensa: lê só o status da org — não enfileira, não avança e não envia", async () => {
    const { admin, tabelas } = bancoQueAnota("suspended");
    await aplicarTextoNosFollowups(admin, sinal);
    expect(tabelas).toEqual(["organizations"]);
  });

  it("controle: org operante segue para os follow-ups do contato", async () => {
    const { admin, tabelas } = bancoQueAnota("active");
    await aplicarTextoNosFollowups(admin, sinal);
    expect(tabelas).toContain("followup_enrollments");
  });
});

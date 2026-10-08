import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TODA PORTA QUE CRIA OU RESSUSCITA CANAL TRADUZ O LIMITE DO PLANO.
 *
 * O gatilho de canais (spec cobrança §5) recusa com PT402 em cinco caminhos que
 * chegam a seis rotas. Uma rota esquecida devolve 500 "internal_error" onde o
 * dono do negócio devia ler "seu plano permite N números" — e o teste de uma rota
 * não enxerga a outra. Por isso a lista é literal: rota nova que conecta canal
 * entra aqui.
 */
const RAIZ = process.cwd();
const ler = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");

const ROTAS = [
  "app/api/v1/channel-sessions/route.ts",
  "app/api/v1/onboarding/whatsapp/session/route.ts",
  "app/api/v1/channels/official/route.ts",
  "app/api/v1/channels/partner/route.ts",
  "app/api/v1/channels/social/route.ts",
  "app/api/v1/channels/graph-partner/route.ts",
] as const;

/** Onde o erro do banco era EMBRULHADO antes de chegar à rota — e o número se perdia. */
const EMBRULHAVAM = ["lib/channels/connect-waha.ts", "lib/channels/social/store.ts"] as const;

describe("o limite de números do plano chega à tela por toda porta", () => {
  it.each(ROTAS)("%s traduz a recusa do gatilho", (rota) => {
    expect(ler(rota)).toMatch(/traduzirLimiteDoPlano\(/);
  });

  it.each(EMBRULHAVAM)("%s devolve a recusa do limite CRUA", (arquivo) => {
    expect(ler(arquivo)).toMatch(/if \(lerLimiteEstourado\(error\)\) throw error;/);
  });
});

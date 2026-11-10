/**
 * O AVISO AO LEAD EM TURCO — a mesma régua de `aviso-ao-lead.test.ts`.
 *
 * O cliente lê o aviso no idioma da ORGANIZAÇÃO. Uma empresa turca grava o
 * idioma como `tr` ou, vindo de outro caminho, como `tr-TR`: as duas formas
 * têm de cair nas frases em turco, e não no português.
 */
import { describe, expect, it } from "vitest";

import { textoDoAviso, type MotivoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import type { QuemPodeAssumir } from "@/lib/escalacao/disponibilidade";
import { normalizeCopy } from "@/lib/agent-engine/spinning/engine";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

const MOTIVOS: MotivoDoAviso[] = ["pediu_humano", "suspeita_de_opt_out", "orcamento_de_ia", "outro"];
const ESTADOS: Array<{ rotulo: string; quem: QuemPodeAssumir | null }> = [
  { rotulo: "leitura falhou", quem: null },
  { rotulo: "instalação fresca", quem: { disponiveis: 0, total: 0 } },
  { rotulo: "fora de expediente", quem: { disponiveis: 0, total: 3 } },
  { rotulo: "com gente livre", quem: { disponiveis: 2, total: 3 } },
];
const CASOS = MOTIVOS.flatMap((motivo) => ESTADOS.map((estado) => ({ motivo, ...estado })));
const LETRAS_TURCAS = /[çğıöşüÇĞİÖŞÜ]/;
const PALAVRAS_EM_PORTUGUES = /\b(você|seu|sua|equipe|atendente|não|já|ninguém|aguarde)\b/i;

describe("o aviso sai em turco para organização em turco", () => {
  it.each(CASOS)("$motivo / $rotulo: turco de verdade, e não o português", ({ motivo, quem }) => {
    const tr = textoDoAviso(motivo, quem, "lead-1", "tr");
    expect(tr).not.toBe(textoDoAviso(motivo, quem, "lead-1", "pt-BR"));
    expect(tr).toMatch(LETRAS_TURCAS);
    expect(tr).not.toMatch(PALAVRAS_EM_PORTUGUES);
    expect(tr).not.toContain("—");
  });

  it.each(CASOS)("$motivo / $rotulo: `tr-TR` cai no mesmo turco que `tr`", ({ motivo, quem }) => {
    expect(textoDoAviso(motivo, quem, "lead-1", "tr-TR")).toBe(textoDoAviso(motivo, quem, "lead-1", "tr"));
  });

  it.each(CASOS)("$motivo / $rotulo: ao menos 3 redações entre 50 leads", ({ motivo, quem }) => {
    const textos = new Set(Array.from({ length: 50 }, (_, i) => textoDoAviso(motivo, quem, `lead-${i}`, "tr")));
    expect(textos.size).toBeGreaterThanOrEqual(3);
  });

  it("não cabe na isenção do spinning, como o português e o espanhol (o desarme segue necessário)", () => {
    for (const motivo of MOTIVOS) {
      const t = normalizeCopy(textoDoAviso(motivo, null, "lead-1", "tr"));
      expect(t.length, motivo).toBeGreaterThan(SPINNING_DEFAULTS.allowlistMaxLength);
    }
  });

  it("o estado da equipe muda o fecho em turco", () => {
    const fechos = new Set(ESTADOS.slice(1).map(({ quem }) => textoDoAviso("outro", quem, "lead-1", "tr")));
    expect(fechos.size).toBe(3);
  });

  it("quem pediu para parar não recebe convite para esperar", () => {
    for (const { quem, rotulo } of ESTADOS) {
      const t = textoDoAviso("suspeita_de_opt_out", quem, "lead-1", "tr");
      expect(t, rotulo).toContain("Talebinizi onaylaması için ekibimizden birine ilettim.");
      expect(t, rotulo).not.toMatch(/bekle|sıra/i);
    }
  });
});

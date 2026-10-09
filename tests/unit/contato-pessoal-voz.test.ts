import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  deveRecusarChamadaPessoal,
  END_REASON_CONTACT_PERSONAL,
} from "@/workers/voice-agent/recusa-bloqueado";

/**
 * LIGAÇÃO RECUSADA E REGISTRADA (spec 21, etapa 14 — critério 11).
 *
 * Chamada de pessoal recebe o mesmo tratamento de bloqueado: gravada
 * (escondida), desligada, sem IA, sem negócio, sem tocar, sem alerta. A de
 * pessoal fica ESCONDIDA do histórico; a de bloqueado aparece como recusada.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - `deveRecusarChamadaPessoal` virar `false` sempre: o caso "só true recusa"
 *   cai — e no fio (`fio-recusa-pessoal.test.ts`) a IA atenderia.
 * - Tirar o bloco de pessoal do worker: o fio acusa (`continueDialplan`
 *   chamado para pessoal).
 * - Tirar o `.not` do GET de chamadas ou do histórico de voz: a escondida
 *   volta a aparecer (provado em `contato-pessoal-mcp.test.ts`, cercas).
 * Linha para reverter: `workers/voice-agent/recusa-bloqueado.ts`,
 * `workers/voice-agent/index.ts`, `lib/voip/resolve-caller.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a decisão pura de pessoal", () => {
  it("só true positivo recusa (fail-open: null segue como hoje)", () => {
    expect(deveRecusarChamadaPessoal(true)).toBe(true);
    expect(deveRecusarChamadaPessoal(false)).toBe(false);
    expect(deveRecusarChamadaPessoal(null)).toBe(false);
    expect(deveRecusarChamadaPessoal(undefined)).toBe(false);
  });

  it("o motivo gravado é próprio, nunca o de bloqueio", () => {
    expect(END_REASON_CONTACT_PERSONAL).toBe("contato_pessoal");
  });
});

describe("o fio usa a decisão (não é função órfã)", () => {
  it("o worker chama deveRecusarChamadaPessoal antes do dialplan", () => {
    const src = semComentarios(fonte("workers", "voice-agent", "index.ts"));
    expect(src).toMatch(/deveRecusarChamadaPessoal\(contatoDeQuemLiga\?\.is_personal\)/);
    expect(src).toMatch(/END_REASON_CONTACT_PERSONAL/);
  });

  it("o contato de quem liga carrega is_personal do lookup", () => {
    const src = semComentarios(fonte("lib", "voip", "resolve-caller.ts"));
    expect(src).toMatch(/is_personal/);
  });
});

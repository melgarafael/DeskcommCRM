/**
 * A VOZ NÃO ATENDE EM NOME DE ORGANIZAÇÃO PARADA.
 *
 * `workers/voice-agent/index.ts` chama `main()` ao ser importado (abre socket e
 * conecta no Asterisk), então o teste lê o fonte — o mesmo molde de
 * `prompt-editado-e-o-que-o-motor-executa.test.ts`. O que se prende é a ORDEM:
 * o status da org é lido e a conexão encerrada ANTES de montar o agente (que
 * abre a sessão paga na OpenAI).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FONTE = readFileSync(join(process.cwd(), "workers/voice-agent/index.ts"), "utf8");

function corpoDe(nome: string): string {
  const inicio = FONTE.indexOf(`async function ${nome}(`);
  expect(inicio, `função ${nome} sumiu do worker de voz`).toBeGreaterThan(-1);
  const fim = FONTE.indexOf("\nfunction ", inicio + 1);
  return FONTE.slice(inicio, fim === -1 ? undefined : fim);
}

describe("voz × organização parada", () => {
  it("importa a régua única", () => {
    expect(FONTE).toMatch(/import \{ ehOperante \} from "@\/lib\/organizacao\/operante";/);
  });

  it("lê o status da org e encerra ANTES de montar o agente de voz", () => {
    const corpo = corpoDe("handleAudioSocketConnection");
    expect(corpo).toMatch(/\.from\("organizations"\)\s*\.select\("status"\)/);
    const veto = corpo.indexOf("ehOperante(");
    const agente = corpo.indexOf("getActiveVoiceAgent(");
    expect(veto).toBeGreaterThan(-1);
    expect(agente).toBeGreaterThan(veto);
    expect(corpo.slice(veto, agente)).toMatch(/voz_org_suspensa[\s\S]{0,200}socket\.end\(\);\s*return;/);
  });
});

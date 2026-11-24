/**
 * A CONVERSA DEVOLVIDA À IA NÃO VOLTA PARA O RODÍZIO SÓ PORQUE O CLIENTE ESCREVEU.
 *
 * D6 numa instalação de teste (2026-11-20): a pessoa clicou em "Devolver ao
 * automático", o cliente pediu um orçamento, a IA respondeu — e 30 s depois a
 * distribuição entregou a conversa de novo ao técnico, sem ninguém pedir gente.
 *
 * Prova, sem banco:
 *   1. a regra pura (`esperaPelaRetomada`) nos dois sentidos: guarda só com marca,
 *      sem passagem nova e com IA no ar; distribui em qualquer outro caso;
 *   2. a leitura da marca não confia no jsonb;
 *   3. a FIAÇÃO no worker: a regra é consultada só nos modos automáticos, depois
 *      da espera da #3966, nunca para o destino padrão do número nem para conversa
 *      com dono, e o pedido é REAGENDADO (não descartado) com o motivo próprio.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHAVE_DA_RETOMADA_DA_IA,
  INTERVALO_DA_RETOMADA_MS,
  esperaPelaRetomada,
  lerMarcaDeRetomada,
  marcaDeRetomada,
} from "@/lib/routing/retomada-da-ia";

const AGORA = new Date("2026-11-20T20:31:30Z");
const comMarca = {
  [CHAVE_DA_RETOMADA_DA_IA]: marcaDeRetomada("pessoa", new Date("2026-11-20T20:30:19Z")),
};

describe("esperaPelaRetomada — a regra pura", () => {
  it("⭐ marca + sem passagem nova + IA no ar ⇒ guarda o pedido e o reavalia no intervalo", () => {
    const ate = esperaPelaRetomada({
      metadata: comMarca,
      lastHandoffAt: null,
      iaAtendendo: true,
      agora: AGORA,
    });
    expect(ate).toBe(new Date(AGORA.getTime() + INTERVALO_DA_RETOMADA_MS).toISOString());
  });

  it("sem a marca (conversa nunca devolvida): distribui como sempre — o rodízio não muda", () => {
    expect(
      esperaPelaRetomada({ metadata: {}, lastHandoffAt: null, iaAtendendo: true, agora: AGORA }),
    ).toBeNull();
    expect(
      esperaPelaRetomada({ metadata: null, lastHandoffAt: null, iaAtendendo: true, agora: AGORA }),
    ).toBeNull();
  });

  it("⭐ a IA passou para humano de novo (`last_handoff_at`): necessidade real — distribui", () => {
    expect(
      esperaPelaRetomada({
        metadata: comMarca,
        lastHandoffAt: "2026-11-20T20:40:00Z",
        iaAtendendo: true,
        agora: AGORA,
      }),
    ).toBeNull();
  });

  it("sem IA no ar (pausada, calada, número sem agente): distribui — falha aberta, ninguém fica sem atendimento", () => {
    expect(
      esperaPelaRetomada({
        metadata: comMarca,
        lastHandoffAt: null,
        iaAtendendo: false,
        agora: AGORA,
      }),
    ).toBeNull();
  });

  it("a marca vale por pessoa OU automática (o cron também devolve à IA)", () => {
    const auto = { [CHAVE_DA_RETOMADA_DA_IA]: marcaDeRetomada("automatica", AGORA) };
    expect(
      esperaPelaRetomada({ metadata: auto, lastHandoffAt: null, iaAtendendo: true, agora: AGORA }),
    ).not.toBeNull();
  });
});

describe("lerMarcaDeRetomada — não confia no jsonb", () => {
  it.each([
    ["sem metadata", null],
    ["metadata texto", "x"],
    ["sem a chave", { outra: 1 }],
    ["chave texto", { ia_retomada: "sim" }],
    ["sem data", { ia_retomada: { por: "pessoa" } }],
    ["data lixo", { ia_retomada: { em: "ontem", por: "pessoa" } }],
    ["autor desconhecido", { ia_retomada: { em: "2026-11-20T20:30:19Z", por: "robo" } }],
  ])("%s ⇒ sem marca", (_caso, metadata) => {
    expect(lerMarcaDeRetomada(metadata)).toBeNull();
  });

  it("a marca bem formada é lida como foi gravada", () => {
    expect(lerMarcaDeRetomada(comMarca)).toEqual({ em: "2026-11-20T20:30:19.000Z", por: "pessoa" });
  });
});

describe("a fiação no routing-worker", () => {
  const src = readFileSync(join(process.cwd(), "lib/routing/worker.ts"), "utf8");
  const inicio = src.indexOf("lerMarcaDeRetomada((conv as { metadata?: unknown }).metadata)");
  const bloco = src.slice(src.lastIndexOf("if (", inicio), src.indexOf("let eligibles", inicio));

  it("a regra é consultada, e só depois da espera da #3966", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(src.indexOf("const minutosDeEspera")).toBeLessThan(inicio);
    expect(bloco).toContain("esperaPelaIAAte === null");
  });

  it("⭐ só nos modos automáticos, nunca para o destino padrão do número, conversa com dono ou caso que barra", () => {
    expect(bloco).toMatch(/efetivo\.mode === "round_robin" \|\| efetivo\.mode === "load"/);
    expect(bloco).toContain("!viaDestinoPadrao");
    expect(bloco).toContain("!alreadyAssigned");
    expect(bloco).toContain("!motivoDoCaso");
  });

  it('a pergunta "há IA no ar?" é a do motor (`lerQualificacaoDaIA`), não uma régua nova', () => {
    expect(bloco).toContain("await lerQualificacaoDaIA(");
    expect(bloco).toContain("esperaPelaRetomada(");
  });

  it("⭐ o pedido é REAGENDADO com motivo próprio — descartar deixaria a passagem sem ninguém", () => {
    expect(bloco).toContain('motivoDaEspera = "ia_retomada"');
    const caso = src.slice(src.indexOf('case "wait_ai"'), src.indexOf('case "wait_ai"') + 900);
    expect(caso).toContain("requeueEvent(");
    expect(caso).toContain("{ reason: motivoDaEspera }");
    expect(caso).not.toContain("markDone(");
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sondaPassa } from "@/scripts/lib/avaliacao-de-tokens";
import {
  AGORA,
  contextoDaConversa,
  CORPUS_C,
  CORPUS_F5,
  CORPUS_G,
  PERSONAS,
  SONDAS_F5,
  uuidDe,
} from "@/scripts/lib/corpus-de-avaliacao";
import { abertura, pedidosDoFechamento } from "@/scripts/lib/pedidos-de-avaliacao";

/**
 * O corpus das avaliações C, F5 e G cobre o que põe cada mudança em risco, nos
 * tamanhos que os desenhos pedem — e cada sonda acerta a própria resposta de
 * referência e erra a resposta errada. Uma sonda que reprova a resposta certa
 * mediria o ruído da lista, não o formato do histórico.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("tamanhos e identidade", () => {
  it("C tem 30, F5 ≥ 60, G ≥ 150 conversas, com ids únicos", () => {
    expect(CORPUS_C).toHaveLength(30);
    expect(CORPUS_F5.length).toBeGreaterThanOrEqual(60);
    expect(CORPUS_G.length).toBeGreaterThanOrEqual(150);
    expect(new Set(CORPUS_G.map((c) => c.id)).size).toBe(CORPUS_G.length);
  });

  it("o id do contato de cada conversa é um uuid v4 estável", () => {
    expect(uuidDe("C01:contato")).toMatch(UUID_V4);
    expect(uuidDe("C01:contato")).toBe(uuidDe("C01:contato"));
    expect(contextoDaConversa(CORPUS_C[0]!).context.lead_id).toMatch(UUID_V4);
  });

  it("nenhum e-mail fora de exemplo.com.br/exemplo.com e o CPF é o de teste (o corpus é inventado)", () => {
    const tudo = JSON.stringify(CORPUS_G);
    const emails = tudo.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g) ?? [];
    expect(emails.filter((e) => !/@exemplo\.com(\.br)?$/i.test(e) && e !== "camila.r@gmail")).toEqual([]);
    expect((tudo.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/g) ?? []).every((cpf) => cpf === "123.456.789-09")).toBe(true);
  });
});

describe("o calendário do corpus é o do AGORA", () => {
  it("todo 'dia da semana + DD/MM' cai nesse dia no ano de AGORA", () => {
    // Um modelo que nota a data diverge do roteiro pensado quando "sexta 07/11" é um
    // sábado — e a resposta de referência fica errada contra o próprio histórico.
    const ano = Number(AGORA.slice(0, 4));
    const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    const texto = JSON.stringify([...CORPUS_F5, ...CORPUS_G]);
    const pares = [
      ...texto.matchAll(/(domingo|segunda|terça|quarta|quinta|sexta|sábado)(?:-feira)?[^0-9"\\]{0,12}?(\d{1,2})\/(\d{1,2})/gi),
    ];
    // Controle positivo: sem pares, a varredura aprovaria um corpus inteiro errado.
    expect(pares.length, "a varredura não achou par nenhum — ENSINE ESTE TESTE").toBeGreaterThan(30);
    const errados = pares
      .filter(([, dia = "", dd, mm]) => DIAS[new Date(Date.UTC(ano, Number(mm) - 1, Number(dd))).getUTCDay()] !== dia.toLowerCase())
      .map(([trecho]) => trecho);
    expect(errados).toEqual([]);
  });
});

describe("C põe uuid, data e e-mail em risco", () => {
  it("toda conversa declara o risco, e cada um aparece em ≥10", () => {
    expect(CORPUS_C.every((c) => (c.risco ?? []).length > 0)).toBe(true);
    for (const r of ["uuid", "data", "email"] as const) expect(CORPUS_C.filter((c) => c.risco?.includes(r)).length, r).toBeGreaterThanOrEqual(10);
  });

  it("os quatro agentes de avaliação têm ferramenta com uuid ou data no catálogo", () => {
    for (const p of Object.values(PERSONAS)) expect(p.ferramentas.some((t) => /appointment|slots|lead|contact/.test(t)), p.id).toBe(true);
  });
});

describe("as sondas do F5", () => {
  it("três tipos, dez de cada", () => {
    expect(SONDAS_F5).toHaveLength(30);
    for (const tipo of ["quem_disse", "horario", "grupo"] as const)
      expect(SONDAS_F5.filter((c) => c.sonda?.tipo === tipo), tipo).toHaveLength(10);
  });

  it("cada sonda aprova a própria resposta de referência", () => {
    const falham = SONDAS_F5.filter((c) => c.sonda !== undefined && !sondaPassa(c.sonda, c.resposta)).map((c) => c.id);
    expect(falham).toEqual([]);
  });

  it("e reprova a resposta que caiu na armadilha", () => {
    const erradas: Record<string, string> = {
      "S-QD1": "O endereço é Av. Brasil, 900.",
      "S-HR2": "Ainda vale sim, pode usar!",
      "S-HR5": "Sua limpeza é amanhã às 15h.",
      "S-QD7": "O frete para Campinas é R$ 90.",
      "S-HR7": "Isso, sua avaliação é amanhã às 11h.",
      "S-HR9": "Sim, ainda dá tempo de pedir o reembolso pela garantia!",
      "S-GR8": "O Hugo pediu às 8h.",
      "S-GR3": "A Rita escolheu o bege.",
    };
    for (const [id, errada] of Object.entries(erradas)) {
      const c = SONDAS_F5.find((x) => x.id === id);
      expect(c?.sonda, id).toBeDefined();
      if (c?.sonda !== undefined) expect(sondaPassa(c.sonda, [errada]), id).toBe(false);
    }
  });

  it("o grupo leva o remetente da mensagem atual até a abertura", () => {
    const c = SONDAS_F5.find((x) => x.id === "S-GR1");
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(contextoDaConversa(c).context.messages.at(-1)?.sender?.name).toBe("Pedro Rocha");
    expect(abertura(c, "linhas")).toContain("Pedro Rocha");
  });

  it("a abertura em linhas é menor que em JSON no corpus inteiro (é o ganho que o F5 compra)", () => {
    const tamanho = (f: "json" | "linhas") => CORPUS_F5.reduce((s, c) => s + abertura(c, f).length, 0);
    expect(tamanho("linhas")).toBeLessThan(tamanho("json"));
  });
});

describe("o G alcança os mínimos do desenho por construção", () => {
  const pedidos = pedidosDoFechamento(CORPUS_G);

  it("todo pedido passa no esquema do roteiro do fechamento, com o `## Agora`", () => {
    expect(pedidos).toHaveLength(CORPUS_G.length);
    expect(pedidos.every((p) => p.mensagens[0]?.content.includes("## Agora"))).toBe(true);
  });

  // O plano roda o corpus 2× (K=2): 50 com resumo por rodada dão os ≥100 turnos do desenho.
  it("≥50 com resumo anterior por rodada, ≥50 respostas com prazo explícito, os 4 agentes", () => {
    expect(pedidos.filter((p) => p.anterior !== null).length).toBeGreaterThanOrEqual(50);
    const comPrazo = CORPUS_G.filter((c) => /(\d{1,2}h|\d{2}\/\d{2}|amanhã|hoje até|até as|mañana|em até)/i.test(c.resposta.join(" ")));
    expect(comPrazo.length).toBeGreaterThanOrEqual(50);
    expect(new Set(CORPUS_G.map((c) => c.persona)).size).toBe(4);
  });
});

describe("o plano roda sem rede e sem banco", () => {
  const RAIZ = join(__dirname, "..", "..");
  const TSX_CLI = join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");
  const DIR = mkdtempSync(join(tmpdir(), "avaliar-tokens-"));
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));
  const precos = join(DIR, "precos.json");
  const preco = (id: string) => ({ id, pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002", input_cache_write_1h: "0.000004" } });
  writeFileSync(precos, JSON.stringify({ data: [preco("anthropic/claude-sonnet-5"), preco("anthropic/claude-haiku-5.5")] }));

  for (const avaliacao of ["C", "F5", "G"]) it(`plano ${avaliacao} imprime a tabela e o total`, { timeout: 200_000 }, () => {
    const r = spawnSync(
      process.execPath,
      [TSX_CLI, join("scripts", "avaliar-tokens.ts"), "plano", "--avaliacao", avaliacao, "--precos", precos, "--modelos", "anthropic:claude-sonnet-5"],
      // O setup do vitest já pôs placeholders do Supabase neste processo: o motor
      // carrega, e nada sai para a rede (o plano não abre banco nem provedor).
      { cwd: RAIZ, env: process.env, encoding: "utf8", timeout: 180_000 },
    );
    const saida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(r.status, saida).toBe(0);
    expect(saida).toMatch(/^modelo\tbraço\texecuções/m);
    const total = /^TOTAL\t.*\t([\d.]+)\t([\d.]+)\t([\d.]+)$/m.exec(saida);
    expect(total, saida).not.toBeNull();
    // Cache dos Claude ligado nunca sai mais caro que desligado.
    expect(Number(total?.[1])).toBeLessThanOrEqual(Number(total?.[2]));
    expect(Number(total?.[1])).toBeGreaterThan(0);
  });
});

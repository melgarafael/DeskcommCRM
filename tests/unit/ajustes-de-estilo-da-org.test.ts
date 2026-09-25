// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AJUSTES_DESLIGADOS,
  aplicarAjustesDeEstilo,
  lerAjustesDeEstiloDaOrg,
  removerTravessaoLongo,
} from "@/lib/agent-engine/guardrails/ajustes-de-estilo-da-org";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

describe("ajustes de estilo da organização", () => {
  it("nasce desligado e não muda o texto", () => {
    const texto = "Olá — posso te ajudar — agora";
    expect(aplicarAjustesDeEstilo(texto, AJUSTES_DESLIGADOS)).toBe(texto);
  });

  it("troca travessão longo no meio por vírgula + espaço", () => {
    expect(removerTravessaoLongo("Olá — posso te ajudar")).toBe("Olá, posso te ajudar");
    expect(removerTravessaoLongo("Olá—posso te ajudar")).toBe("Olá, posso te ajudar");
    expect(removerTravessaoLongo("A — B — C")).toBe("A, B, C");
  });

  it("não deixa vírgula órfã quando o travessão está na borda", () => {
    expect(removerTravessaoLongo("— Olá")).toBe("Olá");
    expect(removerTravessaoLongo("Até amanhã —")).toBe("Até amanhã");
  });

  it("preserva quebras de linha e trata bordas de cada linha", () => {
    expect(removerTravessaoLongo("Primeiro\n— Segundo")).toBe("Primeiro\nSegundo");
    expect(removerTravessaoLongo("Primeiro —\nSegundo")).toBe("Primeiro\nSegundo");
    expect(removerTravessaoLongo("Primeiro\nA — B\nTerceiro")).toBe(
      "Primeiro\nA, B\nTerceiro",
    );
  });

  it("liga a regra pela configuração da organização", () => {
    expect(
      aplicarAjustesDeEstilo("Olá — tudo bem?", { sem_travessao_longo: true }),
    ).toBe("Olá, tudo bem?");
  });

  it("consulta a escolha com organization_id explícito", async () => {
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      async query(sql: string, params?: unknown[]) {
        chamadas.push({ sql, params: params ?? [] });
        return {
          rows: [{ layer: "estilo:sem_travessao_longo", enabled: true }],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      },
    } as unknown as Queryable;

    await expect(lerAjustesDeEstiloDaOrg(db, "org-1")).resolves.toEqual({
      ajustes: { sem_travessao_longo: true },
      leituraFalhou: false,
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.sql).toContain("organization_id = $1");
    expect(chamadas[0]!.params[0]).toBe("org-1");
  });

  it("falha de leitura não derruba atendimento e mantém todos desligados", async () => {
    const db = {
      async query() {
        throw new Error("db indisponível");
      },
    } as unknown as Queryable;
    // Degrada para desligado E diz que degradou: sem a marca, "a organização
    // desligou" e "não consegui perguntar" ficam indistinguíveis no rastro.
    await expect(lerAjustesDeEstiloDaOrg(db, "org-1")).resolves.toEqual({
      ajustes: AJUSTES_DESLIGADOS,
      leituraFalhou: true,
    });
  });

  it("bordas de pontuação: o travessão não vira pontuação dupla nem vírgula órfã", () => {
    // As quatro medidas na versão anterior da função, que trocava o travessão
    // por vírgula em qualquer posição:
    //   "Olá: — tudo bem?"   → "Olá:, tudo bem?"
    //   "Oi, — tudo bem?"    → "Oi,, tudo bem?"
    //   "Isso — — aquilo"    → "Isso, , aquilo"
    //   "Fim da linha —\r\n"  → "Fim da linha, \r\n"
    expect(removerTravessaoLongo("Olá: — tudo bem?")).toBe("Olá: tudo bem?");
    expect(removerTravessaoLongo("Oi, — tudo bem?")).toBe("Oi, tudo bem?");
    expect(removerTravessaoLongo("Isso — — aquilo")).toBe("Isso, aquilo");
    expect(removerTravessaoLongo("Fim da linha —\r\n")).toBe("Fim da linha\r\n");
    expect(removerTravessaoLongo("Linha —\r\nSegunda")).toBe("Linha\r\nSegunda");
    // E o que já funcionava continua igual.
    expect(removerTravessaoLongo("Primeiro—segundo—terceiro")).toBe("Primeiro, segundo, terceiro");
  });
});

describe("fiação antes do before_send", () => {
  it("normaliza o texto do modelo antes do classificador semântico e do GateContext", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/guardrails/before-send.ts"),
      "utf8",
    );
    const ajuste = fonte.indexOf("const bodyDoModelo =");
    const semantica = fonte.indexOf("args.classifyPromiseSemantic(bodyDoModelo)");
    const contexto = fonte.indexOf("body: bodyDoModelo");

    expect(ajuste).toBeGreaterThan(-1);
    expect(semantica).toBeGreaterThan(ajuste);
    expect(contexto).toBeGreaterThan(ajuste);
  });

  it("usa presença de enforceInternalVocabulary para alcançar também o re-run do fail-safe", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/guardrails/before-send.ts"),
      "utf8",
    );
    expect(fonte).toContain("args.enforceInternalVocabulary !== undefined");
    expect(fonte).not.toContain("args.enforceInternalVocabulary === true\n        ? aplicarAjustesDeEstilo");
  });
});

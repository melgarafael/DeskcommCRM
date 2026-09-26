/**
 * A ESCOLHA POR FUNIL DA RETOMADA (issue #1538).
 *
 * O que este arquivo tranca:
 *  - o PADRÃO é `mesmo_registro`: funil sem `settings.reabertura` (ou com
 *    qualquer lixo na chave) continua reabrindo como sempre, e a issue exige
 *    isso como primeiro critério de aceite;
 *  - a recusa `reabertura_cria_novo` só nasce das TRÊS condições juntas (funil
 *    `novo_negocio` × negócio encerrado × etapa de destino ABERTA) — levar um
 *    encerrado para a etapa de ganho/perda é outro desfecho, e quem decide é o
 *    trigger, como antes;
 *  - o clone (P-01) só aceita origem encerrada quando o funil de ORIGEM é
 *    `novo_negocio`, e o payload do clone carrega `retomado_de_lead_id`;
 *  - a tripla da migration 0425 (arquivo × apêndice do baseline × MANIFEST) e a
 *    coluna nos tipos gerados.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import {
  montaPayloadDoClone,
  recusaTrocaDeFunil,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import {
  CAMPOS_COPIAVEIS,
  CAMPOS_PADRAO_DA_RETOMADA,
  CODIGO_REABERTURA_CRIA_NOVO,
  MODO_REABERTURA_PADRAO,
  RECUSA_REABERTURA_CRIA_NOVO,
  camposCopiadosNaRetomada,
  modoDeReabertura,
  recusaReabertura,
} from "@/lib/leads/reabertura";

const ABERTA = { is_won: false, is_lost: false } as const;
const DE_GANHO = { is_won: true, is_lost: false } as const;

describe("modoDeReabertura — o padrão é o comportamento de antes da issue", () => {
  it("sem settings, com null, com outro valor ou com objeto vazio: mesmo_registro", () => {
    for (const settings of [undefined, null, {}, { reabertura: null }, { reabertura: 42 }, { reabertura: { modo: "novo_negocio" } }]) {
      expect(modoDeReabertura(settings)).toBe(MODO_REABERTURA_PADRAO);
    }
    expect(MODO_REABERTURA_PADRAO).toBe("mesmo_registro");
  });

  it("só a string declarada liga a regra nova", () => {
    expect(modoDeReabertura({ reabertura: "novo_negocio" })).toBe("novo_negocio");
    expect(modoDeReabertura({ reabertura: "NOVO_NEGOCIO" })).toBe("mesmo_registro");
  });
});

describe("recusaReabertura — as três condições SÓ juntas recusam", () => {
  it("funil novo_negocio + negócio encerrado + etapa aberta ⇒ reabertura_cria_novo", () => {
    const recusa = recusaReabertura({
      modo: "novo_negocio",
      statusAtual: "lost",
      etapaDestino: ABERTA,
    });
    expect(recusa).not.toBeNull();
    expect(recusa?.codigo).toBe(CODIGO_REABERTURA_CRIA_NOVO);
    expect(CODIGO_REABERTURA_CRIA_NOVO).toBe("reabertura_cria_novo");
  });

  it("mesmo_registro (o padrão) não recusa nada — é o critério de aceite 1", () => {
    expect(
      recusaReabertura({ modo: "mesmo_registro", statusAtual: "lost", etapaDestino: ABERTA }),
    ).toBeNull();
    expect(
      recusaReabertura({ modo: MODO_REABERTURA_PADRAO, statusAtual: "won", etapaDestino: ABERTA }),
    ).toBeNull();
  });

  it("negócio ABERTO nunca é recusado: mover o que já está no quadro é o de sempre", () => {
    for (const statusAtual of ["open", undefined, null]) {
      expect(
        recusaReabertura({ modo: "novo_negocio", statusAtual, etapaDestino: ABERTA }),
      ).toBeNull();
    }
  });

  it("etapa de FECHAMENTO não é reabertura: outro desfecho, com o trigger no comando", () => {
    expect(
      recusaReabertura({ modo: "novo_negocio", statusAtual: "lost", etapaDestino: DE_GANHO }),
    ).toBeNull();
    expect(
      recusaReabertura({
        modo: "novo_negocio",
        statusAtual: "won",
        etapaDestino: { is_won: false, is_lost: true },
      }),
    ).toBeNull();
  });

  it("a recusa fala espanhol e aponta a porta que resolve nas DUAS línguas", () => {
    const es = traduzir(RECUSA_REABERTURA_CRIA_NOVO, "es");
    expect(es).not.toBe(RECUSA_REABERTURA_CRIA_NOVO);
    for (const idioma of ["pt-BR", "es"] as const) {
      expect(traduzir(RECUSA_REABERTURA_CRIA_NOVO, idioma)).toContain(
        "/api/v1/leads/{id}/retomar",
      );
    }
  });
});

describe("os campos que a retomada copia", () => {
  it("sem a chave, é o piso da proposta: custom_fields e tags", () => {
    expect(camposCopiadosNaRetomada(undefined)).toEqual([...CAMPOS_PADRAO_DA_RETOMADA]);
    expect(camposCopiadosNaRetomada({})).toEqual(["custom_fields", "tags"]);
    expect(CAMPOS_PADRAO_DA_RETOMADA.every((c) => (CAMPOS_COPIAVEIS as readonly string[]).includes(c))).toBe(true);
  });

  it("a lista declarada é filtrada pela whitelist — fora dela não vira escrita", () => {
    expect(camposCopiadosNaRetomada({ reabertura_campos: ["tags", "value_cents", "external_id"] })).toEqual([
      "tags",
      "value_cents",
    ]);
  });

  it("lista vazia é escolha do operador (só o contato), não erro de leitura", () => {
    expect(camposCopiadosNaRetomada({ reabertura_campos: [] })).toEqual([]);
  });
});

describe("clone (P-01): encerrado só entra num funil novo_negocio", () => {
  const outroFunil = "99999999-9999-4999-8999-999999999999";
  const funilDaOrigem = "44444444-4444-4444-8444-444444444444";
  const etapa: EtapaDoFunil = {
    id: "66666666-6666-4666-8666-666666666666",
    pipeline_id: outroFunil,
    position: 1000,
    is_won: false,
    is_lost: false,
    is_archived: false,
  };
  const origem = (status: string): OrigemParaClonar => ({
    id: "33333333-3333-4333-8333-333333333333",
    pipeline_id: funilDaOrigem,
    status,
    title: "Consulta de avaliação",
    tags: ["quente"],
    custom_fields: { plano: "anual" },
  });

  it("sem o modo, a recusa de antes continua valendo", () => {
    expect(recusaTrocaDeFunil(origem("lost"), outroFunil)?.code).toBe("lead_not_open");
    expect(recusaTrocaDeFunil(origem("won"), outroFunil, "mesmo_registro")?.code).toBe("lead_not_open");
  });

  it("novo_negocio abre a porta — e mesmo funil continua sendo /move", () => {
    expect(recusaTrocaDeFunil(origem("lost"), outroFunil, "novo_negocio")).toBeNull();
    expect(recusaTrocaDeFunil(origem("won"), outroFunil, "novo_negocio")).toBeNull();
    expect(recusaTrocaDeFunil(origem("open"), funilDaOrigem, "novo_negocio")?.code).toBe(
      "pipeline_unchanged",
    );
  });

  it("o clone de encerrado aponta para a origem; o de aberto não tem cadeia", () => {
    expect(montaPayloadDoClone(origem("lost"), etapa).retomado_de_lead_id).toBe(origem("lost").id);
    expect(montaPayloadDoClone(origem("open"), etapa).retomado_de_lead_id).toBeNull();
  });
});

describe("a tripla da migration 0425 — coluna, FK e registro", () => {
  const raiz = process.cwd();
  const arquivos = readdirSync(join(raiz, "supabase", "migrations"));
  const nome = arquivos.find((a) => a.includes("_0425_"));

  it("existe, e a migration cria a coluna com FK e índice", () => {
    expect(nome).toBeTruthy();
    const sql = readFileSync(join(raiz, "supabase", "migrations", nome ?? ""), "utf8");
    expect(sql).toContain("retomado_de_lead_id uuid");
    expect(sql).toContain("fk_crm_leads_retomado_de_lead");
    expect(sql).toContain("on delete set null");
    expect(sql).toContain("idx_crm_leads_retomado_de_lead");
  });

  it("o apêndice do baseline espelha a migration (instalação fresca recebe a coluna)", () => {
    const baseline = readFileSync(join(raiz, "supabase", "baseline.sql"), "utf8");
    expect(baseline).toContain("retomado_de_lead_id uuid");
    expect(baseline).toContain("fk_crm_leads_retomado_de_lead");
    expect(baseline).toContain("on delete set null");
    expect(baseline).toContain("idx_crm_leads_retomado_de_lead");
  });

  it("o MANIFEST registra, e os tipos gerados têm a coluna nos TRÊS blocos", () => {
    const manifest = readFileSync(join(raiz, "supabase", "migrations", "MANIFEST.md"), "utf8");
    expect(manifest).toContain("0425_retomada_como_novo_negocio");

    const tipos = readFileSync(join(raiz, "lib", "database.types.ts"), "utf8");
    const ocorrencias = tipos.split("retomado_de_lead_id").length - 1;
    expect(ocorrencias).toBe(3);
  });
});

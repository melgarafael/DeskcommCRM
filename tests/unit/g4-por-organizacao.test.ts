/**
 * O G4 JURÍDICO É DA ORGANIZAÇÃO — e o padrão continua sendo HOJE.
 *
 * ## O defeito que este arquivo fecha (#2097)
 *
 * `G4_LEGAL_REGEX` (`lib/ai/handoff/regex.ts`) vira handoff humano para
 * procon, advogado, processo judicial, justiça, juiz, reclame aqui, denúncia,
 * defensoria, ministério público. Para quase todo nicho isso é reclamação
 * grave; para um ESCRITÓRIO DE ADVOCACIA é o vocabulário normal do cliente
 * ("quero falar com o advogado", "já reclamei no Procon") — e o agente quase
 * não conclui a qualificação.
 *
 * ## O que se prova aqui
 *
 * 1. **Alvo (vermelho sem a mudança):** a organização que desligou o G4 NÃO
 *    cai em handoff por vocabulário jurídico.
 * 2. **Controle A:** a organização que NÃO configurou nada continua caindo em
 *    handoff com o MESMO resultado de hoje — inclusive quando `settings` vem
 *    malformado ou a leitura falha (falha fechada para o comportamento atual).
 * 3. **Controle B:** as demais gates (G1 pedido de humano, G3 insegurança) e o
 *    G4 jurídico PURO seguem com o resultado de antes — desligar o G4 de uma
 *    organização não desliga o pedido explícito de humano.
 * 4. **Cerca de fiação:** o worker é quem chama o G4 pela preferência da
 *    organização, e o G1 continua antes dele (a ordem das checagens não mudou).
 *
 * O banco é falso de propósito: a leitura é UMA (`organizations.settings`) e o
 * que interessa é a decisão a partir dela — sem Supabase e sem rede.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  checkG1,
  checkG3,
  checkG4Legal,
  checkG4LegalNaOrganizacao,
  g4JuridicoLigado,
} from "@/lib/ai/handoff/triggers";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Vocabulário jurídico normal de cliente de escritório de advocacia. */
const TERMOS_JURIDICOS =
  "quero falar com o advogado, já abri processo judicial e reclamei no Procon";
const SEM_TERMOS = "bom dia, o escritório atende consulta na área trabalhista?";

/** `null` = a linha da organização não veio (data null). */
function dbCom(settings: unknown | null): { db: SupabaseClient; consultas: () => number } {
  let consultas = 0;
  const q = {
    select() {
      return q;
    },
    eq() {
      return q;
    },
    async maybeSingle() {
      consultas += 1;
      return { data: settings === null ? null : { settings }, error: null };
    },
  };
  const db = { from: () => q } as unknown as SupabaseClient;
  return { db, consultas: () => consultas };
}

describe("G4 jurídico por organização", () => {
  it("organização que DESLIGOU o G4 não cai em handoff por vocabulário jurídico", async () => {
    const { db } = dbCom({ handoff: { g4_juridico: false } });
    await expect(checkG4LegalNaOrganizacao(db, ORG, TERMOS_JURIDICOS)).resolves.toBe(false);
  });

  it("só o `false` explícito desliga: valor torto continua ligado como hoje", () => {
    expect(g4JuridicoLigado({ handoff: { g4_juridico: false } })).toBe(false);
    for (const settings of [
      undefined,
      null,
      {},
      { handoff: null },
      { handoff: {} },
      { handoff: { g4_juridico: "false" } },
      { handoff: { g4_juridico: 0 } },
      { outra_chave: true },
    ]) {
      expect(g4JuridicoLigado(settings), `settings=${JSON.stringify(settings)}`).toBe(true);
    }
  });

  it("controle A — organização sem configuração continua caindo em handoff, igual hoje", async () => {
    for (const settings of [null, {}, { handoff: {} }, { handoff: { g4_juridico: "nao" } }]) {
      const { db } = dbCom(settings);
      const veio = await checkG4LegalNaOrganizacao(db, ORG, TERMOS_JURIDICOS);
      expect(veio, `settings=${JSON.stringify(settings)}`).toBe(true);
      // O mesmo resultado de hoje, medido contra a gate pura.
      expect(veio).toBe(checkG4Legal(TERMOS_JURIDICOS));
    }
  });

  it("controle B — as demais gates continuam com o resultado de antes", async () => {
    // G1 — pedido explícito de humano.
    expect(checkG1("quero falar com um atendente, por favor")).toBe(true);
    expect(checkG1("qual o horário de atendimento?")).toBe(false);
    // G3 — insegurança (medida + marcador).
    expect(checkG3({ confidence: 0.2, outputText: "resposta sem base", threshold: 0.6 })).toBe(true);
    expect(checkG3({ confidence: 0.9, outputText: "sim, com certeza", threshold: 0.6 })).toBe(false);
    expect(checkG3({ confidence: null, outputText: "não tenho certeza", threshold: 0.6 })).toBe(true);
    // G4 jurídico PURO — inalterado.
    expect(checkG4Legal(TERMOS_JURIDICOS)).toBe(true);
    expect(checkG4Legal(SEM_TERMOS)).toBe(false);
    // Quem desligou só o G4 continua caindo em handoff quando o lead PEDE
    // humano: quem decide isso é o G1, não a preferência da organização.
    const { db } = dbCom({ handoff: { g4_juridico: false } });
    const pedidoDeHumano = "quero falar com o advogado sobre meu caso";
    expect(checkG1(pedidoDeHumano)).toBe(true);
    await expect(checkG4LegalNaOrganizacao(db, ORG, pedidoDeHumano)).resolves.toBe(false);
    // E sem vocabulário jurídico nada muda — a consulta nem acontece.
    const { db: db2, consultas } = dbCom({ handoff: { g4_juridico: false } });
    await expect(checkG4LegalNaOrganizacao(db2, ORG, SEM_TERMOS)).resolves.toBe(false);
    expect(consultas()).toBe(0);
  });
});

describe("fiação do worker", () => {
  it("o G4 roda pela preferência da organização e o G1 continua antes dele", () => {
    const fonte = readFileSync(join(process.cwd(), "workers/ai-response-worker.ts"), "utf8");
    const g1 = fonte.indexOf("checkG1(ctx.inbound_body)");
    const g4 = fonte.indexOf("checkG4LegalNaOrganizacao(");
    expect(g1, "G1 chamado no worker").toBeGreaterThan(-1);
    expect(g4, "G4 pela preferência da organização chamado no worker").toBeGreaterThan(-1);
    expect(g1).toBeLessThan(g4);
    // As demais checagens do bloco seguem intactas.
    expect(fonte).toContain("checkG4Stage(leadId, ctx.organization_id)");
    expect(fonte).toContain('reason: "legal_mention"');
  });
});

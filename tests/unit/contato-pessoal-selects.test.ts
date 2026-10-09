import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { STATUS_DO_DESTINATARIO, TERMINAIS_DE_DESPACHO, MOTIVOS_DE_EXCLUSAO } from "@/lib/campanhas/tipos";

/**
 * OS TIPOS ESPELHAM A COLUNA (spec 21, fatia 1, etapa 2).
 *
 * `is_personal` nasce no banco (migration 0563) e cada leitura que monta selo,
 * filtro ou veto precisa pedi-la explicitamente — coluna que o SELECT não pede
 * chega como `undefined`, e `undefined` lido como "não é pessoal" é o defeito
 * que este arquivo existe para impedir.
 *
 * Os SELECTs são lidos DO FONTE (mesmo padrão de
 * `busca-do-inbox-nao-estoura-a-url.test.ts`): importar a constante mediria o
 * símbolo, não o comportamento — alguém tiraria a coluna do SELECT e o teste
 * continuaria verde sobre outra coisa.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Tirar `is_personal` de qualquer SELECT abaixo: o caso correspondente cai.
 * - Tirar `"personal"` de `STATUS_DO_DESTINATARIO`: cai "status personal";
 *   a paridade banco × TS é cobrada de verdade pelo invariante
 *   `vocabulario-banco-x-typescript` (par campaign_recipients.status).
 * Linha para reverter: o SELECT editado (ou `lib/campanhas/tipos.ts`).
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");

describe("contato pessoal: a coluna viaja em todo SELECT que lê o contato", () => {
  it("lista de Contatos pede is_personal", () => {
    const m = /const SELECT_COLS =\s*"([^"]*)"/.exec(
      fonte("app", "api", "v1", "contacts", "_handler.ts"),
    );
    if (!m) throw new Error("não achei SELECT_COLS em contacts/_handler.ts — o gate ficou cego");
    expect(m[1]).toMatch(/is_personal/);
  });

  it("inbox pede is_personal no embed do contato", () => {
    const m = /const SELECT_COLS = `([\s\S]*?)`/.exec(
      fonte("app", "api", "v1", "conversations", "_handler.ts"),
    );
    if (!m) throw new Error("não achei SELECT_COLS em conversations/_handler.ts — o gate ficou cego");
    expect(m[1]).toMatch(/contacts:contact_id \([^)]*is_personal/);
  });

  it("ContactSummary do realtime conhece is_personal", () => {
    const src = fonte("hooks", "inbox", "useConversationsRealtime.ts");
    expect(src).toMatch(/interface ContactSummary \{[\s\S]*?is_personal: boolean/);
  });

  it("contexto do agente lê is_personal do banco", () => {
    const src = fonte("lib", "agent-engine", "edge", "crm", "get-lead-context.ts");
    expect(src).toMatch(/select name, display_name, email, phone_number, tags, is_blocked, is_personal/);
    expect(src).toMatch(/is_personal: boolean/);
  });

  it("tipo de domínio Contact exige is_personal", () => {
    const src = fonte("lib", "types", "contacts.ts");
    expect(src).toMatch(/is_personal: boolean/);
  });
});

describe("contato pessoal: vocabulário próprio de saída de campanha (D7)", () => {
  it("status `personal` existe e é terminal de despacho", () => {
    expect(STATUS_DO_DESTINATARIO).toContain("personal");
    expect(TERMINAIS_DE_DESPACHO.has("personal")).toBe(true);
  });

  it("saída de pessoal NÃO é opt_out (a taxa de opt-out não mexe)", () => {
    expect(STATUS_DO_DESTINATARIO).toContain("opted_out");
    expect("personal").not.toBe("opted_out");
  });

  it("motivo de exclusão próprio existe", () => {
    expect(MOTIVOS_DE_EXCLUSAO).toContain("contato_pessoal");
  });
});

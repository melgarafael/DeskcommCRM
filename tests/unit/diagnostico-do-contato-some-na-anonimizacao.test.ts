import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aplicarDiagnostico,
  autoriaDoUsuario,
  CHAVES_DO_DIAGNOSTICO,
  diagnosticoVazio,
  lerDiagnostico,
} from "@/lib/contacts/diagnostico-do-contato";

/**
 * O DIAGNÓSTICO DA EMPRESA SOME QUANDO O CONTATO É ANONIMIZADO.
 *
 * O diagnóstico (segmento, CNPJ, texto da equipe ou da IA, oferta, autoria)
 * mora em `contacts.custom_fields`. Quem apaga isso na anonimização não é uma
 * lista de chaves: é o gatilho `trg_contacts_anonimizado_limpa_custom_fields`,
 * que troca o objeto INTEIRO por `{}` — pelos dois caminhos (a cascata e a rota
 * direta). Por isso nenhuma chave nova precisa ser "lembrada" pela LGPD.
 *
 * Esta cerca roda sem banco e guarda as duas pontas dessa conclusão:
 *   1. a ÚLTIMA definição da função do gatilho no baseline (a que o banco
 *      instala, item 10 da doutrina de migrations) zera o objeto inteiro, sem
 *      lista de chaves que um dia deixe o diagnóstico de fora;
 *   2. toda chave do diagnóstico vive DENTRO de `custom_fields` — nenhuma vira
 *      coluna própria por engano, onde o gatilho não alcançaria.
 *
 * A prova no banco de verdade é o invariante
 * `tests/invariants/lgpd-alcanca-campos-personalizados-do-contato.test.ts`
 * (roda no `pnpm test:db`), que grava um diagnóstico completo e anonimiza.
 */

const RAIZ = join(__dirname, "..", "..");
const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

function ultimaDefinicao(cabeca: string, fim: string): string {
  const i = baseline.toLowerCase().lastIndexOf(cabeca.toLowerCase());
  expect(i, `não achei "${cabeca}" no baseline`).toBeGreaterThanOrEqual(0);
  return baseline.slice(i, baseline.indexOf(fim, i) + fim.length);
}

describe("a anonimização apaga o diagnóstico da ficha", () => {
  it("⭐ a função do gatilho (última definição) troca o custom_fields INTEIRO por {}", () => {
    const corpo = ultimaDefinicao(
      "create or replace function public.fn_contato_anonimizado_limpa_campos_personalizados",
      "$$;",
    ).replace(/\s+/g, " ");
    expect(corpo).toContain("new.custom_fields := '{}'::jsonb;");
    // Um apagador por lista de chaves (`custom_fields - 'x'`) deixaria de fora
    // toda chave que não estivesse na lista — o diagnóstico incluído.
    expect(corpo).not.toMatch(/custom_fields\s*-\s*'/);
  });

  it("o gatilho dispara quando o contato vira anonimizado", () => {
    const gatilho = ultimaDefinicao(
      "create trigger trg_contacts_anonimizado_limpa_custom_fields",
      ";",
    ).replace(/\s+/g, " ");
    expect(gatilho).toContain("before update of is_anonymized on public.contacts");
    expect(gatilho).toContain("new.is_anonymized = true");
    expect(gatilho).toContain("fn_contato_anonimizado_limpa_campos_personalizados()");
  });

  it("⭐ toda chave do diagnóstico é gravada DENTRO de custom_fields", () => {
    const gravado = aplicarDiagnostico(
      {},
      { segmento: "", cnpj: "", resumo: "", oferta: "", observacoes: "" },
      {
        segmento: "Padaria",
        cnpj: "11.222.333/0001-81",
        resumo: "Sem cardápio online.",
        oferta: "Cardápio pelo WhatsApp.",
        observacoes: "Dono atende à tarde.",
      },
      autoriaDoUsuario("22222222-2222-4222-8222-222222222222"),
    );
    // Todas as chaves do esquema saem no objeto que vai para `custom_fields`.
    expect(Object.keys(gravado).sort()).toEqual(Object.values(CHAVES_DO_DIAGNOSTICO).sort());
    // E nenhuma delas é coluna: o baseline não declara nenhum desses nomes,
    // nem no corpo do dump (`"nome" tipo`) nem num apêndice (`add column`).
    for (const chave of Object.values(CHAVES_DO_DIAGNOSTICO)) {
      expect(baseline, `"${chave}" virou coluna no baseline`).not.toMatch(
        new RegExp(`(^\\s+"${chave}" |add column (if not exists )?"?${chave}"?\\s)`, "im"),
      );
    }
  });

  it("o custom_fields de um anonimizado ({}) deixa a aba vazia", () => {
    expect(diagnosticoVazio(lerDiagnostico({}))).toBe(true);
  });
});

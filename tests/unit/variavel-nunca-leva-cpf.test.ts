/**
 * NENHUMA `{{variável}}` LEVA O DOCUMENTO DO CONTATO PARA A MENSAGEM.
 *
 * A automação carrega a linha INTEIRA de `contacts` no contexto do render
 * (`select *`), e é por isso que `{{contact.<coluna>}}` funciona. A mesma porta
 * abriria `{{contact.cpf_hash}}` e `{{contact.cpf_encrypted}}` — e uma
 * mensagem de WhatsApp ou e-mail levaria o documento (ou o seu hash) para fora.
 * A guarda é `SO_DA_EQUIPE`, no resolvedor único (`lib/variaveis/resolvedor.ts`),
 * alimentada por `COLUNAS_DE_CPF_DO_CONTATO`.
 *
 * Antes do #3687 a guarda morava em `renderTemplate`; o refactor a levou para o
 * resolvedor, e a prova de que ela sobreviveu foi um caso TEMPORÁRIO, não
 * commitado. Este arquivo é a versão permanente, e cobre o que a mudança de
 * casa podia perder:
 *
 *   1. as QUATRO fontes e as QUATRO políticas de vazio — não só a automação;
 *   2. as formas que o operador (ou quem quer o dado) escreve: caixa alta,
 *      espaço, reserva `|"x"` e o modificador de data `|data` do #4339;
 *   3. as portas de entrada reais (automação e follow-up de texto);
 *   4. a LISTA: toda coluna de documento que o schema do contato tiver precisa
 *      estar em `COLUNAS_DE_CPF_DO_CONTATO` — coluna nova de documento sem
 *      entrar na guarda reprova aqui, antes de virar variável.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COLUNAS_DE_CPF_DO_CONTATO } from "@/lib/automation/conditions";
import { renderTemplate } from "@/lib/automation/template";
import { renderizarTextoDeFollowup } from "@/lib/automation/texto-do-followup";
import { RESOLVEDORES } from "@/lib/variaveis/catalogo";
import { resolverVariaveis, type QuandoVazio } from "@/lib/variaveis/resolvedor";

const SEGREDO = "52998224725";
const POLITICAS: readonly QuandoVazio[] = ["vazio", "literal", "remover", "pular"];

/** A linha do contato como a automação a carrega: com o documento junto. */
function contextoComDocumento(): Record<string, unknown> {
  const contato: Record<string, unknown> = { id: "c1", name: "Ana Souza" };
  for (const caminho of COLUNAS_DE_CPF_DO_CONTATO) {
    contato[caminho.slice("contact.".length)] = `${SEGREDO}-${caminho}`;
  }
  return { contact: contato, lead: { title: "Plano Pro", custom_fields: {} } };
}

/** Cada forma de pedir a coluna que alguém pode escrever no corpo. */
function formasDePedir(caminho: string): string[] {
  const coluna = caminho.slice("contact.".length);
  return [
    `{{${caminho}}}`,
    `{{ ${caminho.toUpperCase()} }}`,
    `{{${caminho}|"sem documento"}}`,
    `{{${caminho}|data}}`,
    `{{${caminho}|data:dd/mm/aaaa}}`,
    `{{${coluna}}}`,
  ];
}

describe("a guarda existe e não está vazia", () => {
  it("as duas colunas de CPF do contato estão na lista", () => {
    expect([...COLUNAS_DE_CPF_DO_CONTATO].sort()).toEqual(
      expect.arrayContaining(["contact.cpf_encrypted", "contact.cpf_hash"]),
    );
  });

  it("toda coluna de documento do schema do contato está na lista", () => {
    const baseline = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");
    const criacao = /CREATE TABLE IF NOT EXISTS "public"\."contacts" \(([\s\S]*?)\n\);/.exec(baseline);
    expect(criacao, "CREATE TABLE de contacts não encontrado no baseline").not.toBeNull();
    const colunas = new Set(
      [...(criacao?.[1] ?? "").matchAll(/^\s+"(\w+)"\s/gm)].map((m) => m[1] as string),
    );
    // O apêndice acrescenta colunas em `alter table public.contacts add column ...`.
    for (const comando of baseline.split(";")) {
      if (!/alter\s+table\s+(?:only\s+)?"?public"?\."?contacts"?\s/i.test(comando)) continue;
      for (const m of comando.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)) {
        colunas.add(m[1] as string);
      }
    }
    const deDocumento = [...colunas].filter((c) =>
      /cpf|cnpj|documento|document|passaporte|passport|(^|_)rg($|_)/i.test(c),
    );
    // Controle positivo: a sonda acha as que sabemos que existem.
    expect(deDocumento).toEqual(expect.arrayContaining(["cpf_hash", "cpf_encrypted"]));
    for (const coluna of deDocumento) {
      expect(
        COLUNAS_DE_CPF_DO_CONTATO.has(`contact.${coluna}`),
        `contacts.${coluna} é documento e não está em COLUNAS_DE_CPF_DO_CONTATO`,
      ).toBe(true);
    }
  });
});

describe("o resolvedor nunca põe o documento no texto", () => {
  it("em toda fonte, toda política e toda forma de pedir", () => {
    const contexto = contextoComDocumento();
    for (const caminho of COLUNAS_DE_CPF_DO_CONTATO) {
      for (const forma of formasDePedir(caminho)) {
        for (const fonte of RESOLVEDORES) {
          for (const quandoVazio of POLITICAS) {
            const { texto } = resolverVariaveis(`[${forma}]`, contexto, { fonte, quandoVazio });
            expect(texto, `${forma} · ${fonte} · ${quandoVazio}`).not.toContain(SEGREDO);
          }
        }
      }
    }
  });

  it("na automação a coluna sai VAZIA — nem a reserva a preenche", () => {
    const contexto = contextoComDocumento();
    for (const caminho of COLUNAS_DE_CPF_DO_CONTATO) {
      for (const forma of formasDePedir(caminho)) {
        expect(renderTemplate(`[${forma}]`, contexto), forma).toBe("[]");
      }
    }
  });

  it("o follow-up de texto (política remover) também não leva", () => {
    const contexto = contextoComDocumento();
    for (const caminho of COLUNAS_DE_CPF_DO_CONTATO) {
      const texto = renderizarTextoDeFollowup(`Oi {{primeiro_nome}}, CPF {{${caminho}}}.`, contexto);
      expect(texto).toBe("Oi Ana, CPF.");
    }
  });

  it("o resto da mensagem continua resolvendo (a guarda não cala a frase)", () => {
    expect(renderTemplate("Oi {{nome}} [{{contact.cpf_hash}}]", contextoComDocumento())).toBe(
      "Oi Ana Souza []",
    );
  });
});

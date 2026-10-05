// @vitest-environment node
import { describe, expect, it } from "vitest";

import { anonymize, detectResidualPii, padroesDePii } from "@/lib/ai/anonymize";
import {
  citacaoDaLei,
  isValidNif,
  PERFIS_DO_PAIS,
  paisesOferecidos,
  perfilDoPais,
} from "@/lib/legal/perfil-do-pais";
import { HOLIDAYS_PT_ISO } from "@/lib/lgpd/holidays-pt";
import { computeDueAt } from "@/lib/lgpd/sla";
import { contactCreateSchemaDoPais } from "@/lib/schemas/contacts";

describe("perfil de Portugal (issue #1946)", () => {
  it("Portugal está no registro E no seletor, com a lei revisada (doc 88)", () => {
    // INVERTIDO DE PROPÓSITO no PR do doc 88: até 2026-10-05 este caso provava
    // PT FORA da lista. A revisão da citação foi feita por IA, por delegação do
    // dono, e registrada no cabeçalho de `lib/legal/perfil-do-pais.ts`.
    expect(Object.keys(PERFIS_DO_PAIS)).toContain("PT");
    const codigos = paisesOferecidos().map((p) => p.codigo);
    expect(codigos).toContain("BR");
    expect(codigos).toContain("PT");
  });

  it("o perfil PT não decai para o Brasil quando pedido por código", () => {
    const perfil = perfilDoPais("PT");
    expect(perfil.codigo).toBe("PT");
    expect(perfil.nome).toBe("Portugal");
    expect(perfil.documento.rotulo).toBe("NIF");
    expect(perfil.telefoneExemplo).toBe("+351912345678");
  });

  it("documento NIF aceita o dígito de controlo (mod-11 público) e espaçado", () => {
    expect(isValidNif("123456789")).toBe(true);
    expect(isValidNif("123 456 789")).toBe(true);
    expect(perfilDoPais("PT").documento.valida("123456789")).toBe(true);
  });

  it("documento NIF recusa dígito trocado, repetido e CPF brasileiro", () => {
    expect(isValidNif("123456788")).toBe(false); // dígito de controlo trocado
    expect(isValidNif("999999999")).toBe(false); // repetido
    expect(perfilDoPais("PT").documento.valida("52998224725")).toBe(false); // CPF de 11 dígitos
  });

  it("o documento português confere dígito, não é só forma", () => {
    expect(perfilDoPais("PT").documento.confereDigito).toBe(true);
    expect(perfilDoPais("PT").documento.exemplo).toBe("123 456 789");
    // normalização guarda só os dígitos (a planilha não decide o formato do banco)
    expect(perfilDoPais("PT").documento.normaliza("123 456 789")).toBe("123456789");
  });

  it("o exemplo de telefone é de Portugal, não o DDI brasileiro", () => {
    expect(perfilDoPais("PT").telefoneExemplo).toMatch(/^\+351/);
    expect(perfilDoPais("PT").telefoneExemplo).not.toMatch(/^\+55/);
  });

  it("o exemplo de telefone de todo país passa na validação do próprio formulário", () => {
    // O exemplo é o placeholder do campo e entra na mensagem de erro: um valor
    // que o PHONE_REGEX recusa (ex.: mascarado com `*`) ensina o que a tela barra.
    for (const perfil of Object.values(PERFIS_DO_PAIS)) {
      const r = contactCreateSchemaDoPais(perfil).safeParse({
        phone_number: perfil.telefoneExemplo,
      });
      expect(r.success, `${perfil.codigo}: ${perfil.telefoneExemplo}`).toBe(true);
    }
  });

  it("a lei é o RGPD (UE) 2016/679, art. 15.º, revisada por IA e citada no formato comum", () => {
    // INVERTIDO DE PROPÓSITO no PR do doc 88 (era `revisada` false e citação null).
    const lei = perfilDoPais("PT").lei;
    expect(lei?.nome).toBe("RGPD");
    expect(lei?.revisada).toBe(true);
    // A tela declara a quem responde pelo documento que a revisão foi feita por IA.
    expect(lei?.revisadaPorIa).toBe(true);
    // No RGPD "base legal" é o art. 6.º; o art. 15.º é o direito exercido.
    expect(lei?.rotuloNoDocumento).toBe("Direito exercido");
    // A string exata: o formatador é o mesmo do Brasil e não muda de forma.
    expect(citacaoDaLei(perfilDoPais("PT"))).toBe("RGPD art. 15.º (Regulamento (UE) 2016/679)");
  });

  it("só Portugal declara revisão por IA — o aviso da tela fala de RGPD e NIF", () => {
    // O aviso de `app/app/settings/tenant/_form.tsx` é texto de Portugal. Um
    // segundo país revisado por IA mostraria esse texto errado: ele precisa do
    // seu, e este caso reprova até lá.
    const porIa = Object.values(PERFIS_DO_PAIS)
      .filter((p) => p.lei?.revisadaPorIa)
      .map((p) => p.codigo);
    expect(porIa).toEqual(["PT"]);
    // O Brasil não ganha campo novo: é o que mantém o seu data.json igual.
    expect(perfilDoPais("BR").lei).toEqual({
      nome: "LGPD",
      numero: "Lei nº 13.709/2018",
      artigo: "Art. 18, II",
      revisada: true,
    });
  });

  it("checksum público NÃO abre a porta da lista sem a lei revisada", () => {
    // A regra do #1033 (decisão 25): país entra no seletor com citação revisada
    // ou não entra. Ter documento com dígito de controlo não muda isso. Com
    // Portugal revisado, a prova passa a usar um país sintético.
    const sintetico = {
      ...perfilDoPais("PT"),
      codigo: "QZ",
      nome: "Quiztão",
      lei: { ...perfilDoPais("PT").lei!, revisada: false },
    };
    PERFIS_DO_PAIS.QZ = sintetico;
    try {
      expect(sintetico.documento.confereDigito).toBe(true);
      expect(paisesOferecidos().some((p) => p.codigo === "QZ")).toBe(false);
      expect(citacaoDaLei(sintetico)).toBeNull();
    } finally {
      delete PERFIS_DO_PAIS.QZ;
    }
  });

  it("padroesDePii declara NIF e código postal 1234-567", () => {
    const tipos = padroesDePii([perfilDoPais("PT")]).map((p) => p.tipo);
    expect(tipos).toEqual(["nif", "codigoPostal", "email", "phone"]);
  });

  it("o anonimizador redige o NIF português e o código postal", () => {
    const padroes = padroesDePii([perfilDoPais("PT")]);
    const textoTurvo = anonymize("o NIF é 123456789 e mora no 1234-567", padroes);
    expect(textoTurvo.anonymized).toContain("[NIF]");
    expect(textoTurvo.anonymized).toContain("[CODIGO_POSTAL]");
    expect(textoTurvo.anonymized).not.toContain("123456789");
    expect(detectResidualPii("123456789 e 1234-567", padroes)).not.toBeNull();
  });

  it("o CPF brasileiro NÃO é confundido com o NIF português", () => {
    // os 11 dígitos do CPF não cabem no padrão de NIF (9 dígitos delimitados);
    // o universal de telefone pode mascará-lo no texto, mas nunca como NIF.
    const padroes = padroesDePii([perfilDoPais("PT")]);
    const texto = anonymize("CPF 52998224725 por aqui", padroes);
    expect(texto.hits.some((h) => h.type === "nif")).toBe(false);
    expect(detectResidualPii("52998224725", padroes)).not.toBe("nif");
  });

  it("o calendário é o dos feriados obrigatórios: Carnaval (facultativo) não pula dia útil", () => {
    // 10 fixos + Sexta-feira Santa + Corpo de Deus, 5 anos (CT art. 234.º).
    expect(HOLIDAYS_PT_ISO).toHaveLength(60);
    expect(HOLIDAYS_PT_ISO).toContain("2027-03-26"); // Sexta-feira Santa (Páscoa 28/03)
    expect(HOLIDAYS_PT_ISO).not.toContain("2026-02-17"); // Terça de Carnaval, art. 235.º
    // Pedido na segunda 16/02/2026 com 1 dia útil vence na terça 17/02, não na quarta.
    const vence = computeDueAt(
      new Date("2026-02-16T10:00:00Z"),
      1,
      new Set(perfilDoPais("PT").calendario.feriados),
    );
    expect(vence.toISOString().slice(0, 10)).toBe("2026-02-17");
  });
});

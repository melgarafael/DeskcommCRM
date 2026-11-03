// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  citacaoDaLei,
  PERFIS_DO_PAIS,
  paisesOferecidos,
  perfilDoPais,
} from "@/lib/legal/perfil-do-pais";
import {
  HOLIDAYS_AR_ISO,
  PRIMEIRO_ANO_COBERTO,
  ULTIMO_ANO_COBERTO,
  feriadosDaArgentinaDoAno,
} from "@/lib/lgpd/holidays-ar";
import { computeDueAt } from "@/lib/lgpd/sla";
import { contactCreateSchemaDoPais } from "@/lib/schemas/contacts";

describe("perfil da Argentina (03/11/2026, revisão por IA)", () => {
  it("Argentina está no registro E no seletor, com a lei revisada", () => {
    expect(Object.keys(PERFIS_DO_PAIS)).toContain("AR");
    const codigos = paisesOferecidos().map((p) => p.codigo);
    expect(codigos).toContain("BR");
    expect(codigos).toContain("AR");
  });

  it("o perfil AR não decai para o Brasil quando pedido por código", () => {
    const perfil = perfilDoPais("AR");
    expect(perfil.codigo).toBe("AR");
    expect(perfil.nome).toBe("Argentina");
    expect(perfil.documento.rotulo).toBe("DNI");
    expect(perfil.telefoneExemplo).toBe("+5491155556666");
    expect(perfil.idioma).toBe("es-AR");
    expect(perfil.fusoDoSugerido).toBe("America/Argentina/Buenos_Aires");
  });

  it("o documento DNI valida só a forma — a Argentina não publica dígito verificador", () => {
    expect(perfilDoPais("AR").documento.confereDigito).toBe(false);
    expect(perfilDoPais("AR").documento.valida("30111222")).toBe(true);
    expect(perfilDoPais("AR").documento.valida("30.111.222")).toBe(true);
    expect(perfilDoPais("AR").documento.valida("123456")).toBe(false); // 6 dígitos, curto demais
    expect(perfilDoPais("AR").documento.normaliza("30.111.222")).toBe("30111222");
  });

  it("o exemplo de telefone é da Argentina, não o DDI brasileiro", () => {
    expect(perfilDoPais("AR").telefoneExemplo).toMatch(/^\+549/);
    expect(perfilDoPais("AR").telefoneExemplo).not.toMatch(/^\+55/);
  });

  it("o exemplo de telefone de todo país passa na validação do próprio formulário", () => {
    for (const perfil of Object.values(PERFIS_DO_PAIS)) {
      const r = contactCreateSchemaDoPais(perfil).safeParse({
        phone_number: perfil.telefoneExemplo,
      });
      expect(r.success, `${perfil.codigo}: ${perfil.telefoneExemplo}`).toBe(true);
    }
  });

  it("a lei é a 25.326, Art. 14, revisada por IA e citada no formato comum", () => {
    const lei = perfilDoPais("AR").lei;
    expect(lei?.nome).toBe("Ley de Protección de Datos Personales");
    expect(lei?.revisada).toBe(true);
    expect(lei?.revisadaPorIa).toBe(true);
    expect(lei?.rotuloNoDocumento).toBe("Derecho ejercido");
    expect(lei?.avisoDaRevisaoPorIa).toBeTruthy();
    expect(citacaoDaLei(perfilDoPais("AR"))).toBe(
      "Ley de Protección de Datos Personales Art. 14 (Ley N.º 25.326)",
    );
  });

  it("a autoridade de supervisão é a AAIP", () => {
    expect(perfilDoPais("AR").autoridadeDeSupervisao?.nome).toContain("Agencia de Acceso a la Información Pública");
  });

  it("empresa usa CUIT/Razón social, não CNPJ/Razão social", () => {
    expect(perfilDoPais("AR").empresa.rotuloNumero).toBe("CUIT");
    expect(perfilDoPais("AR").empresa.rotuloNomeLegal).toBe("Razón social");
  });

  it("checksum ausente não abre a porta da lista sem a lei revisada (#1033)", () => {
    const sintetico = {
      ...perfilDoPais("AR"),
      codigo: "QZ",
      nome: "Quiztão",
      lei: { ...perfilDoPais("AR").lei!, revisada: false },
    };
    PERFIS_DO_PAIS.QZ = sintetico;
    try {
      expect(paisesOferecidos().some((p) => p.codigo === "QZ")).toBe(false);
      expect(citacaoDaLei(sintetico)).toBeNull();
    } finally {
      delete PERFIS_DO_PAIS.QZ;
    }
  });

  it("o calendário é só dos feriados inamovibles — doze por ano coberto", () => {
    // Nove fixos + Lunes/Martes de Carnaval + Viernes Santo.
    const anosCobertos = ULTIMO_ANO_COBERTO - PRIMEIRO_ANO_COBERTO + 1;
    expect(HOLIDAYS_AR_ISO).toHaveLength(12 * anosCobertos);
    // Trasladables NÃO entram: 17/08, 12/10 e 20/11 dependem de resolução anual.
    expect(feriadosDaArgentinaDoAno(2026)).not.toContain("2026-08-17");
    expect(feriadosDaArgentinaDoAno(2026)).not.toContain("2026-10-12");
    expect(feriadosDaArgentinaDoAno(2026)).not.toContain("2026-11-20");
  });

  it("o prazo em dias úteis salta os feriados inamovibles", () => {
    // 2026: Año Nuevo é 01/01 (quinta). Pedido na quarta 31/12/2025 com 1 dia
    // útil vence na sexta 02/01/2026, não na quinta 01/01 (feriado).
    const vence = computeDueAt(
      new Date("2025-12-31T10:00:00Z"),
      1,
      new Set(perfilDoPais("AR").calendario.feriados),
    );
    expect(vence.toISOString().slice(0, 10)).toBe("2026-01-02");
  });

  it("a cobertura alcança o ano atual + 2 — senão o prazo conta sem feriados", () => {
    const alvo = new Date().getFullYear() + 2;
    expect(ULTIMO_ANO_COBERTO).toBeGreaterThanOrEqual(alvo);
    expect(HOLIDAYS_AR_ISO).toContain(`${alvo}-12-25`);
    expect(feriadosDaArgentinaDoAno(alvo)).toHaveLength(12);
  });
});

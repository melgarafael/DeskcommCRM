// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as Sentry from "@sentry/nextjs";

import { anonymize, detectResidualPii, padroesDePii } from "@/lib/ai/anonymize";
import type { PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import {
  citacaoDaLei,
  isValidCpf,
  PAIS_PADRAO,
  paisesOferecidos,
  perfilDaOrganizacao,
  perfilDoPais,
  PERFIS_DO_PAIS,
} from "@/lib/legal/perfil-do-pais";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";

/**
 * Países SINTÉTICOS: a issue #1033 proíbe publicar citação de lei não revisada,
 * e o registro é mutável exatamente para o teste provar o mecanismo sem
 * publicar nada. O primeiro não tem lei revisada (não pode ser oferecido), o
 * segundo tem (é o que o seletor mostra).
 */
const XISTAO: PerfilDoPais = {
  codigo: "XI",
  nome: "Xistão",
  // País sintético declara os SEUS rótulos de organização (#1946, item 4).
  empresa: { rotuloNomeLegal: "Razão do Xistão", rotuloNumero: "Registro do Xistão" },
  documento: {
    rotulo: "Bilhete",
    exemplo: "123456789XI000",
    regra: "forma — 9 dígitos, 2 letras e 3 dígitos; não confere dígito verificador",
    mensagemInvalido: "Bilhete inválido",
    confereDigito: false,
    apelidosDoCabecalho: ["bilhete"],
    valida: (valor) => /^\d{9}[A-Z]{2}\d{3}$/.test(valor),
    normaliza: (valor) => valor.toUpperCase().replace(/[^0-9A-Z]/g, ""),
  },
  telefoneExemplo: "+999000000000",
  lei: { nome: "Lei do Xistão", numero: "Lei nº 1/2020", artigo: "Art. 5º", revisada: false },
  calendario: { feriados: [], rotulo: "feriados do Xistão" },
  padroesDePii: [
    {
      tipo: "bilhete",
      marcador: "[BILHETE]",
      fonte: "\\b\\d{9}[A-Z]{2}\\d{3}\\b",
      naoCobre: "bilhete com hífen e documento emitido antes de 2010",
    },
  ],
};

const REVISADOLANDIA: PerfilDoPais = {
  codigo: "RV",
  nome: "Revisadolândia",
  // País sintético declara os SEUS rótulos de organização (#1946, item 4).
  empresa: { rotuloNomeLegal: "Razão de Revisadolândia", rotuloNumero: "Registro de Revisadolândia" },
  documento: {
    rotulo: "Documento",
    exemplo: "000000000",
    regra: "forma",
    mensagemInvalido: "Documento inválido",
    confereDigito: false,
    apelidosDoCabecalho: ["documento"],
    valida: (valor) => /^\d{9}$/.test(valor),
    normaliza: (valor) => valor.replace(/\D/g, ""),
  },
  telefoneExemplo: "+999000000000",
  lei: { nome: "Lei de Revisadolândia", numero: "Lei nº 2/2021", artigo: "Art. 9º", revisada: true },
  calendario: { feriados: [], rotulo: "feriados de Revisadolândia" },
  padroesDePii: [],
};

/** O mínimo de banco que `perfilDaOrganizacao` usa: uma leitura com `maybeSingle`. */
function bancoQueResponde(resposta: { data?: unknown; error?: unknown }) {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => resposta),
    })),
  } as never;
}

beforeEach(() => {
  PERFIS_DO_PAIS.XI = XISTAO;
  PERFIS_DO_PAIS.RV = REVISADOLANDIA;
});

afterEach(() => {
  delete PERFIS_DO_PAIS.XI;
  delete PERFIS_DO_PAIS.RV;
  vi.restoreAllMocks();
});

describe("o país da organização, com o Brasil como padrão", () => {
  it("coluna nula, vazia ou ausente é o Brasil de quem já instalou", () => {
    expect(PAIS_PADRAO).toBe("BR");
    expect(perfilDoPais(null).codigo).toBe("BR");
    expect(perfilDoPais(undefined).codigo).toBe("BR");
    expect(perfilDoPais("").codigo).toBe("BR");
  });

  it("código em minúsculas ou com espaço em volta é o mesmo país", () => {
    expect(perfilDoPais(" br ").codigo).toBe("BR");
    expect(perfilDoPais("xi").nome).toBe("Xistão");
  });

  it("país conhecido devolve o perfil DELE, não o padrão", () => {
    expect(perfilDoPais("XI").documento.rotulo).toBe("Bilhete");
  });

  it("país desconhecido degrada para o Brasil — nunca para um perfil vazio", () => {
    const perfil = perfilDoPais("ZZ");
    expect(perfil.codigo).toBe("BR");
    expect(perfil.documento.valida("529.982.247-25")).toBe(true);
  });
});

describe("a régua para um país entrar (issue #1033)", () => {
  it("país com citação NÃO revisada não é oferecido ao operador", () => {
    expect(paisesOferecidos().some((p) => p.codigo === "XI")).toBe(false);
  });

  it("país com a citação revisada entra na lista que o seletor mostra", () => {
    expect(paisesOferecidos().map((p) => p.codigo)).toContain("RV");
  });

  it("perfil sem lei revisada não cita lei nenhuma — nem a brasileira", () => {
    expect(citacaoDaLei(XISTAO)).toBeNull();
    expect(citacaoDaLei({ ...XISTAO, lei: null })).toBeNull();
  });

  it("o Brasil cita a LGPD com o artigo do direito de acesso", () => {
    const citacao = citacaoDaLei(perfilDoPais("BR"));
    expect(citacao).toContain("LGPD");
    expect(citacao).toContain("13.709");
    expect(citacao).toContain("18");
  });
});

describe("o documento do titular é o do país", () => {
  it("o Brasil continua conferindo o dígito verificador (sem regressão)", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("52998224724")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
  });

  it("país sem checksum público valida FORMA e diz isso na mensagem", () => {
    expect(XISTAO.documento.confereDigito).toBe(false);
    expect(XISTAO.documento.valida("123456789XI000")).toBe(true);
    expect(XISTAO.documento.valida("123456789")).toBe(false);
    expect(XISTAO.documento.regra).toContain("não confere dígito verificador");
  });

  it("a normalização é a do país (o valor gravado não é decidido pela planilha)", () => {
    expect(XISTAO.documento.normaliza("123.456.789-xi-000")).toBe("123456789XI000");
    expect(perfilDoPais("BR").documento.normaliza("529.982.247-25")).toBe("52998224725");
  });
});

describe("perfilDaOrganizacao — a leitura e a degradação com rastro", () => {
  it("lê o país declarado na linha da organização", async () => {
    const perfil = await perfilDaOrganizacao(bancoQueResponde({ data: { country: "XI" }, error: null }), ORG);
    expect(perfil.codigo).toBe("XI");
  });

  it("organização sem país é o Brasil, sem alarde", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const perfil = await perfilDaOrganizacao(bancoQueResponde({ data: { country: null }, error: null }), ORG);
    expect(perfil.codigo).toBe("BR");
    expect(erro).not.toHaveBeenCalled();
  });

  it("leitura que falha cai no Brasil e deixa rastro — nunca derruba o cadastro", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const perfil = await perfilDaOrganizacao(
      bancoQueResponde({ data: null, error: { message: "RLS negou a leitura" } }),
      ORG,
    );
    expect(perfil.codigo).toBe("BR");
    expect(erro).toHaveBeenCalledWith(
      "[perfil-do-pais] caiu no padrão",
      expect.objectContaining({ orgId: ORG, motivo: "RLS negou a leitura" }),
    );
  });

  it("país conhecido mas sem perfil revisado cai no Brasil e avisa o Sentry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const perfil = await perfilDaOrganizacao(bancoQueResponde({ data: { country: "ZZ" }, error: null }), ORG);
    expect(perfil.codigo).toBe("BR");
    await vi.waitFor(() => {
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("[perfil-do-pais]"),
        expect.objectContaining({ level: "warning" }),
      );
    });
  });
});

describe("o anonimizador segue o país (a costura do RAG)", () => {
  it("sem perfil declarado, valem os padrões do Brasil", () => {
    expect(padroesDePii().map((p) => p.tipo)).toEqual(["cpf", "cep", "email", "phone"]);
    expect(anonymize("CPF 529.982.247-25").anonymized).toContain("[CPF]");
  });

  it("o documento do país entra ANTES dos universais", () => {
    expect(padroesDePii([XISTAO]).map((p) => p.tipo)).toEqual(["bilhete", "email", "phone"]);
  });

  it("o padrão do país redige o documento DELE — o que antes passava inteiro", () => {
    const { anonymized, hits } = anonymize("segue o bilhete 123456789XI000", padroesDePii([XISTAO]));
    expect(anonymized).toContain("[BILHETE]");
    expect(anonymized).not.toContain("123456789XI000");
    expect(hits).toContainEqual({ type: "bilhete", original: "123456789XI000", replacement: "[BILHETE]" });
  });

  it("os universais acompanham qualquer país", () => {
    const { anonymized } = anonymize("fala com ana@example.com", padroesDePii([XISTAO]));
    expect(anonymized).toContain("[EMAIL]");
  });

  it("a guarda de vazamento olha a MESMA lista que anonimizou", () => {
    const padroes = padroesDePii([XISTAO]);
    expect(detectResidualPii("ainda tem 123456789XI000 aqui", padroes)).toBe("bilhete");
    expect(detectResidualPii("nem documento, nem e-mail", padroes)).toBeNull();
    expect(detectResidualPii("CPF 52998224725", padroesDePii())).toBe("cpf");
  });
});

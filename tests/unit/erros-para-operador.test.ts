import { afterEach, describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  FRASES,
  mensagemParaOperador,
  respostaParaOperador,
  type ErroDoBanco,
} from "@/lib/erros/para-operador";

/**
 * O MAPEADOR ÚNICO DO ERRO DE BANCO PARA A FRASE DO OPERADOR (#3747).
 *
 * ─── O que este arquivo prende ───────────────────────────────────────────────
 *
 * Que o texto do Postgres NUNCA sai daqui. O caso ⭐ é o relato de suporte que
 * motivou a issue: a marca recusou a cor e o toast mostrou
 * `new row for relation "platform_branding" violates check constraint
 * "platform_branding_accent_hex"` — nome de relação, de coluna e de constraint
 * para quem só queria salvar uma cor. Agora a tela diz o que fazer com a cor e
 * quem precisa do texto inteiro o encontra no `logger.error`.
 *
 * ─── Sabotagem que confirma que a cerca vigia ───────────────────────────────
 *
 * Trocar o corpo de `mensagemParaOperador` por `return erro.message ?? ""` deixa
 * o caso ⭐ vermelho nos quatro `expect(...).not.toContain` — que é exatamente a
 * regressão que a issue quer impedir.
 */

/** O texto que o Postgres devolve de verdade. Nunca pode chegar à tela. */
const CRU = {
  code: "23514",
  message:
    'new row for relation "platform_branding" violates check constraint "platform_branding_accent_hex"',
  details: 'Failing row contains (1, "Webtecnica", null, #FFF, …).',
  hint: null,
};

/** O que a tela não pode dizer, em nenhum desfecho. */
const VAZAMENTOS = ["error.message", "constraint", "relation", "violates"];

function naoVaza(frase: string, erro: ErroDoBanco) {
  for (const proibido of VAZAMENTOS) expect(frase.toLowerCase()).not.toContain(proibido);
  expect(frase).not.toContain(erro.message ?? "\u0000");
  expect(JSON.stringify({ error: frase })).not.toContain("platform_branding");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mensagemParaOperador — o cru não passa", () => {
  it("⭐ a violação da cor da marca vira a frase da COR, sem nome de constraint nem de tabela", () => {
    const frase = mensagemParaOperador(CRU);

    expect(frase).toBe(FRASES.cor_da_marca);
    naoVaza(frase, CRU);
  });

  it("a MESMA constraint no tema escuro também tem frase de cor", () => {
    const frase = mensagemParaOperador({
      code: "23514",
      message:
        'new row for relation "platform_branding" violates check constraint "platform_branding_accent_dark_hex"',
    });

    expect(frase).toBe(FRASES.cor_da_marca);
  });

  it("a constraint do logo tem frase própria — e não a da cor", () => {
    const erro = {
      code: "23514",
      message:
        'new row for relation "platform_branding" violates check constraint "platform_branding_favicon_path"',
    };

    expect(mensagemParaOperador(erro)).toBe(FRASES.caminho_do_logo);
    naoVaza(mensagemParaOperador(erro), erro);
  });

  it("a constraint vence o código: dois CHECKs diferentes não caem na mesma frase", () => {
    const cor = { code: "23514", message: 'violates check constraint "platform_branding_accent_hex"' };
    const outra = { code: "23514", message: 'violates check constraint "alguma_outra_regra"' };

    expect(mensagemParaOperador(cor)).toBe(FRASES.cor_da_marca);
    expect(mensagemParaOperador(outra)).toBe(FRASES.valor_invalido);
  });

  it("erro sem corpo nenhum cai na genérica — nunca em vazio nem em `undefined`", () => {
    expect(mensagemParaOperador(null)).toBe(FRASES.generica);
    expect(mensagemParaOperador({})).toBe(FRASES.generica);
    expect(mensagemParaOperador({ message: "" })).toBe(FRASES.generica);
  });

  it("o genérico também não deixa passar texto de servidor desconhecido", () => {
    const erro = {
      code: "XX000",
      message: 'relation "api_audit_log" does not exist',
    };

    const frase = mensagemParaOperador(erro);

    expect(frase).toBe(FRASES.generica);
    naoVaza(frase, erro);
  });
});

describe("mensagemParaOperador — os códigos conhecidos", () => {
  const casos: [string, ErroDoBanco, string][] = [
    ["42501 (RLS/papel)", { code: "42501", message: "permission denied for table crm_pipelines" }, FRASES.sem_permissao],
    ["23505 (duplicata)", { code: "23505", message: "duplicate key value violates unique constraint" }, FRASES.repetido],
    ["23503 (FK)", { code: "23503", message: "insert or update violates foreign key constraint" }, FRASES.referencia],
    ["23502 (NOT NULL)", { code: "23502", message: "null value in column violates not-null constraint" }, FRASES.obrigatorio],
    ["22P02 (uuid torto)", { code: "22P02", message: "invalid input syntax for type uuid" }, FRASES.valor_invalido],
    ["55P03 (prazo)", { code: "55P03", message: "canceling statement due to lock timeout" }, FRASES.espera],
    ["40001 (serialização)", { code: "40001", message: "could not serialize access" }, FRASES.espera],
    ["40P01 (deadlock)", { code: "40P01", message: "deadlock detected" }, FRASES.espera],
  ];

  for (const [nome, erro, esperada] of casos) {
    it(`${nome} → frase do operador, e o texto do banco fica fora`, () => {
      const frase = mensagemParaOperador(erro);

      expect(frase).toBe(esperada);
      naoVaza(frase, erro);
    });
  }

  it("o MFA pendente não vira 'sem permissão': a pessoa pode, falta o código", () => {
    const erro = { code: "42501", message: "mfa_required" };

    expect(mensagemParaOperador(erro)).toBe(FRASES.mfa);
  });

  it("sessão vencida do GoTrue (sem `code`) é reconhecida pelo texto", () => {
    expect(mensagemParaOperador({ message: "JWT expired" })).toBe(FRASES.sessao);
    expect(mensagemParaOperador({ message: "invalid claim: missing sub claim" })).toBe(FRASES.sessao);
  });
});

describe("mensagemParaOperador — idioma", () => {
  it("em espanhol sai a linha `es` do dicionário, não o português", () => {
    const frase = mensagemParaOperador(CRU, "es");

    expect(frase).toBe(DICIONARIO[FRASES.cor_da_marca]?.es);
    expect(frase).not.toBe(FRASES.cor_da_marca);
  });

  it("a genérica também tem espanhol", () => {
    expect(mensagemParaOperador({ code: "XX000" }, "es")).toBe(DICIONARIO[FRASES.generica]?.es);
  });
});

describe("as frases moram no dicionário (cerca de i18n)", () => {
  it("toda frase do mapeador tem `es` — frase nova sem tradução reprova aqui", () => {
    const semEspanhol = Object.values(FRASES).filter((frase) => !DICIONARIO[frase]?.es);

    expect(semEspanhol).toEqual([]);
  });
});

describe("respostaParaOperador — o cru vai para o log, e só para lá", () => {
  it("devolve a frase do operador e registra código, detalhe e dica no log", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resposta = respostaParaOperador(CRU, {
      contexto: "[teste] falha ao gravar",
      campos: { organization_id: "org-1" },
    });

    expect(resposta.ok).toBe(false);
    expect(resposta.error).toBe(FRASES.cor_da_marca);
    naoVaza(resposta.error, CRU);

    // O log carrega o texto INTEIRO: é onde alguém consegue agir sobre ele.
    expect(log).toHaveBeenCalledTimes(1);
    const linha = String(log.mock.calls[0]?.[0] ?? "");
    expect(linha).toContain("[teste] falha ao gravar");
    expect(linha).toContain("platform_branding_accent_hex");
    expect(linha).toContain('"code":"23514"');
    expect(linha).toContain("org-1");
  });

  it("o objeto devolvido não carrega `details` nem o corpo do Postgres", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resposta = respostaParaOperador(CRU, { contexto: "[teste] falha ao gravar" });

    expect(Object.keys(resposta).sort()).toEqual(["error", "ok"]);
    const serializado = JSON.stringify(resposta);
    for (const proibido of VAZAMENTOS) expect(serializado).not.toContain(proibido);
    expect(serializado).not.toContain("Failing row contains");
  });
});

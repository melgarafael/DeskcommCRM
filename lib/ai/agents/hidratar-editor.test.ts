import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  escolherCredencialParaEditor,
  escolherModeloParaEditor,
  modeloNudeDoCadastro,
  type CredencialParaEditor,
  type ModeloDoCatalogo,
} from "./hidratar-editor";

const CATALOGO: ModeloDoCatalogo[] = [
  {
    provider: "anthropic",
    model_id: "claude-sonnet-5",
    is_default_for_provider: true,
  },
  {
    provider: "anthropic",
    model_id: "claude-sonnet-4-6",
    is_default_for_provider: false,
  },
  {
    provider: "anthropic",
    model_id: "claude-haiku-4-5",
    is_default_for_provider: false,
  },
  {
    provider: "openai",
    model_id: "gpt-4o",
    is_default_for_provider: true,
  },
];

const CREDENCIAL: CredencialParaEditor = {
  id: "3bf5adaf-0000-4000-8000-000000000001",
  provider: "anthropic",
  is_active: true,
  validated_at: "2026-09-13T12:00:00.000Z",
};

describe("modeloNudeDoCadastro", () => {
  it("remove só o prefixo do provedor", () => {
    expect(modeloNudeDoCadastro("anthropic/claude-sonnet-4-6", "anthropic")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("não mexe em id já nu", () => {
    expect(modeloNudeDoCadastro("claude-sonnet-4-6", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("não tira prefixo de outro provedor", () => {
    expect(modeloNudeDoCadastro("openai/gpt-4o", "anthropic")).toBe("openai/gpt-4o");
  });
});

describe("escolherModeloParaEditor — sem versão", () => {
  it("hidrata o modelo a partir de ai_agents.model", () => {
    expect(
      escolherModeloParaEditor({
        cadastroModel: "anthropic/claude-sonnet-4-6",
        provider: "anthropic",
        catalogo: CATALOGO,
      }),
    ).toBe("claude-sonnet-4-6");
  });

  it("a versão gravada vence o cadastro", () => {
    expect(
      escolherModeloParaEditor({
        versionModel: "claude-haiku-4-5",
        cadastroModel: "anthropic/claude-sonnet-4-6",
        provider: "anthropic",
        catalogo: CATALOGO,
      }),
    ).toBe("claude-haiku-4-5");
  });

  it("cai no default ativo do provedor quando o cadastro não está no catálogo", () => {
    expect(
      escolherModeloParaEditor({
        cadastroModel: "anthropic/claude-que-nao-existe",
        provider: "anthropic",
        catalogo: CATALOGO,
      }),
    ).toBe("claude-sonnet-5");
  });

  it("ignora modelo depreciado do catálogo", () => {
    expect(
      escolherModeloParaEditor({
        cadastroModel: "anthropic/claude-antigo",
        provider: "anthropic",
        catalogo: [
          {
            provider: "anthropic",
            model_id: "claude-antigo",
            is_default_for_provider: false,
            deprecated_at: "2026-01-01T00:00:00Z",
          },
          {
            provider: "anthropic",
            model_id: "claude-sonnet-5",
            is_default_for_provider: true,
          },
        ],
      }),
    ).toBe("claude-sonnet-5");
  });
});

describe("escolherCredencialParaEditor", () => {
  it("pré-seleciona a única credencial ativa e validada do provedor", () => {
    expect(
      escolherCredencialParaEditor({
        versionExists: false,
        tokenInstalacao: "__instalacao__",
        provider: "anthropic",
        credenciais: [CREDENCIAL],
      }),
    ).toBe(CREDENCIAL.id);
  });

  it("não escolhe no chute quando há duas validadas", () => {
    expect(
      escolherCredencialParaEditor({
        versionExists: false,
        tokenInstalacao: "__instalacao__",
        provider: "anthropic",
        credenciais: [
          CREDENCIAL,
          { ...CREDENCIAL, id: "aaaaaaaa-0000-4000-8000-000000000002" },
        ],
      }),
    ).toBe("");
  });

  it("não pré-seleciona credencial ainda não validada", () => {
    expect(
      escolherCredencialParaEditor({
        versionExists: false,
        tokenInstalacao: "__instalacao__",
        provider: "anthropic",
        credenciais: [{ ...CREDENCIAL, validated_at: null }],
      }),
    ).toBe("");
  });

  it("com versão, null no banco vira o token da instalação", () => {
    expect(
      escolherCredencialParaEditor({
        versionExists: true,
        versionCredentialId: null,
        tokenInstalacao: "__instalacao__",
        provider: "anthropic",
        credenciais: [CREDENCIAL],
      }),
    ).toBe("__instalacao__");
  });
});

describe("nenhuma chave ou segredo viaja neste módulo", () => {
  it("o fonte não lê coluna cifrada nem loga segredo", () => {
    const fonte = readFileSync(join(__dirname, "hidratar-editor.ts"), "utf8");
    expect(fonte).not.toMatch(/api_key_encrypted|ciphertext|encrypted_key|sk-ant-|sk-proj-/);
    expect(fonte).not.toMatch(/console\.(log|info|debug|error)/);
  });

  it("a 1ª publicação só seleciona o id da credencial, nunca o cifrado", () => {
    const fonte = readFileSync(join(__dirname, "first-publication.ts"), "utf8");
    expect(fonte).toMatch(/\.from\("ai_provider_credentials"\)[\s\S]{0,80}\.select\("id"\)/);
    expect(fonte).not.toMatch(/api_key_encrypted|ciphertext|encrypted_key|sk-ant-|sk-proj-/);
  });

  it("CredencialParaEditor só tem o recorte visível da view safe", () => {
    const amostra: CredencialParaEditor = {
      id: "id",
      provider: "anthropic",
      is_active: true,
      validated_at: null,
    };
    expect(Object.keys(amostra).sort()).toEqual(
      ["id", "is_active", "provider", "validated_at"].sort(),
    );
  });
});

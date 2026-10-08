/**
 * O PAR (PROVEDOR, MODELO) SE CONFERE ANTES DE SAIR BYTE — issue #2377.
 *
 * A issue abre com um par legado: `{provider: 'openai',
 * default_model: 'claude-sonnet-5'}`. O gatilho `fn_seed_org_llm_defaults`
 * semeava o par da Anthropic e o instalador antigo trocava só o provedor, então
 * a empresa ficava em OpenAI no painel e um caminho específico (mídia,
 * classificação, leitura) resolvia um modelo Claude — que ia para o endpoint da
 * OpenAI e falhava sozinho, com retry, sem log de causa.
 *
 * Este arquivo mede a RÉGUA em si: o que ela recusa (é o defeito), o que ela
 * deixa passar (recusa errada é pior que a faltante) e o que ela afirma como
 * compatibilidade explícita (item (c) da issue: agregador serve qualquer id).
 *
 * Os quatro itens que a issue pede classificar ficam marcados aqui como
 * `[a]`, `[b]`, `[c]` e `[d]`, com o teste que prova cada um.
 */
import { describe, expect, it } from "vitest";

import {
  ParProvedorModeloInvalidoError,
  provedorNaturalDoModelo,
  validarParProvedorModelo,
} from "@/lib/ai/par-provedor-modelo";

function motivoDe(provider: string, model: string): string {
  const r = validarParProvedorModelo(provider, model);
  expect(r.valido).toBe(false);
  return r.valido ? "" : r.motivo;
}

describe("par provedor+modelo: o que é RECUSADO", () => {
  it("[a] openai + claude-sonnet-5 — o default silencioso da Anthropic no provedor errado", () => {
    // É literalmente o par da issue: id BARE da Anthropic, endereço da OpenAI.
    const motivo = motivoDe("openai", "claude-sonnet-5");
    expect(motivo).toContain('"anthropic"');
    expect(motivo).toContain('"openai"');
    // O motivo é mensagem de erro do usuário final da tela — em PT-BR.
    expect(motivo).toMatch(/provedor/);
    expect(motivo).not.toMatch(/[a-z]+_[a-z]+_[a-z]+/);
  });

  it("[a] openai + anthropic/claude-haiku-4-5 — a rota do id denuncia o dono", () => {
    const motivo = motivoDe("openai", "anthropic/claude-haiku-4-5");
    expect(motivo).toContain("anthropic");
    expect(motivo).toContain("openai");
  });

  it("[a] openai + openai/claude-sonnet-5 — a rota bate, o NOME não: é o par legado", () => {
    // O degrau `oGravado` de `padraoDaOrganizacao` montava exatamente isto
    // quando o catálogo não conseguia consertar o par lido.
    const r = validarParProvedorModelo("openai", "openai/claude-sonnet-5");
    expect(r.valido).toBe(false);
    if (!r.valido) expect(r.motivo).toContain("família");
  });

  it("[a] google e anthropic recusam um id da família trocada", () => {
    expect(validarParProvedorModelo("google", "claude-sonnet-5").valido).toBe(false);
    expect(validarParProvedorModelo("anthropic", "gpt-5-mini").valido).toBe(false);
    expect(validarParProvedorModelo("anthropic", "openai/gpt-5-mini").valido).toBe(false);
    expect(validarParProvedorModelo("deepseek", "gemini-2.5-flash").valido).toBe(false);
  });

  it("[b] sem provedor ou sem modelo não há endereço — recusa explícita, não fallback", () => {
    const semProvedor = motivoDe("", "claude-sonnet-5");
    expect(semProvedor).toContain("vazio");
    const semModelo = motivoDe("openai", "");
    expect(semModelo).toContain("modelo nenhum");
    // Antes disto, `createOpenAI({apiKey})(\"\")` virava um 400 do provedor.
    expect(validarParProvedorModelo(null, null).valido).toBe(false);
  });

  it("o nome da recusa carrega os dois lados do par", () => {
    const motivo = motivoDe("openai", "claude-sonnet-5");
    expect(motivo).toContain("claude-sonnet-5");
    expect(motivo).toContain("anthropic");
    expect(motivo).toContain("openai");
  });
});

describe("par provedor+modelo: o que NÃO é recusado (recusa errada calaria produto)", () => {
  it("[c] openrouter serve qualquer fabricante — o prefixo É a rota lá", () => {
    expect(validarParProvedorModelo("openrouter", "anthropic/claude-sonnet-5").valido).toBe(true);
    expect(validarParProvedorModelo("openrouter", "openai/gpt-5-mini").valido).toBe(true);
    expect(validarParProvedorModelo("openrouter", "meta-llama/llama-3.3-70b-instruct").valido).toBe(true);
    expect(validarParProvedorModelo("openrouter", "claude-sonnet-5").valido).toBe(true);
  });

  it("[c] requesty e provedor personalizado são agregadores pelo mesmo motivo", () => {
    expect(validarParProvedorModelo("requesty", "anthropic/claude-haiku-4-5").valido).toBe(true);
    expect(validarParProvedorModelo("custom", "openai/gpt-5-mini").valido).toBe(true);
  });

  it("o id com rota própria executa naquele provedor mesmo com outra org", () => {
    // A issue diz para validar o par que SAI, não a preferência do painel.
    expect(validarParProvedorModelo("anthropic", "openai/gpt-5-mini").valido).toBe(false);
    // …mas este par, com a OpenAI no endereço, é coerente:
    expect(validarParProvedorModelo("openai", "openai/gpt-5-mini").valido).toBe(true);
  });

  it("cada provedor direto executa os próprios ids, com e sem prefixo", () => {
    expect(validarParProvedorModelo("anthropic", "anthropic/claude-haiku-4-5").valido).toBe(true);
    expect(validarParProvedorModelo("anthropic", "claude-haiku-4-5").valido).toBe(true);
    expect(validarParProvedorModelo("openai", "gpt-5.6-terra").valido).toBe(true);
    expect(validarParProvedorModelo("openai", "openai/gpt-5.6-terra").valido).toBe(true);
    expect(validarParProvedorModelo("google", "google/gemini-2.5-flash").valido).toBe(true);
    expect(validarParProvedorModelo("deepseek", "deepseek-chat").valido).toBe(true);
  });

  it("a assinatura (#1672) executa os ids da OpenAI e recusa os de outro fabricante", () => {
    expect(validarParProvedorModelo("openai-assinatura", "gpt-5").valido).toBe(true);
    expect(validarParProvedorModelo("openai-assinatura", "openai/gpt-5").valido).toBe(true);
    expect(validarParProvedorModelo("openai-assinatura", "claude-sonnet-5").valido).toBe(false);
  });

  it("id de família que a régua não conhece passa — sem prova, não se recusa", () => {
    // Whisper, embeddings do Google, modelos futuros de terceiros: ninguém aqui
    // pode afirmar que `whisper-1` não é da OpenAI.
    expect(validarParProvedorModelo("openai", "whisper-1").valido).toBe(true);
    expect(validarParProvedorModelo("google", "text-embedding-004").valido).toBe(true);
    expect(validarParProvedorModelo("openai", "4o-mini-transcribe").valido).toBe(true);
  });

  it("provedor que o produto não conhece passa — quem o cadastrou é que sabe", () => {
    expect(validarParProvedorModelo("provedor-que-nao-existe", "claude-sonnet-5").valido).toBe(true);
    expect(validarParProvedorModelo("gateway", "anthropic/claude-sonnet-5").valido).toBe(true);
    expect(validarParProvedorModelo("proxy-antigo", "qualquer/coisa").valido).toBe(true);
  });
});

describe("provedorNaturalDoModelo — o que a régua AFIRMA sobre um id", () => {
  it("prefixo de fabricante conhecido", () => {
    expect(provedorNaturalDoModelo("anthropic/claude-haiku-4-5")).toBe("anthropic");
    expect(provedorNaturalDoModelo("openai/gpt-5-mini")).toBe("openai");
    expect(provedorNaturalDoModelo("google/gemini-2.5-flash")).toBe("google");
  });

  it("nome BARE pela família", () => {
    expect(provedorNaturalDoModelo("claude-sonnet-5")).toBe("anthropic");
    expect(provedorNaturalDoModelo("gpt-5.6-terra")).toBe("openai");
    expect(provedorNaturalDoModelo("deepseek-chat")).toBe("deepseek");
    expect(provedorNaturalDoModelo("gemini-2.5-pro")).toBe("google");
  });

  it("sem provas, devolve null em vez de chutar", () => {
    expect(provedorNaturalDoModelo("meta-llama/llama-3.3-70b-instruct")).toBeNull();
    expect(provedorNaturalDoModelo("whisper-1")).toBeNull();
    expect(provedorNaturalDoModelo("")).toBeNull();
  });
});

describe("ParProvedorModeloInvalidoError — a mensagem que chega à tela", () => {
  it("carrega provedor, modelo, propósito e o motivo pronto", () => {
    const erro = new ParProvedorModeloInvalidoError(
      "openai",
      "claude-sonnet-5",
      "o modelo pertence ao provedor anthropic",
      "sentiment_classify",
    );
    expect(erro.name).toBe("ParProvedorModeloInvalidoError");
    expect(erro.provider).toBe("openai");
    expect(erro.model).toBe("claude-sonnet-5");
    expect(erro.message).toContain("sentiment_classify");
    expect(erro.message).toContain("Nenhuma chamada foi feita");
    // Diz o que o operador faz em seguida, não só o que deu errado.
    expect(erro.message).toContain("Agente de IA");
    expect(erro.message).toContain("o par tem de ser do mesmo provedor");
  });

  it("sem propósito nomeado, a mensagem continua coerente", () => {
    const erro = new ParProvedorModeloInvalidoError("openai", "claude-sonnet-5", "motivo aqui");
    expect(erro.message).not.toContain("no ponto");
    expect(erro.message).toContain("motivo aqui");
  });
});

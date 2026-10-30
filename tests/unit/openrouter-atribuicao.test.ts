/**
 * A catraca de marca (`branding.test.ts`) casa `/deskcomm/i` e é CEGA para host
 * de terceiro: removendo só o `X-Title`, um `HTTP-Referer` com domínio pessoal
 * passaria verde. Foi o que quase entrou pelo PR #266 — o domínio do próprio
 * contribuidor viajaria dentro da imagem que todo self-hoster instala,
 * creditando o consumo de OpenRouter de cada cliente a um site que não é dele.
 *
 * Este arquivo guarda o COMPORTAMENTO (de onde os cabeçalhos saem), não a
 * ausência de uma string: o teste que só procura `murilloalves` no fonte não
 * pegaria o próximo domínio.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cabecalhosDeAtribuicaoOpenRouter } from "@/lib/agent-engine/edge/llm/providers";

const ANTES = {
  url: process.env.OPENROUTER_APP_URL,
  titulo: process.env.OPENROUTER_APP_TITLE,
};

beforeEach(() => {
  delete process.env.OPENROUTER_APP_URL;
  delete process.env.OPENROUTER_APP_TITLE;
});

afterEach(() => {
  if (ANTES.url === undefined) delete process.env.OPENROUTER_APP_URL;
  else process.env.OPENROUTER_APP_URL = ANTES.url;
  if (ANTES.titulo === undefined) delete process.env.OPENROUTER_APP_TITLE;
  else process.env.OPENROUTER_APP_TITLE = ANTES.titulo;
});

describe("atribuição da OpenRouter sai da instalação, nunca do código", () => {
  it("sem env, NENHUM cabeçalho é enviado", () => {
    // Falha aberta na informação: a ausência de atribuição não quebra a chamada
    // (a doc da OpenRouter chama os dois de opcionais), então o padrão é calar.
    expect(cabecalhosDeAtribuicaoOpenRouter()).toBeUndefined();
  });

  it("só espaço em branco conta como vazio", () => {
    process.env.OPENROUTER_APP_URL = "   ";
    process.env.OPENROUTER_APP_TITLE = "\t";
    expect(cabecalhosDeAtribuicaoOpenRouter()).toBeUndefined();
  });

  it("com env, os cabeçalhos saem com o valor de QUEM INSTALOU", () => {
    process.env.OPENROUTER_APP_URL = "https://crm.exemplo.com.br";
    process.env.OPENROUTER_APP_TITLE = "CRM da Exemplo";
    expect(cabecalhosDeAtribuicaoOpenRouter()).toEqual({
      "HTTP-Referer": "https://crm.exemplo.com.br",
      "X-Title": "CRM da Exemplo",
    });
  });

  it("um sem o outro é válido — quem preenche só o título não ganha Referer", () => {
    process.env.OPENROUTER_APP_TITLE = "CRM da Exemplo";
    expect(cabecalhosDeAtribuicaoOpenRouter()).toEqual({ "X-Title": "CRM da Exemplo" });
  });

  it("nenhum dos caminhos de OpenRouter carrega host ou marca literal", () => {
    // Os call sites de OPENROUTER_ENDPOINT no repositório. O #266 tocava
    // dois e esquecia o terceiro (a prova de crédito da instalação) — que é a
    // evidência de que os cabeçalhos são atribuição e não requisito: ele
    // funciona hoje sem eles. O #3382 acrescenta o quarto: a escada de
    // transcrição, que fala com a OpenRouter pela mesma atribuição.
    const arquivos = [
      "lib/agent-engine/edge/llm/providers.ts",
      "lib/ai/runtime/agent.ts",
      "lib/instalacao/prova-de-credito.ts",
      "lib/messaging/media/escada-de-transcricao.ts",
    ];
    for (const rel of arquivos) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fonte = require("node:fs").readFileSync(rel, "utf8") as string;
      const literais = fonte.match(/["'](?:HTTP-Referer|X-Title)["']\s*:\s*["'][^"']+["']/g) ?? [];
      expect(literais, `${rel} não pode fixar HTTP-Referer/X-Title no código`).toEqual([]);
    }
  });
});

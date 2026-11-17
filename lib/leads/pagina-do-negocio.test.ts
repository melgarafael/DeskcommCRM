// lib/leads/pagina-do-negocio.test.ts
import { describe, expect, it } from "vitest";

import { hrefDaPaginaDoNegocio, hrefDeVoltar } from "./pagina-do-negocio";

/**
 * OS DOIS ENDEREÇOS DA PÁGINA DO NEGÓCIO (#4151).
 *
 * O defeito que estes casos cobrem não é de tela: é de NAVEGAÇÃO. "Expandir"
 * sem a URL de origem devolve a pessoa a um quadro sem filtro; "Voltar" aceitando
 * qualquer coisa é redirect aberto com a marca do produto.
 */

describe("hrefDaPaginaDoNegocio", () => {
  it("leva à página do negócio e guarda a URL do quadro COM o filtro", () => {
    const href = hrefDaPaginaDoNegocio(
      "lead-1",
      "/app/pipelines/funil-1",
      "tag=quente&status=open&visao=lista&lead=lead-1",
    );
    const url = new URL(href, "https://app.exemplo");
    // Caminho PRÓPRIO: `/app/leads/lead-1` puro segue sendo o link estável que
    // abre o quadro com o painel.
    expect(url.pathname).toBe("/app/leads/lead-1/pagina");
    // O filtro INTEIRO vive no `voltar` — é ele que o quadro vai reler.
    expect(url.searchParams.get("voltar")).toBe(
      "/app/pipelines/funil-1?tag=quente&status=open&visao=lista",
    );
  });

  it("tira o `lead=` do voltar: voltar não reabre o painel que acabou de ser expandido", () => {
    const href = hrefDaPaginaDoNegocio("lead-1", "/app/pipelines/funil-1", "lead=lead-1");
    const url = new URL(href, "https://app.exemplo");
    expect(url.searchParams.get("voltar")).toBe("/app/pipelines/funil-1");
  });

  it("quadro sem filtro nenhum continua sendo um voltar válido", () => {
    const href = hrefDaPaginaDoNegocio("lead-1", "/app/pipelines/funil-1", new URLSearchParams());
    const url = new URL(href, "https://app.exemplo");
    expect(url.searchParams.get("voltar")).toBe("/app/pipelines/funil-1");
  });
});

describe("hrefDeVoltar", () => {
  it("devolve o quadro de origem, com o filtro, quando é a tela do quadro", () => {
    expect(hrefDeVoltar("/app/pipelines/funil-1?tag=quente", "funil-1")).toBe(
      "/app/pipelines/funil-1?tag=quente",
    );
  });

  it("sem `voltar` (link direto), cai no quadro DESTE negócio", () => {
    expect(hrefDeVoltar(undefined, "funil-9")).toBe("/app/pipelines/funil-9");
    expect(hrefDeVoltar(null, "funil-9")).toBe("/app/pipelines/funil-9");
  });

  it("recusa destino que não é a tela do quadro — nada de redirect aberto", () => {
    for (const adulterado of [
      "https://exemplo.invalido/app/pipelines/funil-1",
      "//exemplo.invalido/app/pipelines/funil-1",
      "/app/inbox?id=1",
      "/app/pipelines/../../admin",
    ]) {
      expect(hrefDeVoltar(adulterado, "funil-9"), adulterado).toBe("/app/pipelines/funil-9");
    }
  });
});

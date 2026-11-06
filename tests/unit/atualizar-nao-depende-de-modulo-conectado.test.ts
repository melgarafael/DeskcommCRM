import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ATUALIZAR O CRM NUNCA DEPENDE DE MÓDULO CONECTADO (Spec 33, F6; ADR-0005 escolha 2).
 *
 * Um módulo conectado vive em outro serviço, na rede de outra pessoa. Se `update.sh` (ou qualquer
 * script do kit de instalação) consultasse o módulo, a tabela dele ou a rota dele, um serviço fora do
 * ar travaria a atualização de uma VPS inteira. A garantia é esta: nenhum script do kit chega a
 * nenhum desses pontos.
 *
 * O que ESTE teste mede: varredura de TEXTO dos scripts do kit (`hostgator-setup-kit/`), à procura de
 * qualquer ponto de contato com módulo conectado. O que NÃO mede: executar `update.sh` com um
 * serviço derrubado. Quem cobra isso é o fato de o script não ter caminho até o módulo, que é o que
 * se varre aqui.
 *
 * Sabotagem prevista: acrescentar a `update.sh` uma chamada a `/api/v1/extensions/...`, a
 * `extension_installations` ou a `service_origin` deixa o caso "nenhum script do kit" vermelho (1).
 */

const RAIZ = path.resolve(__dirname, "../..");
const KIT = path.join(RAIZ, "hostgator-setup-kit");

/** Pontos de contato com módulo conectado: tabelas, rota de token/eventos, cabeçalho assinado, origem. */
const PONTOS_DE_CONTATO: ReadonlyArray<{ nome: string; padrao: RegExp }> = [
  { nome: "origem do serviço do módulo", padrao: /service_origin/i },
  { nome: "tabela de instalações de extensão", padrao: /extension_installations/i },
  { nome: "tabela de ativações de extensão", padrao: /organization_extensions/i },
  { nome: "tabelas de eventos/cursor do módulo", padrao: /extension_module_(events|cursors)/i },
  { nome: "tabela de segredo do módulo", padrao: /extension_installation_secrets/i },
  { nome: "rota de extensões da API", padrao: /api\/v1\/extensions/i },
  { nome: "cabeçalho assinado do módulo", padrao: /x-module-(installation|organization|signature|context)/i },
  { nome: "código de módulo fora da faixa", padrao: /module_incompatible/i },
];

function pontosDeContato(texto: string): string[] {
  return PONTOS_DE_CONTATO.filter((p) => p.padrao.test(texto)).map((p) => p.nome);
}

function arquivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivos(p);
    return /\.(sh|yml|yaml|conf|env|example)$/.test(e.name) || !e.name.includes(".") ? [p] : [];
  });
}

describe("atualizar o CRM não depende de módulo conectado", () => {
  it("o kit existe e a varredura enxerga o update.sh (guarda de vacuidade)", () => {
    expect(existsSync(KIT)).toBe(true);
    const lista = arquivos(KIT).map((p) => path.relative(KIT, p).replaceAll("\\", "/"));
    expect(lista).toContain("update.sh");
    expect(lista).toContain("_common.sh");
    expect(lista.length).toBeGreaterThan(8);
    expect(statSync(path.join(KIT, "update.sh")).size).toBeGreaterThan(1000);
  });

  it("a varredura de fato reconhece cada ponto de contato (senão o caso abaixo mede o nada)", () => {
    expect(pontosDeContato("curl https://x/api/v1/extensions/token")).toEqual(["rota de extensões da API"]);
    expect(pontosDeContato("select service_origin from extension_installations")).toEqual([
      "origem do serviço do módulo",
      "tabela de instalações de extensão",
    ]);
    expect(pontosDeContato('-H "X-Module-Signature: abc"')).toEqual(["cabeçalho assinado do módulo"]);
    expect(pontosDeContato("docker compose up -d app")).toEqual([]);
  });

  it("nenhum script do kit de instalação toca tabela, rota, cabeçalho ou origem de módulo conectado", () => {
    const achados = arquivos(KIT).flatMap((p) => {
      const pontos = pontosDeContato(readFileSync(p, "utf8"));
      return pontos.map((nome) => `${path.relative(KIT, p).replaceAll("\\", "/")}: ${nome}`);
    });
    expect(achados).toEqual([]);
  });
});

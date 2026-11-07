import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MODELOS_DE_PORTA, caminhoDoModelo, type ModeloDePorta } from "@/lib/auth/portas-de-token";
import { isPublicPath } from "@/lib/auth/public-paths";

/**
 * ROTA COM TOKEN TEM PORTA NO PROXY (Spec 33, fatia R0).
 *
 * `resolveAuthDual` aceita o Bearer `dsk_…` DENTRO da rota, mas o `proxy.ts`
 * decide antes dela: caminho fora de `PUBLIC_PATHS` sem cookie leva 401, e o
 * ramo do token fica inalcançável com todos os testes do handler verdes. Foi o
 * estado de `agenda/servicos/atualizar`, `conversations/[id]/drafts/consume` e
 * `conversations/[id]/notes/media` até esta cerca.
 *
 * A varredura é VIVA, na forma de `rotas-bearer-aplicam-teto-de-escrita.test.ts`:
 * lê toda `route.ts` de `app/api/v1/`. Rota nova que chame `resolveAuthDual`
 * sem porta reprova aqui, salvo justificativa escrita em `SO_SESSAO_POR_DESENHO`.
 * O inverso também: modelo de porta em `lib/auth/portas-de-token/` sem rota
 * que aceite token é porta aberta à toa, e reprova.
 */
const RAIZ = process.cwd();
const BASE = path.join(RAIZ, "app/api/v1");

/**
 * Rotas que chamam `resolveAuthDual` e, por desenho, continuam só de sessão.
 * Cada entrada precisa de motivo escrito. Não entram em `PUBLIC_PATHS`.
 */
export const SO_SESSAO_POR_DESENHO: Record<string, string> = {
  "app/api/v1/prospecting/importar/route.ts":
    "recusa token de propósito (403), como reanalisar_site; ver o comentário da rota",
};

const UUID_DE_AMOSTRA = "00000000-0000-4000-8000-000000000000";

function modeloDaPasta(pasta: string): ModeloDePorta | undefined {
  return MODELOS_DE_PORTA.find((m) => caminhoDoModelo(m) === pasta);
}

/**
 * `app/api/v1/a/[id]/b/route.ts` → `/api/v1/a/<uuid>/b`. Segmento declarado num
 * modelo de porta usa a amostra do modelo; os outros viram UUID.
 */
export function caminhoDaRota(rel: string): string {
  const pasta = "/" + rel.replace(/\\/g, "/").replace(/^app\//, "").replace(/\/route\.ts$/, "");
  const modelo = modeloDaPasta(pasta);
  const amostras = modelo && typeof modelo !== "string" ? modelo.amostras : {};
  return pasta
    .split("/")
    .map((parte) => {
      const dinamico = /^\[(?:\.\.\.)?(.+)\]$/.exec(parte);
      if (!dinamico) return parte;
      const nome = dinamico[1] ?? "";
      return amostras[nome] ?? UUID_DE_AMOSTRA;
    })
    .join("/");
}

const rotasBearer = (readdirSync(BASE, { recursive: true }) as string[])
  .filter((rel) => path.basename(rel) === "route.ts")
  .map((rel) => path.posix.join("app/api/v1", rel.split(path.sep).join("/")))
  .filter((rel) => readFileSync(path.join(RAIZ, rel), "utf8").includes("resolveAuthDual("))
  .sort();

describe("rotas com resolveAuthDual têm porta no proxy", () => {
  it("a varredura acha as rotas (controle de vacuidade)", () => {
    // Piso, não igualdade: 26 rotas chamavam resolveAuthDual quando a cerca
    // nasceu. Rota nova não deve exigir editar este número.
    expect(rotasBearer.length).toBeGreaterThanOrEqual(20);
  });

  it("caminhoDaRota monta o caminho que o proxy vê", () => {
    expect(caminhoDaRota("app/api/v1/conversations/[id]/drafts/consume/route.ts")).toBe(
      `/api/v1/conversations/${UUID_DE_AMOSTRA}/drafts/consume`,
    );
    expect(caminhoDaRota("app/api/v1/agenda/servicos/atualizar/route.ts")).toBe(
      "/api/v1/agenda/servicos/atualizar",
    );
  });

  it.each(rotasBearer.filter((rel) => !(rel in SO_SESSAO_POR_DESENHO)))("%s tem porta no proxy", (rel) => {
    expect(
      isPublicPath(caminhoDaRota(rel)),
      `${rel}: chama resolveAuthDual mas o proxy recusa o token antes do handler — acrescente a porta (lib/auth/portas-de-token/) ou justifique em SO_SESSAO_POR_DESENHO`,
    ).toBe(true);
  });

  it.each(Object.entries(SO_SESSAO_POR_DESENHO))("%s segue só de sessão por desenho (%s)", (rel) => {
    expect(readFileSync(path.join(RAIZ, rel), "utf8"), `${rel} não chama mais resolveAuthDual: tire da lista`).toContain(
      "resolveAuthDual(",
    );
    expect(isPublicPath(caminhoDaRota(rel)), `${rel} tem porta: a justificativa mente`).toBe(false);
  });
});

describe("modelos de porta de token", () => {
  const caminhos = MODELOS_DE_PORTA.map(caminhoDoModelo);

  it("a lista de modelos é lida", () => {
    expect(Array.isArray(MODELOS_DE_PORTA)).toBe(true);
  });

  it("nenhum modelo de porta se repete", () => {
    expect(caminhos.filter((c, i) => caminhos.indexOf(c) !== i)).toEqual([]);
  });

  it("toda porta tem rota com token", () => {
    const semRota = caminhos.filter((c) => {
      const arquivo = path.join(RAIZ, "app", ...c.split("/").filter(Boolean), "route.ts");
      return !existsSync(arquivo) || !readFileSync(arquivo, "utf8").includes("resolveAuthDual(");
    });
    expect(semRota, "porta sem rota com token: tire o modelo ou converta a rota").toEqual([]);
  });
});

describe("PUBLIC_PATHS — as portas da R0", () => {
  const UUID = UUID_DE_AMOSTRA;

  it.each([
    "/api/v1/agenda/servicos/atualizar",
    `/api/v1/conversations/${UUID}/drafts/consume`,
    `/api/v1/conversations/${UUID}/notes/media`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    "/api/v1/agenda/servicos/atualizar/x",
    "/api/v1/conversations/abc/drafts/consume",
    `/api/v1/conversations/${UUID}/drafts/consume/x`,
    "/api/v1/conversations/abc/notes/media",
    `/api/v1/conversations/${UUID}/notes/media/x`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("notas da conversa passaram a aceitar token", () => {
    // Spec 33 (R2): a rota passou a aceitar token
    expect(isPublicPath(`/api/v1/conversations/${UUID}/notes`)).toBe(true);
  });

  it("os irmãos de nível seguem como estavam", () => {
    expect(isPublicPath("/api/v1/agenda/servicos")).toBe(true);
    expect(isPublicPath(`/api/v1/conversations/${UUID}/drafts`)).toBe(true);
  });
});

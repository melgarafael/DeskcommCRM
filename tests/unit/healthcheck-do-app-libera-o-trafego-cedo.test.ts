/**
 * A checagem de saúde do app libera o tráfego CEDO depois de uma atualização,
 * sem perder a tolerância a falha e sem subir a versão mínima do Compose.
 *
 * Atrás do Traefik da hospedagem (`docker-compose.traefik.yml`), o tráfego só
 * vai a contêiner `healthy`. Com Docker 24 ou mais antigo e `interval: 30s`, o
 * app ficava pronto em ~5 s e o domínio seguia em "404 page not found" por
 * 30–45 s a cada atualização (medido numa instalação real em 24/09/2026).
 * Com Docker 25 ou mais novo a janela já era de ~5 s; o Caddy padrão do kit
 * não consulta a saúde.
 * Conserto de @jmpo (PR #3393).
 *
 * Três réguas, cada uma com o seu motivo:
 *  1. `interval` de no máximo 10 s — é a janela de 404 depois do `up -d`;
 *  2. `interval × retries` de pelo menos 150 s — a tolerância de antes
 *     (30 s × 5) para declarar o app doente; encurtá-la derrubaria o tráfego
 *     num soluço do Node;
 *  3. sem `start_interval` — o Compose 2.17 recusa o arquivo inteiro com essa
 *     chave ("Additional property start_interval is not allowed"), e o kit só
 *     exige "docker compose v2".
 *
 * Sem parser YAML de propósito: nenhum está nas dependências (ver o cabeçalho
 * de `acolhida-nao-toca-no-fork.test.ts`). O recorte é por indentação, que é
 * como o próprio arquivo é escrito.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const COMPOSE = readFileSync(join(process.cwd(), "docker-compose.prod.yml"), "utf8").split("\n");

/** As linhas do serviço `app` (de `  app:` até o próximo serviço de 2 espaços). */
function blocoDoApp(): string[] {
  const inicio = COMPOSE.findIndex((l) => l === "  app:");
  if (inicio < 0) throw new Error("serviço app não encontrado em docker-compose.prod.yml");
  const fim = COMPOSE.findIndex((l, i) => i > inicio && /^ {2}[a-z][\w-]*:\s*$/.test(l));
  return COMPOSE.slice(inicio, fim < 0 ? undefined : fim);
}

/** As linhas do `healthcheck:` do app (as mais indentadas que ele). */
function healthcheckDoApp(): string[] {
  const app = blocoDoApp();
  const i = app.findIndex((l) => /^ {4}healthcheck:\s*$/.test(l));
  if (i < 0) throw new Error("o app não tem healthcheck");
  const resto = app.slice(i + 1);
  const fim = resto.findIndex((l) => l.trim() !== "" && !/^ {6}/.test(l));
  return resto.slice(0, fim < 0 ? undefined : fim).filter((l) => !l.trim().startsWith("#"));
}

function segundos(chave: string): number {
  const linha = healthcheckDoApp().find((l) => l.trim().startsWith(`${chave}:`));
  if (!linha) throw new Error(`healthcheck do app sem ${chave}`);
  const m = /:\s*(\d+)(s|m)?\s*$/.exec(linha);
  if (!m) throw new Error(`${chave} ilegível: ${linha.trim()}`);
  return Number(m[1]) * (m[2] === "m" ? 60 : 1);
}

function numero(chave: string): number {
  const linha = healthcheckDoApp().find((l) => l.trim().startsWith(`${chave}:`));
  if (!linha) throw new Error(`healthcheck do app sem ${chave}`);
  return Number(linha.split(":")[1]?.trim());
}

describe("healthcheck do app: o tráfego volta cedo depois de uma atualização", () => {
  it("pergunta a cada 10 s no máximo — é a janela de 404 depois do up -d", () => {
    expect(segundos("interval")).toBeLessThanOrEqual(10);
  });

  it("a tolerância para declarar o app doente continua em pelo menos 150 s", () => {
    expect(segundos("interval") * numero("retries")).toBeGreaterThanOrEqual(150);
  });

  it("não usa start_interval: o Compose 2.17 recusa o arquivo inteiro com essa chave", () => {
    expect(healthcheckDoApp().some((l) => l.trim().startsWith("start_interval:"))).toBe(false);
  });
});

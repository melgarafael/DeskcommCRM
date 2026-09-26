import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/**
 * `SUPABASE_DB_ADMIN_URL` é a conexão de DDL do KIT (issue #192): num Supabase
 * próprio ela é o DONO do banco, enquanto `SUPABASE_DB_URL` é a role menor que
 * o app usa — a separação inteira existe para que o app NÃO tenha esse poder.
 *
 * O `docker-compose.prod.yml` entrega o `.env` inteiro a todo serviço com
 * `env_file: .env` (`app`, `worker` e, com telefonia, `voice-agent`). Desde o
 * #1680 (item 2 da #289) cada um deles a sobrescreve com vazio no
 * `environment:` — a chave fica no arquivo para o kit no host e não chega ao
 * processo. São duas cercas, e este arquivo vigia as duas:
 *
 * 1. nenhum código do app nomeia a chave (se a neutralização sumir, um
 *    `env.SUPABASE_DB_ADMIN_URL` escrito por engano devolveria ao processo o
 *    privilégio que a issue tirou dele — sem erro nenhum, porque funciona);
 * 2. todo serviço do compose que recebe o `.env` a neutraliza — um serviço
 *    novo com `env_file` e sem a linha voltaria a receber a credencial calado.
 *
 * Comentário não reprova build; este arquivo reprova.
 */
const RAIZES = ["app", "components", "lib", "workers", "hooks"];
/** O único lugar que pode nomeá-la: a declaração do contrato de ambiente. */
const DECLARACAO = "lib/env.ts";

function arquivosVarridos(dir: string): string[] {
  const alvos: string[] = [];
  for (const entrada of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entrada.name);
    if (entrada.isDirectory()) alvos.push(...arquivosVarridos(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) alvos.push(rel);
  }
  return alvos;
}

describe("a conexão de DDL não vaza para o código do app", () => {
  const porRaiz = new Map(RAIZES.map((r) => [r, arquivosVarridos(r)]));
  const alvos = [...porRaiz.values()].flat();
  const citam = alvos.filter((f) =>
    fs.readFileSync(path.join(RAIZ, f), "utf8").includes("SUPABASE_DB_ADMIN_URL"),
  );

  it("a varredura alcança as cinco raízes e enxerga a chave onde ela está", () => {
    // Vacuidade em dois eixos: uma varredura que não descesse em lugar nenhum
    // devolveria a mesma lista vazia de infratores, e uma que descesse sem saber
    // procurar a string também. A declaração em lib/env.ts é o controle
    // positivo — se ela não aparecer, a sonda está cega e o resto não vale.
    for (const [raiz, arquivos] of porRaiz) {
      expect(arquivos.length, `${raiz}/ não devolveu arquivo nenhum`).toBeGreaterThan(0);
    }
    expect(citam).toContain(DECLARACAO);
  });

  it("nenhum arquivo além da declaração nomeia SUPABASE_DB_ADMIN_URL", () => {
    expect(citam.filter((f) => f !== DECLARACAO)).toEqual([]);
  });
});

/**
 * Parser dos blocos de serviço, no molde de `tests/unit/portas-do-compose.test.ts`.
 * Não é um parser de YAML: responde "este serviço declara X?" sem dependência
 * nova num gate. Linhas de comentário saem antes, para um `env_file` citado em
 * comentário não contar como declarado.
 */
function lerServicos(yaml: string): Map<string, string[]> {
  const servicos = new Map<string, string[]>();
  let dentroDeServices = false;
  let atual: string | null = null;
  for (const linha of yaml.split("\n")) {
    if (/^\s*#/.test(linha)) continue;
    if (/^services:\s*$/.test(linha)) {
      dentroDeServices = true;
      continue;
    }
    if (!dentroDeServices) continue;
    if (/^\S/.test(linha)) {
      dentroDeServices = false;
      continue;
    }
    const cabecalho = linha.match(/^ {2}([a-z0-9_-]+):\s*$/i);
    if (cabecalho) {
      atual = cabecalho[1] ?? null;
      if (atual) servicos.set(atual, []);
      continue;
    }
    if (atual) servicos.get(atual)?.push(linha);
  }
  return servicos;
}

/** As linhas do mapa `environment:` do serviço (indentação de 6+ espaços). */
function linhasDoEnvironment(bloco: string[]): string[] {
  const inicio = bloco.findIndex((l) => /^ {4}environment:\s*$/.test(l));
  if (inicio < 0) return [];
  const linhas: string[] = [];
  for (const linha of bloco.slice(inicio + 1)) {
    if (linha.trim() === "") continue;
    if (!/^ {6}/.test(linha)) break;
    linhas.push(linha);
  }
  return linhas;
}

describe("todo serviço que recebe o .env neutraliza a conexão do dono", () => {
  const servicos = lerServicos(fs.readFileSync(path.join(RAIZ, "docker-compose.prod.yml"), "utf8"));
  const recebemEnv = [...servicos].filter(([, bloco]) => bloco.some((l) => /^ {4}env_file:/.test(l)));

  it("a sonda enxerga os serviços que recebem o .env", () => {
    // Controle positivo: um parser cego devolveria zero serviços, e zero
    // serviços não têm infrator nenhum.
    expect(recebemEnv.map(([nome]) => nome)).toEqual(expect.arrayContaining(["app", "worker"]));
  });

  it("cada um sobrescreve SUPABASE_DB_ADMIN_URL com vazio no environment", () => {
    const semNeutralizar = recebemEnv
      .filter(([, bloco]) => !linhasDoEnvironment(bloco).some((l) => /^ {6}SUPABASE_DB_ADMIN_URL: ""\s*$/.test(l)))
      .map(([nome]) => nome);
    expect(semNeutralizar, 'serviço com env_file: .env sem `SUPABASE_DB_ADMIN_URL: ""` no environment').toEqual([]);
  });
});

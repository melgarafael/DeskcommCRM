import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TODA ROTA DE CRON EXISTE PARA SER CHAMADA POR ALGUÉM.
 *
 * O defeito que este teste existe para impedir já aconteceu e passou meses:
 * `risk-watcher`, `routing-worker` e `attendant-heartbeat` existiam, tinham
 * teste, tinham doc — e NINGUÉM AS AGENDAVA no self-host. O `risk-watcher` até
 * documentava a própria ausência no cabeçalho ("o kit precisa agendar esta
 * rota"), e a nota ficou lá sem virar linha de crontab.
 *
 * E o modo de falha é o pior: NÃO DÁ ERRO. A rota responde 200 quando alguém a
 * chama à mão, o teste unitário passa, o build passa — e a feature simplesmente
 * nunca acontece sozinha em produção. "Nada esfria" é indistinguível de "nada
 * esfriou ainda".
 *
 * A cerca é mecânica de propósito: compara o DIRETÓRIO (fonte da verdade do que
 * existe) com o CRONTAB do serviço `scheduler` (fonte da verdade do que roda).
 * Não pede disciplina de ninguém — quem criar uma rota nova sem agendá-la
 * descobre no CI, não seis meses depois pela ausência de um comportamento.
 */

const RAIZ = join(__dirname, "..", "..");
const DIR_CRON = join(RAIZ, "app", "api", "v1", "cron");
// O crontab saiu do `command:` inline do compose e virou o entrypoint da imagem
// `deskcomm-scheduler` — o `apk add curl tzdata` a cada start amarrava a volta
// do cron à internet da VPS. A cerca continua a mesma; só a fonte da verdade do
// "o que roda" mudou de arquivo.
const CRONTAB = join(RAIZ, "docker", "scheduler", "entrypoint.sh");
const VERCEL_TS = join(RAIZ, "vercel.ts");

/** As rotas que existem, lidas do disco — não de uma lista mantida à mão. */
function rotasNoCodigo(): string[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** As rotas que o `scheduler` chama, extraídas do crontab embutido no compose. */
function rotasAgendadas(): string[] {
  const sh = readFileSync(CRONTAB, "utf8");
  const achadas = sh.matchAll(/api\/v1\/cron\/([a-z0-9-]+)/g);
  return [...new Set([...achadas].map((m) => m[1]!))].sort();
}

describe("rotas de cron × agendamento no self-host", () => {
  it("o apparato consegue enxergar as duas listas (controle positivo)", () => {
    // Sem isto, um `readdir` que devolvesse [] ou um regex que não casasse nada
    // fariam o teste principal passar por vacuidade — "zero rotas não agendadas"
    // seria verdade e não significaria nada.
    expect(rotasNoCodigo().length).toBeGreaterThan(0);
    expect(rotasAgendadas().length).toBeGreaterThan(0);
  });

  it("toda rota de cron do código está agendada no scheduler", () => {
    const naoAgendadas = rotasNoCodigo().filter((r) => !rotasAgendadas().includes(r));
    expect(
      naoAgendadas,
      `Rota(s) de cron sem linha no crontab de docker/scheduler/entrypoint.sh: ` +
        `${naoAgendadas.join(", ")}. Num self-host elas NUNCA rodam, e a feature não dá erro — ` +
        `só não acontece. Adicione a linha (ou apague a rota, se ela morreu).`,
    ).toEqual([]);
  });

  it("todo agendamento aponta para uma rota que existe", () => {
    // A direção contrária: linha de crontab para rota apagada bate 404 a cada
    // minuto, em silêncio, porque o `curl -fsS` manda tudo para /dev/null.
    const orfas = rotasAgendadas().filter((r) => !rotasNoCodigo().includes(r));
    expect(
      orfas,
      `Crontab agenda rota(s) que não existem mais: ${orfas.join(", ")}. ` +
        `O curl silencia o 404 e ninguém percebe.`,
    ).toEqual([]);
  });
});

function rotasNoVercelTs(): string[] {
  const fonte = readFileSync(VERCEL_TS, "utf8");
  const achadas = fonte.matchAll(/path:\s*"\/api\/v1\/cron\/([a-z0-9-]+)"/g);
  return [...new Set([...achadas].map((m) => m[1]!))].sort();
}

describe("rotas de cron × agendamento no Vercel Pro", () => {
  it("vercel.ts agenda as mesmas rotas do scheduler", () => {
    expect(rotasNoVercelTs()).toEqual(rotasAgendadas());
  });

  it("documenta o CRON_SECRET da Vercel — senão o Pro agenda e a rota responde 403", () => {
    const fonte = readFileSync(join(RAIZ, "lib", "env.ts"), "utf8");
    expect(fonte).toContain("CRON_SECRET");
    expect(fonte).toContain("env.INTERNAL_CRON_SECRET = vercelCron");
  });
});

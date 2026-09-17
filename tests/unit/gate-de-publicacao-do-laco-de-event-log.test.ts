/**
 * O gate de publicação prova que as imagens de FUNDO sobem — e que o laço do
 * `event_log` CARREGOU (issue #604).
 *
 * ── O defeito que este arquivo protege ─────────────────────────────────────
 *
 * `#648`: um `import` que só estoura sob `tsx` (`@react-pdf/hyphenate`) deixou
 * o drain do `event_log` parado por dez dias. As imagens `deskcomm-worker` e
 * `deskcomm-scheduler` construíam, publicavam, recebiam tag e release sem que
 * nenhum job as executasse antes — e o `/healthz` do worker continuava verde.
 * Ou seja: "contêiner de pé" NÃO era o critério que faltava; o que faltava era
 * alguém exigindo o LAÇO CARREGADO.
 *
 * ── Dois níveis, porque são duas coisas que podem regredir em silêncio ──────
 *
 * 1. O SINAL (medido de verdade, importando a função do boot): a prontidão do
 *    laço conta a verdade mesmo quando o carregamento falha, e a marca que a
 *    sonda procura é a MESMA string que o laço emite — uma string, não duas.
 * 2. O PIPELINE (afirmação sobre o texto do fluxo, mesma técnica dos testes
 *    irmãos deste diretório): o job existe, constrói as DUAS imagens de fundo,
 *    roda a sonda, NÃO tem `if:` (job pulado vira `skipped` e a fachada lê
 *    `skipped` como reprovação) e entra por baixo de `imagens-ok` — a fachada
 *    que a branch protection já exige. Nenhum check obrigatório novo: a
 *    proteção da `main` não passa a esperar um nome que ninguém produz.
 *
 * O que este arquivo NÃO pode medir: que a imagem de fato sobe (é o runner,
 * com Docker, que mede isso), e que a branch protection está configurada.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MARCA_LACO_CARREGADO,
  _reiniciarProntidaoDoLaco,
  carregarDepsDoLaco,
  prontidaoDoLacoDeEventLog,
} from "@/lib/event-log/drain-loop";

const RAIZ = join(__dirname, "..", "..");
const FLUXO = readFileSync(join(RAIZ, ".github", "workflows", "publish-image.yml"), "utf8");
const SONDA = readFileSync(join(RAIZ, "scripts", "sonda-do-laco-de-event-log.ts"), "utf8");
const JOB_DE_FUNDO = "imagens-de-fundo-sobem";

/** O bloco de um job do fluxo: do `  nome:` até a linha seguinte com 2 espaços de indentação. */
function blocoDoJob(nome: string): string {
  const inicio = FLUXO.indexOf(`\n  ${nome}:`);
  expect(inicio, `job ${nome} não existe em publish-image.yml`).toBeGreaterThan(-1);
  const resto = FLUXO.slice(inicio + 1);
  const fim = resto.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return fim === -1 ? resto : resto.slice(0, fim);
}

describe("o sinal de prontidão do laço do event_log (#604)", () => {
  it("sem o laço carregado, a prontidão denuncia — e não fica em silêncio", async () => {
    _reiniciarProntidaoDoLaco();
    expect(prontidaoDoLacoDeEventLog()).toEqual({ carregado: false, motivo: expect.any(String) });

    // A MESMA função que o boot da imagem executa. Sem Supabase no ambiente de
    // teste ela falha — e é exatamente esse o caminho que a #648 percorreu em
    // produção sem que ninguém soubesse. O que se afirma não depende do
    // ambiente: a prontidão diz `carregado` se e somente se as deps vieram.
    const avisos: string[] = [];
    const erros: string[] = [];
    const log = {
      info: () => {},
      warn: (m: string) => void avisos.push(String(m)),
      error: (m: string) => void erros.push(String(m)),
    } as unknown as Parameters<typeof carregarDepsDoLaco>[0];

    const deps = await carregarDepsDoLaco(log);
    const estado = prontidaoDoLacoDeEventLog();

    expect(estado.carregado).toBe(deps !== null);
    if (deps === null) {
      expect(estado.motivo).toBeTruthy();
      expect(erros.join("\n")).toContain(String(estado.motivo));
    } else {
      expect(erros).toHaveLength(0);
    }
    // 60s: o teste importa a cadeia REAL de boot (drain + handlers + admin) dentro
    // do vitest. Em máquina carregada esses imports passaram de 15s e o caso
    // morria por timeout — falso vermelho que não fala nada sobre o código.
  }, 60_000);

  it("a marca que a sonda procura é a MESMA que o laço emite", () => {
    // Se a marca virasse literal solto no meio do log e no meio do fluxo, a
    // sonda poderia procurar por uma string que ninguém emite — e passar verde
    // sobre um laço morto. Uma constante, um lugar.
    expect(MARCA_LACO_CARREGADO).toMatch(/event-log drain: laço carregado/);
    expect(SONDA).toContain("MARCA_LACO_CARREGADO");
    expect(SONDA).toContain("carregarDepsDoLaco(");
    expect(FLUXO).toContain(MARCA_LACO_CARREGADO);
  });

  it("o `/healthz` do worker publica a prontidão nos DOIS ramos — 200 e 503", () => {
    // A sonda lê `event_log_drain.carregado`. Se o handler parar de publicar o
    // campo, o gate reprova por ausência; o caso pior é o outro: o campo sumir
    // do ramo 503 e a prontidão desaparecer justo quando o banco cai.
    // Afirmação sobre o texto do handler — sem Docker não há handler de pé.
    // Quem mede comportamento é a sonda, no runner.
    const MAIN = readFileSync(join(RAIZ, "workers", "agent-worker", "main.ts"), "utf8");
    const publicacoes = [
      ...MAIN.matchAll(/event_log_drain:\s*prontidaoDoLacoDeEventLog\(\)/g),
    ].map((m) => m.index ?? -1);
    expect(publicacoes, "a prontidão tem que aparecer nos dois ramos").toHaveLength(2);
    const ramoOk = MAIN.indexOf("respond(res, 200,");
    const ramoDegradado = MAIN.indexOf("respond(res, 503,");
    expect(ramoOk).toBeGreaterThan(-1);
    expect(ramoDegradado).toBeGreaterThan(-1);
    expect(publicacoes[0]).toBeGreaterThan(ramoOk);
    expect(publicacoes[1]).toBeGreaterThan(ramoDegradado);
  });
});

describe("o gate de publicação das imagens de fundo (#604)", () => {
  it("constrói o worker E o scheduler, na mesma imagem que o build-and-push publica", () => {
    const job = blocoDoJob(JOB_DE_FUNDO);
    expect(job).toContain("Dockerfile.worker");
    expect(job).toContain("Dockerfile.scheduler");
    expect(job).toContain("deskcomm-worker:pr");
    expect(job).toContain("deskcomm-scheduler:pr");
  });

  it("exige o laço carregado e a linha do event-log-drain no crontab — não só contêiner de pé", () => {
    const job = blocoDoJob(JOB_DE_FUNDO);
    expect(job).toContain("sonda-do-laco-de-event-log.ts");
    expect(job).toContain('"ok":true');
    expect(job).toContain("event_log_drain");
    expect(job).toContain("/healthz");
    expect(job).toContain("api/v1/cron/event-log-drain");
    // "Contêiner de pé" seria `docker ps` e mais nada: o defeito da #648 passa
    // por esse teste. O job tem que falhar por conteúdo, não por existência.
    expect(job).not.toMatch(/^\s+run: \|\n\s+docker ps -q/m);
  });

  it("entra por baixo da fachada `imagens-ok` — sem criar check obrigatório novo", () => {
    const fachada = blocoDoJob("imagens-ok");
    expect(fachada).toMatch(new RegExp(`needs: \\[[^\\]]*${JOB_DE_FUNDO}`));
    // Concatenação, e não template literal: dentro de um template, `${{` é
    // sintaxe de expressão e o arquivo não compila.
    expect(fachada).toContain('[ "${{ needs.' + JOB_DE_FUNDO + '.result }}" = "success" ]');
    // `always()` na fachada é o que faz um job pulado reprovar em vez de sumir.
    expect(fachada).toContain("if: always()");
  });

  it("não pode ser pulado: sem `if:`, o job roda em PR e em tag", () => {
    const job = blocoDoJob(JOB_DE_FUNDO);
    expect(job).not.toMatch(/^\s{4}if:/m);
    expect(job).toMatch(/^\s{4}permissions:\n\s{6}contents: read$/m);
  });

  it("o canal `stable` não anda sobre um worker/scheduler que não sobe", () => {
    const promover = blocoDoJob("promover-stable");
    expect(promover).toMatch(new RegExp(`needs: \\[[^\\]]*${JOB_DE_FUNDO}`));
    expect(promover).toContain("if: github.event_name == 'push'");
  });
});

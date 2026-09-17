/**
 * Sonda do gate de publicação (issue #604): prova, DENTRO da imagem do worker,
 * que o laço do `event_log` CARREGA — não só que o contêiner sobe.
 *
 * Por que isto existe: em produção o worker subia, `/healthz` respondia 200 e o
 * event_log ficou parado 10 dias porque o `import` de `@react-pdf/hyphenate`
 * estourava apenas sob `tsx` (issue #648). O teste unitário importava o módulo
 * em outro carregador e ficava verde; `carregarDeps()` engolia o erro num
 * `log.warn`. Nenhum gate, em lugar nenhum, perguntava "o laço carregou?".
 *
 * O que esta sonda mede, nesta ordem:
 *   1. chama a MESMA função que o boot do worker chama (`carregarDepsDoLaco`)
 *      — não uma reimplementação que poderia ficar verde sozinha;
 *   2. exige a marca `event-log drain: laço carregado` no log;
 *   3. exige `prontidaoDoLacoDeEventLog().carregado === true`, que é o mesmo
 *      estado que o `/healthz` publica em `event_log_drain`.
 *
 * Sai 0 com um JSON de uma linha no stdout; sai 1 com a etapa e o motivo
 * quando não carrega. Env: as mesmas do boot (Supabase); não há banco aqui —
 * montar o client não abre conexão.
 */
import {
  carregarDepsDoLaco,
  MARCA_LACO_CARREGADO,
  prontidaoDoLacoDeEventLog,
} from "@/lib/event-log/drain-loop";

const linhas: string[] = [];

// Logger falso: a sonda não quer o log formatado, quer saber SE a marca saiu —
// e sai pelo mesmo `log.info` do boot, então a marca é observada de verdade.
const sonda = {
  info: (msg: string) => linhas.push("info " + msg),
  warn: (msg: string) => linhas.push("warn " + msg),
  error: (msg: string) => linhas.push("error " + msg),
  debug: () => {},
  child: () => sonda,
} as unknown as Parameters<typeof carregarDepsDoLaco>[0];

function veredito(ok: boolean, dados: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ ok, marca: MARCA_LACO_CARREGADO, ...dados }) + "\n",
  );
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  const deps = await carregarDepsDoLaco(sonda);
  const prontidao = prontidaoDoLacoDeEventLog();
  const motivo = prontidao.motivo ?? "sem motivo registrado";

  if (!deps) veredito(false, { etapa: "carregarDepsDoLaco", carregado: false, motivo, linhas });
  if (!linhas.some((l) => l.includes(MARCA_LACO_CARREGADO))) {
    veredito(false, { etapa: "marca-ausente-no-log", carregado: prontidao.carregado, motivo, linhas });
  }
  if (!prontidao.carregado) veredito(false, { etapa: "prontidao", carregado: false, motivo, linhas });

  veredito(true, { etapa: "ok", carregado: true, motivo: null, linhas });
}

main().catch((err: unknown) => {
  veredito(false, {
    etapa: "excecao-na-sonda",
    motivo: err instanceof Error ? err.message : String(err),
    linhas,
  });
});

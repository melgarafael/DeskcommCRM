import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRON QUE NÃO FEZ NADA NÃO ESCREVE NA TRILHA DE AUDITORIA — E CRON QUE FEZ, ESCREVE.
 *
 * ─── O defeito, medido (issue #261) ─────────────────────────────────────────
 *
 * `routing-worker` roda 1×/min e `attendant-heartbeat` 1×/5min, e os dois
 * chamavam `audit()` FORA de qualquer condição: **51.840 linhas/mês** numa
 * instalação que não atende ninguém, numa tabela append-only que até agora não
 * tinha expurgo nenhum. Não é hipótese: numa VPS real, **95% do audit log** era
 * batida de cron vazia — 1.175 de 1.236 linhas em ~9 h paradas
 * (`docs/testing/user-journey-map.md`, achado 17).
 *
 * ─── Por que este arquivo tem DUAS partes, e nenhuma das duas basta sozinha ──
 *
 * A parte ESTÁTICA mede a CLASSE. O conserto por instância — trocar dois `void
 * audit(` de lugar — deixa a próxima rota de cron nascer com o mesmo defeito, e
 * o modo de falha é mudo (nada quebra, só cresce). O guarda percorre o AST de
 * TODA rota em `app/api/v1/cron/`, então ele alcança rota que ainda não existe.
 *
 * Mas ele prova CONDICIONALIDADE, não "condicionada ao efeito" — um `if (true)`
 * o satisfaria. E o outro lado importa tanto quanto: uma rodada que fez trabalho
 * TEM de deixar rastro; "parar de auditar" seria trocar ruído por cegueira, que
 * é pior. Daí a parte de COMPORTAMENTO, que dirige as rotas consertadas nas duas
 * direções — sem ela, um cron que nunca audita passaria no guarda estático com
 * louvor.
 */

const RAIZ = join(__dirname, "..", "..");
const DIR_CRON = join(RAIZ, "app", "api", "v1", "cron");

function rotasDeCron(): string[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Chamadas a `audit(...)` que NÃO estão sob nenhuma condição, no fonte dado.
 * Devolve as linhas (1-based) das infratoras.
 *
 * Ancorado no AST e não em regex de propósito: a prosa deste repositório cita
 * `audit(` e `if (` em comentário o tempo todo, e um regex acusaria o texto que
 * descreve a regra — instrumento reprovando o arquivo por ele falar de si mesmo.
 */
export function auditsIncondicionais(fonte: string, nomeDoArquivo: string): number[] {
  const arquivo = ts.createSourceFile(nomeDoArquivo, fonte, ts.ScriptTarget.Latest, true);
  const infratoras: number[] = [];

  const souChamadaDeAudit = (no: ts.Node): boolean =>
    ts.isCallExpression(no) && ts.isIdentifier(no.expression) && no.expression.text === "audit";

  const visitar = (no: ts.Node): void => {
    if (souChamadaDeAudit(no)) {
      let pai: ts.Node | undefined = no.parent;
      let sobCondicao = false;
      while (pai && !ts.isSourceFile(pai)) {
        // `if`, `? :` e `&&`/`||` cobrem as três formas de "só quando" que
        // aparecem em rota HTTP. `for`/`while` NÃO contam: um laço sobre o
        // resultado já é o próprio efeito, mas laço vazio não chama nada, então
        // ele não é o caminho pelo qual o defeito volta.
        //
        // `catch` CONTA, e não é folga: um bloco de catch só executa quando algo
        // falhou, e "falhou" é efeito — é justamente a rodada que não pode ficar
        // idêntica, na trilha, à rodada que não tinha o que fazer. O que este
        // arquivo proíbe é a chamada no caminho NORMAL, que roda sempre.
        if (
          ts.isIfStatement(pai) ||
          ts.isCatchClause(pai) ||
          ts.isConditionalExpression(pai) ||
          (ts.isBinaryExpression(pai) &&
            (pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
              pai.operatorToken.kind === ts.SyntaxKind.BarBarToken))
        ) {
          sobCondicao = true;
          break;
        }
        pai = pai.parent;
      }
      if (!sobCondicao) {
        infratoras.push(arquivo.getLineAndCharacterOfPosition(no.getStart(arquivo)).line + 1);
      }
    }
    ts.forEachChild(no, visitar);
  };

  visitar(arquivo);
  return infratoras;
}

describe("rotas de cron × auditoria condicional (a CLASSE)", () => {
  const rotas = rotasDeCron();

  it("o instrumento enxerga as rotas e as chamadas (controle positivo)", () => {
    // Sem isto, um `readdir` vazio ou um AST que nunca casa `audit(` fariam o
    // caso abaixo passar por vacuidade — "zero infratoras" seria verdade e não
    // significaria nada.
    expect(rotas.length).toBeGreaterThan(10);
    const comAudit = rotas.filter((r) =>
      readFileSync(join(DIR_CRON, r, "route.ts"), "utf8").includes("audit("),
    );
    expect(comAudit.length).toBeGreaterThanOrEqual(6);
  });

  it.each(rotasDeCron())("%s não chama audit() fora de condição", (rota) => {
    const caminho = join(DIR_CRON, rota, "route.ts");
    const linhas = auditsIncondicionais(readFileSync(caminho, "utf8"), caminho);
    expect(
      linhas,
      `app/api/v1/cron/${rota}/route.ts chama audit() incondicionalmente na(s) linha(s) ` +
        `${linhas.join(", ")}. Um cron de minuto em minuto que audita sempre grava ~43.200 ` +
        `linhas/mês numa instalação parada, numa tabela append-only. A guarda certa é ` +
        `"auditar quando houve efeito" — nunca "parar de auditar".`,
    ).toEqual([]);
  });

  it("o instrumento acusa a violação quando ela existe (controle negativo)", () => {
    const sabotado = `
      import { audit } from "@/lib/audit";
      export async function GET() {
        const r = { swept: 0 };
        void audit({ action: "x", metadata: r });
        return r;
      }`;
    expect(auditsIncondicionais(sabotado, "sabotado.ts")).toHaveLength(1);
  });

  it("audit no corpo do try (caminho NORMAL) continua sendo infração", () => {
    // A fresta que a permissão a `catch` poderia abrir: envolver a chamada de
    // sempre num `try` e chamá-la de condicional. O `try` roda sempre.
    const sabotado = `
      import { audit } from "@/lib/audit";
      export async function GET() {
        try {
          void audit({ action: "x" });
        } catch {
          /* nada */
        }
      }`;
    expect(auditsIncondicionais(sabotado, "sabotado-try.ts")).toHaveLength(1);
  });

  it("o instrumento não confunde comentário com código (controle do controle)", () => {
    const prosa = `
      // A regra é: só chamar audit({...}) quando houve efeito, nunca fora de if (...).
      export const x = 1;`;
    expect(auditsIncondicionais(prosa, "prosa.ts")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// COMPORTAMENTO — as duas direções, nas rotas consertadas
// ────────────────────────────────────────────────────────────────────────────

const SEGREDO = "segredo-de-cron-do-teste";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: SEGREDO,
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

const rodarRouting = vi.fn();
vi.mock("@/lib/routing/worker", () => ({ runRoutingWorker: () => rodarRouting() }));

/** O que o UPDATE de `attendant_availability` devolve nesta rodada. */
let varridos: { user_id: string }[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const metodo of ["update", "eq", "or"]) {
        cadeia[metodo] = () => cadeia;
      }
      cadeia.select = async () => ({ data: varridos, error: null });
      return cadeia;
    },
  }),
}));

function requisicaoAutorizada(): Parameters<
  typeof import("@/app/api/v1/cron/routing-worker/route").GET
>[0] {
  // As rotas só leem `headers.get("authorization")`; montar um `NextRequest` de
  // verdade traria o runtime do Next para dentro de um teste que não o exercita.
  return { headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never;
}

describe("routing-worker — audita quando drenou, cala quando não drenou", () => {
  beforeEach(() => {
    auditou.mockClear();
    rodarRouting.mockReset();
  });

  it("tick vazio (batch_size 0, sem erro) NÃO audita", async () => {
    rodarRouting.mockResolvedValue({ batch_size: 0, outcomes: {}, errors: [] });
    const { GET } = await import("@/app/api/v1/cron/routing-worker/route");
    const resposta = await GET(requisicaoAutorizada());
    expect(resposta.status).toBe(200);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("tick que drenou um evento AUDITA (a direção que não pode se perder)", async () => {
    rodarRouting.mockResolvedValue({ batch_size: 1, outcomes: { assigned: 1 }, errors: [] });
    const { GET } = await import("@/app/api/v1/cron/routing-worker/route");
    await GET(requisicaoAutorizada());
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({ action: "routing.worker_run" });
  });

  it("falha de leitura do event_log AUDITA mesmo com batch_size 0", async () => {
    // `runRoutingWorker` devolve `batch_size: 0` com o erro dentro quando o
    // `select` falha (worker.ts:88). Sem a cláusula de `errors`, o tick em que o
    // banco não respondeu ficaria idêntico, na trilha, ao tick de uma instalação
    // sem nada a fazer — o defeito que `claim_falhou` já conserta no irmão.
    rodarRouting.mockResolvedValue({
      batch_size: 0,
      outcomes: {},
      errors: ["event_log_pull_failed: timeout"],
    });
    const { GET } = await import("@/app/api/v1/cron/routing-worker/route");
    await GET(requisicaoAutorizada());
    expect(auditou).toHaveBeenCalledTimes(1);
  });
});

describe("attendant-heartbeat — audita quando derrubou alguém", () => {
  beforeEach(() => {
    auditou.mockClear();
  });

  it("varredura que não derrubou ninguém NÃO audita", async () => {
    varridos = [];
    const { GET } = await import("@/app/api/v1/cron/attendant-heartbeat/route");
    const resposta = await GET(requisicaoAutorizada() as never);
    expect(resposta.status).toBe(200);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("varredura que derrubou dois atendentes AUDITA", async () => {
    varridos = [{ user_id: "a" }, { user_id: "b" }];
    const { GET } = await import("@/app/api/v1/cron/attendant-heartbeat/route");
    await GET(requisicaoAutorizada() as never);
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "attendant.heartbeat_swept",
      metadata: { swept: 2 },
    });
  });
});

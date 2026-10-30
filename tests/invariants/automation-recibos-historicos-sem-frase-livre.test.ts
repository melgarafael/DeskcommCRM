import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resultadoParaRecibo } from "@/lib/automation/resultado-para-recibo";
import type { ActionResultDetail } from "@/lib/automation/types";
import { sql } from "./gov-helpers";

const ORGS = ["b9018000-0000-4000-8000-000000000001", "b9018000-0000-4000-8000-000000000002"];
const REGRAS = ["b9018000-1111-4000-8000-000000000001", "b9018000-1111-4000-8000-000000000002"];
const RUNS = ["b9018000-2222-4000-8000-000000000001", "b9018000-2222-4000-8000-000000000002"];
const PESSOAL = "Pessoa Sintética recibo.sintetico@example.test +5511999018011";
const ACAO_AUDIT = "automation.receipts_sanitized_9018";
const FORWARD = readFileSync("supabase/migrations/20261026221300_9018_recibos_antigos_sem_frase_livre.sql", "utf8");
const literal = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const acoes: ActionResultDetail[] = [
  { type: "call_webhook", status: "failed", error: PESSOAL,
    detail: { reason: "http_503", error: { body: PESSOAL }, error_type: "TypeError", delivery_id: "entrega-9018", attempt: 2, response_status: 503, posicao: 7 } },
  { type: "send_email", status: "failed", detail: { error: PESSOAL, code: "cpf_12345678901", error_type: null, destinatario: "contato", message_id: "mensagem-9018" } },
  { type: "send_whatsapp_message", status: "postponed", detail: { reason: "fora_da_janela_de_envio", retry_at: "2026-10-26T22:00:00Z", message_id: "mensagem-adiada-9018" } },
  { type: "create_task", status: "success", detail: { task_id: "tarefa-9018" } },
  { type: "send_email", status: "failed", detail: { error_code: 131026, reason: "http_503", error: PESSOAL } },
  { type: "send_email", status: "failed", detail: { error_code: "131026", reason: "http_503", error: PESSOAL } },
];

beforeAll(() => {
  for (let i = 0; i < ORGS.length; i++) {
    sql(`insert into organizations(id,slug,legal_name,display_name) values ('${ORGS[i]}','recibo-9018-${i}','Recibo sintético','Recibo sintético');
      insert into automation_rules(id,organization_id,name,trigger_event) values ('${REGRAS[i]}','${ORGS[i]}','Recibo sintético','lead.created');
      insert into automation_rule_runs(id,organization_id,rule_id,status,created_at) values ('${RUNS[i]}','${ORGS[i]}','${REGRAS[i]}','failed','2026-01-01T00:00:00Z');`);
  }
});

beforeEach(() => {
  sql(`update automation_rule_runs set status='failed',error='${PESSOAL}',actions_result=${literal(acoes)} where id in ('${RUNS[0]}','${RUNS[1]}');`);
});

const linhas = `select json_agg(r order by id) from (select id,organization_id,rule_id,status,error,actions_result,
  created_at='2026-01-01T00:00:00Z'::timestamptz as mesma_data from automation_rule_runs where id in ('${RUNS[0]}','${RUNS[1]}')) r`;
const auditCount = `select count(*) from api_audit_log where action='${ACAO_AUDIT}'`;

/** O SQL completo é o mesmo publicado; nenhuma substituição de marcador/filtro. */
describe("9018 — campos de erro históricos, sem apagar o recibo", () => {
  it("dois tenants, marca pré-existente, controle técnico e reaplicação sem auditoria vazia", () => {
    // A linha de auditoria não tem autoridade para pular a transição.
    const out = sql(`begin;
      insert into api_audit_log(organization_id,action,metadata,bypassed_rls) values(null,'${ACAO_AUDIT}','{}',true);
      ${FORWARD}
      select 'RECIBOS:' || (${linhas})::text;
      select 'AUDIT1:' || (${auditCount})::text;
      ${FORWARD}
      select 'RECIBOS:' || (${linhas})::text;
      select 'AUDIT2:' || (${auditCount})::text;
      rollback;`);
    // json_agg pode separar registros por newline: ler o quadro inteiro até a
    // próxima contagem, preservando todos os recibos e o JSON original.
    const snapshots = Array.from(out.matchAll(/^RECIBOS:([\s\S]*?)\nAUDIT[12]:/gm), (m) => JSON.parse(m[1] ?? ""));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toEqual(snapshots[0]);
    for (const [i, run] of snapshots[0].entries()) {
      expect(run).toMatchObject({ id: RUNS[i], organization_id: ORGS[i], rule_id: REGRAS[i], status: "failed", error: "internal_error", mesma_data: true });
      expect(run.actions_result).toEqual(acoes.map(resultadoParaRecibo));
      expect(run.actions_result[0].detail).toMatchObject({ delivery_id: "entrega-9018", attempt: 2, posicao: 7, error_type: "TypeError", reason: "http_503" });
      expect(run.actions_result[4].error).toBe("http_503");
      expect(run.actions_result[4].detail.error_code).toBe("http_503");
      expect(run.actions_result[5].error).toBe("131026");
      expect(run.actions_result[5].detail.error_code).toBe("131026");
      expect(JSON.stringify(run)).not.toContain(PESSOAL);
    }
    const contagens = out.split("\n").filter((l) => /^AUDIT[12]:/.test(l)).map((l) => Number(l.split(":")[1]));
    expect(contagens).toHaveLength(2);
    expect(contagens[0]).toBeGreaterThan(1); // não pulou por existir a linha anterior
    expect(contagens[1]).toBe(contagens[0]); // segunda passada não fez efeito
  });

  it("relê depois do lock: não sobrescreve resultado novo de um worker", async () => {
    const container = process.env.TEST_DB_CONTAINER;
    if (!container) throw new Error("rode via pnpm test:db");
    const abrir = () => spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"]);
    const worker = abrir();
    const fim = (p: ReturnType<typeof abrir>) => new Promise<void>((resolve, reject) => {
      let erro = "";
      p.stderr.on("data", (s) => { erro += s.toString(); });
      p.once("error", reject);
      p.once("close", (code) => code === 0 ? resolve() : reject(new Error(`psql saiu ${code}: ${erro}`)));
    });
    const fimWorker = fim(worker);
    void fimWorker.catch(() => {});
    const pronto = new Promise<void>((resolve, reject) => {
      let saida = "";
      worker.stdout.on("data", (s) => { saida += s.toString(); if (saida.includes("WORKER_LOCKED")) resolve(); });
      worker.once("error", reject);
      worker.once("close", () => reject(new Error("worker fechou antes da barreira")));
    });
    const atual = [{ type: "call_webhook", status: "failed", error: "http_503", detail: { delivery_id: "entrega-mais-nova", attempt: 9 } }];
    worker.stdin.write(`begin; update automation_rule_runs set status='partial',error=null,actions_result=${literal(atual)} where id='${RUNS[0]}';\n\\echo WORKER_LOCKED\n`);
    let migrador: ReturnType<typeof abrir> | undefined;
    let fimMigrador: Promise<void> | undefined;
    try {
      await pronto;
      migrador = abrir();
      fimMigrador = fim(migrador);
      void fimMigrador.catch(() => {});
      migrador.stdin.end(`set application_name='codex-3267-9018-corrida';\n${FORWARD}`);
      let bloqueado = false;
      for (let i = 0; i < 100 && !bloqueado; i++) {
        bloqueado = sql("select count(*) from pg_stat_activity where application_name='codex-3267-9018-corrida' and wait_event_type='Lock'").trim() === "1";
        if (!bloqueado) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(bloqueado, "a transição não aguardou o lock do worker").toBe(true);
      worker.stdin.end("commit;\n");
      await Promise.all([fimWorker, fimMigrador]);
      const run = JSON.parse(sql(`select row_to_json(r) from (select status,error,actions_result from automation_rule_runs where id='${RUNS[0]}') r`));
      expect(run).toEqual({ status: "partial", error: null, actions_result: atual });
    } finally {
      if (!worker.stdin.writableEnded) worker.stdin.end("rollback;\n");
      await Promise.allSettled([fimWorker, ...(fimMigrador ? [fimMigrador] : [])]);
    }
  });
});

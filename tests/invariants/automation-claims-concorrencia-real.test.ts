import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORGS = ["b3267000-0000-4000-8000-000000000001", "b3267000-0000-4000-8000-000000000002"];
const REGRAS = ["b3267000-1111-4000-8000-000000000001", "b3267000-1111-4000-8000-000000000002"];
const CONTATOS = ["b3267000-2222-4000-8000-000000000001", "b3267000-2222-4000-8000-000000000002", "b3267000-2222-4000-8000-000000000003"];
const reserva = (org: string, regra: string, contato: string) => `with w as (
  insert into automation_rule_contact_claims(organization_id,rule_id,contact_id) values('${org}','${regra}','${contato}')
  on conflict(organization_id,rule_id,contact_id) do nothing returning 1) select count(*) from w;`;

beforeAll(() => {
  for (let i = 0; i < ORGS.length; i++) {
    sql(`insert into organizations(id,slug,legal_name,display_name) values('${ORGS[i]}','corrida-3267-${i}','Corrida sintética','Corrida sintética');
      insert into automation_rules(id,organization_id,name,trigger_event) values('${REGRAS[i]}','${ORGS[i]}','Corrida sintética','lead.created');`);
  }
  sql(`insert into contacts(id,organization_id,name) values('${CONTATOS[0]}','${ORGS[0]}','Primeiro sintético'),
    ('${CONTATOS[1]}','${ORGS[0]}','Segundo sintético'),('${CONTATOS[2]}','${ORGS[1]}','Outro tenant sintético');`);
});

describe("#3267 — a reserva real serializa dois workers", () => {
  it("o perdedor aguarda commit e recebe zero; outro contato e tenant continuam livres", async () => {
    const container = process.env.TEST_DB_CONTAINER;
    if (!container) throw new Error("rode via pnpm test:db");
    const abrir = () => spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"]);
    const acompanhar = (p: ReturnType<typeof abrir>) => {
      let saida = "", erro = "";
      p.stdout.on("data", (s) => { saida += s.toString(); });
      p.stderr.on("data", (s) => { erro += s.toString(); });
      const fim = new Promise<string>((resolve, reject) => {
        p.once("error", reject);
        p.once("close", (code) => code === 0 ? resolve(saida.trim()) : reject(new Error(`psql ${code}: ${erro}`)));
      });
      // A falha continua sendo aguardada abaixo, sem rejeição sem consumidor.
      void fim.catch(() => {});
      return { fim, saida: () => saida };
    };
    const a = abrir(), um = acompanhar(a);
    const b = abrir(), dois = acompanhar(b);
    try {
      a.stdin.write(`begin; ${reserva(ORGS[0]!, REGRAS[0]!, CONTATOS[0]!)}\n\\echo RESERVA_TOMADA\n`);
      await expect.poll(um.saida, { timeout: 10_000, interval: 50 }).toContain("RESERVA_TOMADA");
      b.stdin.end(`set application_name='codex-3267-claim-corrida'; ${reserva(ORGS[0]!, REGRAS[0]!, CONTATOS[0]!)}`);
      await expect.poll(() => sql("select count(*) from pg_stat_activity where application_name='codex-3267-claim-corrida' and wait_event_type='Lock'"), { timeout: 10_000, interval: 50 }).toBe("1");
      a.stdin.end("commit;\n");
      const [primeira, segunda] = await Promise.all([um.fim, dois.fim]);
      expect(primeira.split("\n")[0]).toBe("1");
      expect(segunda).toBe("0");
      expect(sql(`select count(*) from automation_rule_contact_claims where rule_id='${REGRAS[0]}' and contact_id='${CONTATOS[0]}'`)).toBe("1");
      expect(sql(reserva(ORGS[0]!, REGRAS[0]!, CONTATOS[1]!))).toBe("1");
      expect(sql(reserva(ORGS[1]!, REGRAS[1]!, CONTATOS[2]!))).toBe("1");
    } finally {
      if (!a.stdin.writableEnded) a.stdin.end("rollback;\n");
      if (!b.stdin.writableEnded) b.stdin.end();
      await Promise.allSettled([um.fim, dois.fim]);
    }
  });
});

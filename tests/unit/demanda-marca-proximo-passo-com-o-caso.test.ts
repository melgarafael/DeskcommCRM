/**
 * O CASO QUE FECHA MARCA UM PRÓXIMO PASSO NA DEMANDA QUE ELE ABRIU (#2035 · Parte 2).
 *
 * A IA abre um caso de escalação por handoff; esse caso abre uma demanda
 * (`origem='handoff'`, `agent_case_id` preenchido, `estado='em_atendimento'`).
 * Quando o caso chega a `resolved`/`cancelled`, a demanda ligada ficava ABERTA
 * e SEM PRÓXIMO PASSO para sempre: presa na seção "demanda aberta sem próximo
 * passo" do Radar, sem ninguém ter por onde agir.
 *
 * O conserto NÃO fecha a demanda — fechar seria decisão de produto e a doutrina
 * é contrária (`docs/doctrine/sistema-vivo/05-unidade-de-demanda.md:77`; a 0222
 * removeu até o fecho automático por conversa). O gatilho faz o MESMO gesto que
 * `fn_service_status` faz quando a conversa vai a estado terminal: preenche o
 * próximo passo e deixa o desfecho para uma pessoa.
 *
 * É SQL sem harness local (não há Postgres no `vitest run`), então o contrato é
 * PINADO pela leitura do fonte — o mesmo padrão de
 * `tests/unit/aviso-event-dead-concorrente-abre-uma-vez.test.ts`. Se alguém
 * apagar a migration, tirar `'cancelled'` do `WHEN`, voltar a gravar
 * `estado`/`desfecho`/`fechada_em` ou soltar uma das guardas, um caso abaixo
 * fica VERMELHO na hora.
 *
 *   pnpm exec vitest run tests/unit/demanda-marca-proximo-passo-com-o-caso.test.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "supabase");
const MANIFEST = readFileSync(join(RAIZ, "migrations", "MANIFEST.md"), "utf8");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");

/** O arquivo da migration 0505 (a fonte da verdade da cadeia). */
const migration = (() => {
  const nome = readdirSync(join(RAIZ, "migrations"))
    .filter((f) => /_0505_demanda_marca_proximo_passo_com_o_caso\.sql$/.test(f))
    .sort()
    .at(-1);
  return nome ? { nome, sql: readFileSync(join(RAIZ, "migrations", nome), "utf8") } : null;
})();

/** O trecho do `update` — é ele que decide o que a demanda ganha e o que ela NÃO perde. */
function trechoDoUpdate(sql: string): string {
  const i = sql.indexOf("update public.demandas");
  if (i === -1) return "";
  const fim = sql.indexOf("return new;", i);
  return sql.slice(i, fim === -1 ? undefined : fim);
}

function corpoDe(sql: string, fn: string): string | null {
  // Normaliza só o essencial (marca de delimitador e espaços) para comparar o
  // corpo da migration com o apêndice do baseline sem acusar estilo.
  const busca = new RegExp(`create or replace function public\\.${fn}\\b`);
  const i = sql.search(busca);
  if (i === -1) return null;
  const abre = /\$[a-z_]*\$/i.exec(sql.slice(i, i + 600));
  if (!abre) return null;
  const fim = sql.indexOf(abre[0], i + abre.index + abre[0].length);
  if (fim === -1) return null;
  return sql
    .slice(i, fim + abre[0].length)
    .replace(/--.*$/gm, "")
    .replace(/\$[a-z_]*\$/g, "$$")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

const FN = "fn_demanda_marca_proximo_passo_com_o_caso";

describe("a demanda do caso encerrado ganha próximo passo (fix 0505 · #2035)", () => {
  it("a migration 0505 existe (sabotagem: apagar o arquivo derruba este caso)", () => {
    expect(migration, "migration 0505 ausente da cadeia").not.toBeNull();
  });

  it("se descreve SÓ no `-- manifest:` do próprio .sql (doutrina 02/10/2026)", () => {
    expect(migration?.sql ?? "").toMatch(/^-- manifest: .{40,}/m);
    // Descrita nos DOIS lugares é erro do gate `manifest-x-migrations.test.ts`:
    // a linha na tabela do MANIFEST.md conflitava entre PRs e o GitHub ignora o
    // `merge=union`, deixando todo PR com migration CONFLICTING.
    expect(MANIFEST).not.toContain("0505_demanda_marca_proximo_passo_com_o_caso");
  });

  describe("gatilho em agent_cases", () => {
    it("cria a função de gatilho e a revoga de public/anon/authenticated", () => {
      const fn = migration?.sql ?? "";
      expect(fn).toMatch(new RegExp(`create or replace function public\\.${FN}\\(\\)`));
      expect(fn).toMatch(/returns trigger/);
      expect(fn).toMatch(/security definer/);
      expect(fn).toMatch(new RegExp(`revoke execute on function public\\.${FN}\\(\\) from public, anon;`));
      expect(fn).toMatch(new RegExp(`revoke execute on function public\\.${FN}\\(\\) from authenticated;`));
    });

    it("dispara APÓS a virada de status, quando o caso chega a resolved|cancelled", () => {
      const fn = migration?.sql ?? "";
      expect(fn).toMatch(/after update of status on public\.agent_cases/);
      // O `WHEN` é a régua do bug: sem `'cancelled'` aqui, o caso cancelado não
      // marca nada — a parte 2 da issue #2035 volta. Sabotagem: trocar
      // `cancelled` por outro valor derruba este caso.
      expect(fn).toMatch(
        /old\.status is distinct from new\.status\s+and new\.status in \('resolved','cancelled'\)/,
      );
      expect(fn).toMatch(new RegExp(`execute function public\\.${FN}\\(\\);`));
    });

    it("NÃO mexe no caso que é apenas escalado (problema segue em trabalho)", () => {
      // A semântica de `escalated` (0136) mantém a demanda em atendimento; o
      // WHEN restringe o gatilho a resolved/cancelled. Sabotagem: pôr
      // `escalated` na cláusula `in` derruba este caso.
      const quando = /when \([^)]*new\.status in \(([^)]*)\)/i.exec(migration?.sql ?? "");
      expect(quando).not.toBeNull();
      expect(quando![1]).not.toContain("escalated");
    });
  });

  describe("o que o update da demanda faz — e o que ele deliberadamente NÃO faz", () => {
    it("preenche o próximo passo com o mesmo gesto do fn_service_status, por agent_case_id", () => {
      const up = trechoDoUpdate(migration?.sql ?? "");
      expect(up, "update em demandas não encontrado").not.toBe("");
      expect(up).toContain(
        "set proximo_passo = 'Revisar o caso encerrado e registrar o desfecho da demanda'",
      );
      expect(up).toMatch(/organization_id\s*=\s*new\.organization_id/);
      expect(up).toMatch(/agent_case_id\s*=\s*new\.id/);
    });

    it("NÃO decide o desfecho: estado, desfecho e fechada_em ficam intocados", () => {
      // A doutrina (05-unidade-de-demanda:77) proíbe o sistema ser o único a
      // decidir que a demanda acabou; a 0222 já tinha derrubado o fecho
      // automático por conversa. Sabotagem: pôr `estado = ...` ou
      // `fechada_em = clock_timestamp()` de volta derruba este caso.
      const up = trechoDoUpdate(migration?.sql ?? "");
      expect(up).not.toMatch(/\bestado\s*=/);
      expect(up).not.toMatch(/\bdesfecho\s*=/);
      expect(up).not.toMatch(/\bfechada_em\s*=/);
      expect(up).not.toMatch(/\bproximo_passo_em\s*=/);
    });

    it("só escreve onde ainda não há passo e a demanda segue aberta (idempotente)", () => {
      // Sem `proximo_passo is null` o update reescreveria o passo que alguém já
      // marcou E dispararia o bump de `revision` do `trg_demanda_revision` à toa;
      // sem `fechada_em is null` ele reabriria passo de demanda já encerrada.
      // Sabotagem: tirar QUALQUER das duas guardas derruba este caso.
      const up = trechoDoUpdate(migration?.sql ?? "");
      expect(up).toMatch(/proximo_passo\s+is null/);
      expect(up).toMatch(/fechada_em\s+is null/);
    });
  });

  describe("apêndice idempotente no baseline (o que o self-host aplica)", () => {
    it("o apêndice espelha o corpo da função ANTES da VARREDURA anon", () => {
      // O marcador do BLOCO (não a palavra solta "VARREDURA anon", que também
      // aparece em prosa no corpo do dump — seria âncora errada).
      const varredura = BASELINE.indexOf("---- VARREDURA anon:");
      // Âncora no marcador ÚNICO do apêndice, e não no nome da função (que se
      // repete na função, nos revokes e no gatilho) — CLAUDE.md item 10.
      const apendice = BASELINE.indexOf(
        "---- a demanda do caso encerrado ganha próximo passo (migration 0505",
      );
      expect(varredura, "marca do bloco da VARREDURA anon não encontrada").toBeGreaterThan(0);
      expect(apendice, "função não está no apêndice do baseline").toBeGreaterThan(-1);
      // Função nova nasce exposta no update.sh; a doutrina (0116) proíbe
      // `create function` DEPOIS da varredura — o apêndice tem de vir antes.
      expect(
        apendice,
        "função criada DEPOIS da VARREDURA anon — self-host esquecerá de revogar",
      ).toBeLessThan(varredura);
      expect(existsSync(join(RAIZ, "baseline.sql"))).toBe(true);
    });

    it("o corpo do apêndice NÃO diverge do da migration 0505", () => {
      const corpoMigration = corpoDe(migration?.sql ?? "", FN);
      const corpoApendice = corpoDe(BASELINE, FN);
      expect(corpoMigration, "corpo na migration não lido").not.toBeNull();
      expect(corpoApendice, "corpo no baseline não lido").not.toBeNull();
      // Quem aplica a cadeia e quem aplica o baseline recebem o mesmo gatilho.
      expect(corpoApendice).toBe(corpoMigration);
    });
  });
});

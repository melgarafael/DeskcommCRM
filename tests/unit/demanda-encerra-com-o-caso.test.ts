/**
 * O CASO CANCELADO/RESOLVIDO ENCERRA A DEMANDA QUE ELE ABRIU (issue #2035 · Parte 2).
 *
 * A IA abre um caso de escalação por handoff; esse caso abre uma demanda
 * (`origem='handoff'`, `agent_case_id` preenchido, `estado='em_atendimento'`).
 * Quando o caso chega a `resolved`/`cancelled`, a demanda ligada ficava ABERTA:
 * `fechada_em` nulo, sem próximo passo — presa no Radar, invisível em "Demandas
 * abertas" do painel. Nada a alcançava:
 *
 *   * `fn_demanda_fecha_com_conversa` (0138) só dispara quando a CONVERSA vai a
 *     `resolved`/`closed` — o handoff de caso arquiva a conversa, que não chega
 *     lá;
 *   * `fn_demanda_encerrar` exige ator humano e revisão — um caso cancelado
 *     pelo próprio agente não a chama.
 *
 * A garantia deste PR vive no BANCO: o gatilho `trg_demanda_fecha_com_caso`
 * (migration 0502) fecha a demanda por `agent_case_id` quando o caso chega a um
 * desfecho. É SQL sem harness local (não há Postgres no `vitest run`), então o
 * contrato é PINADO pela leitura do fonte — o mesmo padrão de
 * `tests/unit/aviso-event-dead-concorrente-abre-uma-vez.test.ts` (§1: a
 * garantia está no SQL do repositório e é essa leitura que decide). Se alguém
 * apagar a migration, trocar o `WHEN` ou relaxar a guarda de reaparecimento, um
 * caso abaixo fica VERMELHO na hora.
 *
 *   npx vitest run tests/unit/demanda-encerra-com-o-caso.test.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = join(process.cwd(), "supabase");
const MANIFEST = readFileSync(join(RAIZ, "migrations", "MANIFEST.md"), "utf8");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");

/** O arquivo da migration 0502 (a fonte da verdade da cadeia). */
const migration0501 = (() => {
  const nome = readdirSync(join(RAIZ, "migrations"))
    .filter((f) => /_0502_demanda_encerra_com_o_caso\.sql$/.test(f))
    .sort()
    .at(-1);
  return nome ? { nome, sql: readFileSync(join(RAIZ, "migrations", nome), "utf8") } : null;
})();

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

describe("a demanda aberta pelo caso encerra com o caso (fix 0502 · #2035)", () => {
  it("a migration 0502 existe (sabotagem: apagar o arquivo derruba este caso)", () => {
    expect(migration0501, "migration 0502 ausente da cadeia").not.toBeNull();
  });

  it("está registrada no MANIFEST como migration aplicada", () => {
    expect(MANIFEST).toContain("| `20261001000000` | `0502_demanda_encerra_com_o_caso` |");
  });

  describe("gatilho em agent_cases", () => {
    it("cria a função de gatilho e a revoga de public/anon/authenticated", () => {
      const fn = migration0501?.sql ?? "";
      expect(fn).toMatch(/create or replace function public\.fn_demanda_fecha_com_caso\(\)/);
      expect(fn).toMatch(/returns trigger/);
      expect(fn).toMatch(/security definer/);
      expect(fn).toMatch(/revoke execute on function public\.fn_demanda_fecha_com_caso\(\) from public, anon;/);
      expect(fn).toMatch(/revoke execute on function public\.fn_demanda_fecha_com_caso\(\) from authenticated;/);
    });

    it("dispara APÓS a virada de status, quando o caso chega a resolved|cancelled", () => {
      const fn = migration0501?.sql ?? "";
      expect(fn).toMatch(/after update of status on public\.agent_cases/);
      // O `WHEN` é a régua do bug: sem `'cancelled'` aqui, o caso cancelado
      // não encerra nada — a parte 2 da issue #2035 volta. Sabotagem: trocar
      // `cancelled` por outro valor derruba este caso.
      expect(fn).toMatch(
        /old\.status is distinct from new\.status\s+and new\.status in \('resolved','cancelled'\)/,
      );
      expect(fn).toMatch(/execute function public\.fn_demanda_fecha_com_caso\(\);/);
    });

    it("fecha a demanda ligada por agent_case_id, só se ainda estiver aberta", () => {
      const fn = migration0501?.sql ?? "";
      // A guarda `fechada_em is null` é o que torna o fecho idempotente sob
      // reaplicação e corrida — e o que impede de reescrever demanda já encerrada.
      expect(fn).toMatch(/agent_case_id\s*=\s*new\.id/);
      expect(fn).toMatch(/fechada_em is null/);
      expect(fn).toMatch(/fechada_em\s*=\s*clock_timestamp\(\)/);
      expect(fn).toMatch(/estado\s*=\s*v_estado/);
    });

    it("mapeia o desfecho do caso para o desfecho/estado coerente da demanda", () => {
      const fn = migration0501?.sql ?? "";
      expect(fn).toMatch(/new\.status = 'resolved'[\s\S]*v_estado\s*:=\s*'resolvida'/);
      expect(fn).toMatch(/new\.status\s*=\s*'resolved'[\s\S]*v_desfecho\s*:=\s*'resolvida'/);
      expect(fn).toMatch(/new\.status = 'cancelled'[\s\S]*v_estado\s*:=\s*'encerrada'/);
      expect(fn).toMatch(/new\.status\s*=\s*'cancelled'[\s\S]*v_desfecho\s*:=\s*'nao_procede'/);
    });

    it("NÃO encerra a demanda quando o caso é apenas escalado (problema segue em trabalho)", () => {
      // A semântica de `escalated` (0136) mantém a demanda em atendimento; o
      // WHEN restringe o gatilho a resolved/cancelled. Sabotagem: pôr
      // `escalated` na cláusula in derruba este caso.
      const quando = /when \([^)]*new\.status in \(([^)]*)\)/i.exec(migration0501?.sql ?? "");
      expect(quando).not.toBeNull();
      expect(quando![1]).not.toContain("escalated");
    });
  });

  describe("apêndice idempotente no baseline (o que o self-host aplica)", () => {
    it("o apêndice espelha o corpo da função ANTES da VARREDURA anon", () => {
      // O marcador do BLOCO (não a palavra solta "VARREDURA anon", que também
      // aparece em prosa no corpo do dump — seria âncora errada).
      const varredura = BASELINE.indexOf("---- VARREDURA anon:");
      // Âncora no marcador ÚNICO do apêndice (uma ocorrência no baseline), e
      // não no nome `fn_demanda_fecha_com_caso` (que se repete na função, nos
      // revokes e no gatilho) — CLAUDE.md item 10: primeira ocorrência de
      // texto repetido mede a definição morta.
      const apendice = BASELINE.indexOf(
        "---- a demanda aberta pelo caso encerra com o caso (migration 0502",
      );
      expect(varredura, "marca do bloco da VARREDURA anon não encontrada").toBeGreaterThan(0);
      // Função nova nasce exposta no update.sh; a doutrina (0116) proíbe
      // `create function` DEPOIS da varredura — o apêndice tem de vir antes.
      expect(apendice, "função não está no apêndice do baseline").toBeGreaterThan(-1);
      expect(apendice, "função criada DEPOIS da VARREDURA anon — self-host esquecerá de revogar").toBeLessThan(varredura);
    });

    it("o corpo do apêndice NÃO diverge do da migration 0502", () => {
      const corpoMigration = corpoDe(migration0501?.sql ?? "", "fn_demanda_fecha_com_caso");
      const corpoApendice = corpoDe(BASELINE, "fn_demanda_fecha_com_caso");
      expect(corpoMigration, "corpo na migration não lido").not.toBeNull();
      expect(corpoApendice, "corpo no baseline não lido").not.toBeNull();
      // Quem aplica a cadeia e quem aplica o baseline recebem o mesmo gatilho.
      expect(corpoApendice).toBe(corpoMigration);
    });
  });
});
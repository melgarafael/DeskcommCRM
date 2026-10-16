import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RECUSA PERMANENTE NÃO SAI COM `40001`.
 *
 * `40001` é serialization_failure: "tente de novo". O PostgREST 14 acredita e
 * refaz a transação sozinho, sem limite. Numa recusa que nunca vai passar
 * (revisão velha, claim vencido, estado que não volta), isso vira um laço que
 * derruba a instalação inteira — medido numa VPS self-hosted no #2805, e
 * reproduzido na triagem com `postgrest/postgrest:v14.17`: UM POST, mais de 55
 * mil execuções em 3 s. A saída é `PT409` (migrations 0363, 0514, 0654).
 *
 * A cerca lê a ÚLTIMA definição de cada função — no baseline (o que o kit
 * self-host aplica) e na cadeia de migrations — e reprova todo
 * `raise exception '<x>' ... errcode='40001'` cujo `<x>` não esteja na lista
 * de conflitos em que REPETIR é a resposta certa. Recusa nova com `40001` tem
 * de entrar nesta lista com o porquê, ou sair com `PT409`.
 */
const REPETIR_PASSA = new Map<string, string>([
  ["service_contact_changed", "o contato mudou entre a leitura e o lock; a nova tentativa relê e passa"],
  ["appointment_notice_busy", "trava do aviso do Meet ocupada por outra escrita"],
  ["contact_redaction_busy", "trava da anonimização ocupada por outra escrita"],
]);

const RAIZ = join(__dirname, "..", "..", "supabase");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");
const CADEIA = readdirSync(join(RAIZ, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(RAIZ, "migrations", f), "utf8"))
  .join("\n");

type Recusa = { funcao: string; mensagem: string; errcode: string };

/** ÚLTIMA definição de cada função (chave: nome + aridade). */
function ultimasDefinicoes(sql: string): Map<string, { funcao: string; corpo: string }> {
  const ultima = new Map<string, { funcao: string; corpo: string }>();
  const cabecalho = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?(\w+)"?\s*\(/gi;
  for (const m of sql.matchAll(cabecalho)) {
    let i = m.index + m[0].length;
    let profundidade = 1;
    let virgulas = 0;
    const inicioArgs = i;
    while (profundidade > 0 && i < sql.length) {
      const c = sql[i++];
      if (c === "(") profundidade++;
      else if (c === ")") profundidade--;
      else if (c === "," && profundidade === 1) virgulas++;
    }
    const aridade = sql.slice(inicioArgs, i - 1).trim() === "" ? 0 : virgulas + 1;
    // O delimitador é lido do texto (`$$`, `$fn$`…), nunca `end $$;` fixo: o pg_dump escreve em maiúsculas.
    const abertura = /\$(\w*)\$/.exec(sql.slice(i));
    if (!abertura) continue;
    const inicioCorpo = i + abertura.index + abertura[0].length;
    const fim = sql.indexOf(abertura[0], inicioCorpo);
    if (fim < 0) continue;
    const funcao = (m[1] ?? "").toLowerCase();
    ultima.set(`${funcao}/${aridade}`, { funcao, corpo: sql.slice(inicioCorpo, fim) });
  }
  return ultima;
}

function recusasVigentes(sql: string): Recusa[] {
  const recusas: Recusa[] = [];
  for (const { funcao, corpo } of ultimasDefinicoes(sql).values()) {
    for (const [, mensagem = "", errcode = ""] of corpo.matchAll(/raise\s+exception\s+'([^']+)'[^;]*?errcode\s*=\s*'(\w+)'/gi)) {
      recusas.push({ funcao, mensagem, errcode: errcode.toUpperCase() });
    }
  }
  return recusas;
}

type Handler = { funcao: string; condicao: string; capturaPT409: boolean };

/**
 * Handlers que capturam o código ANTIGO (`serialization_failure` / `sqlstate '40001'`)
 * em funções cuja última definição levanta `PT409` — direto ou por qualquer função
 * que ela chame, transitivamente. Trocar o errcode sem trocar o handler faz a recusa
 * escapar dele: foi o que a 0654 fez em `fn_appointment_recover` antes do ajuste
 * (o recibo 'stale' e o aviso na Central sumiam).
 */
function handlersDoCodigoAntigo(sql: string): Handler[] {
  const defs = [...ultimasDefinicoes(sql).values()];
  const nomes = new Set(defs.map((d) => d.funcao));
  const chama = new Map<string, Set<string>>();
  for (const { funcao, corpo } of defs) {
    const alvos = chama.get(funcao) ?? new Set<string>();
    for (const [, nome = ""] of corpo.matchAll(/\b(\w+)\s*\(/g)) {
      const n = nome.toLowerCase();
      if (n !== funcao && nomes.has(n)) alvos.add(n);
    }
    chama.set(funcao, alvos);
  }
  const levantaPT409 = new Set(defs.filter((d) => /errcode\s*=\s*'PT409'/i.test(d.corpo)).map((d) => d.funcao));
  for (let mudou = true; mudou; ) {
    mudou = false;
    for (const [funcao, alvos] of chama) {
      if (!levantaPT409.has(funcao) && [...alvos].some((a) => levantaPT409.has(a))) {
        levantaPT409.add(funcao);
        mudou = true;
      }
    }
  }
  const handlers: Handler[] = [];
  for (const { funcao, corpo } of defs) {
    if (!levantaPT409.has(funcao)) continue;
    for (const [, condicao = ""] of corpo.matchAll(/\bwhen\s+([\s\S]*?)\s+then\b/gi)) {
      if (!/serialization_failure|sqlstate\s+'40001'/i.test(condicao)) continue;
      handlers.push({ funcao, condicao, capturaPT409: /sqlstate\s+'PT409'/i.test(condicao) });
    }
  }
  return handlers;
}

describe.each([
  ["baseline.sql", BASELINE],
  ["cadeia de migrations", CADEIA],
])("recusa permanente não pede repetição — %s", (_nome, sql) => {
  const recusas = recusasVigentes(sql);

  it("nenhuma recusa permanente sai com 40001", () => {
    const pedemRepeticao = recusas
      .filter((r) => r.errcode === "40001" && !REPETIR_PASSA.has(r.mensagem))
      .map((r) => `${r.funcao}: ${r.mensagem}`);
    expect(pedemRepeticao).toEqual([]);
  });

  it("handler que capturava 40001 em volta de quem agora levanta PT409 captura os dois", () => {
    const escapam = handlersDoCodigoAntigo(sql)
      .filter((h) => !h.capturaPT409)
      .map((h) => `${h.funcao}: when ${h.condicao}`);
    expect(escapam).toEqual([]);
  });

  it("a sonda enxerga os dois lados (não está cega)", () => {
    // Sem isto, a cerca dos handlers fica verde por não achar nenhum.
    expect(handlersDoCodigoAntigo(sql).some((h) => h.funcao === "fn_appointment_recover")).toBe(true);
    // Se o parser parar de achar corpos, o teste acima fica verde por vazio.
    expect(recusas.some((r) => r.funcao === "fn_service_status" && r.mensagem === "service_contact_changed" && r.errcode === "40001")).toBe(true);
    expect(recusas.some((r) => r.funcao === "fn_service_event_origin" && r.mensagem === "service_stale" && r.errcode === "PT409")).toBe(true);
  });
});

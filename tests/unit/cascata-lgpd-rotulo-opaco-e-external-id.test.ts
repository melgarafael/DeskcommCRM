/**
 * A CASCATA DE LGPD PARA DE DERIVAR O RÓTULO DO ID E PARA DE DEIXAR O TELEFONE NA LINHA QUE
 * FICA — issue #2342. Catraca barata que roda em todo `pnpm test:unit`, sem Postgres.
 *
 * ─── Os dois consertos de SQL, medidos no texto ──────────────────────────────────────────────
 *
 *   1. `v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8)`
 *      virou `v_anon_label := public.fn_lgpd_rotulo_anonimizado(p_contact_id)`. O sufixo deixa
 *      de ser o id encurtado (pseudonimização) e passa a ser opaco: 32 bits de aleatoriedade,
 *      gerados uma vez, gravados no contato no passo 1. Hash com sal NÃO resolveria — quem tem
 *      o banco tem também o sal, e aí basta recalcular o hash de cada id.
 *   2. o passo 3 de `messages` passou a gravar `external_id = null`: a coluna guarda o
 *      TELEFONE do titular, e era a última PII viva das linhas que RESTAM depois do pedido de
 *      exclusão.
 *
 * ─── Por que o EFEITO não basta ──────────────────────────────────────────────────────────────
 *
 * `tests/invariants/lgpd-rotulo-opaco-e-external-id.test.ts` mede o efeito no banco, mas só
 * roda em `pnpm test:db`. Aqui fica a catraca de texto: a última definição da cadeia E a do
 * apêndice do baseline são as que o Postgres deixa de pé, e elas têm de carregar as duas
 * mudanças — o `create or replace` de uma migration nova (forward-fix), sem reescrever a
 * 0119, que já está aplicada em toda instalação.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR_MIGRACOES = join(process.cwd(), "supabase", "migrations");
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const NOME = "fn_lgpd_cascade_redact_contact";
const MARCA = `create or replace function public.${NOME}(`;

/** A definição que o Postgres deixa de pé: a ÚLTIMA do texto (`create or replace`). */
function ultimaDefinicao(texto: string): string {
  const inicio = texto.lastIndexOf(MARCA);
  if (inicio < 0) return "";
  const fim = texto.indexOf("create or replace function", inicio + MARCA.length);
  return texto.slice(inicio, fim < 0 ? texto.length : fim);
}

function ler(nome: string): string {
  return readFileSync(join(DIR_MIGRACOES, nome), "utf8");
}

const arquivos = readdirSync(DIR_MIGRACOES)
  .filter((f) => f.endsWith(".sql"))
  .sort();
/** Toda migration, em ordem, que redefine a função — a última é a que vale. */
const queRedefinem = arquivos.filter((f) => ler(f).includes(MARCA));
const ultimaNaCadeia =
  queRedefinem.length > 0 ? ultimaDefinicao(ler(queRedefinem[queRedefinem.length - 1]!)) : "";
const ultimaNoBaseline = ultimaDefinicao(BASELINE);

/** O rótulo opaco: a chamada da função nova, no lugar da expressão com o id. */
const ROTULO_OPACO = "v_anon_label := public.fn_lgpd_rotulo_anonimizado(p_contact_id);";
/** O defeito: o sufixo era a cauda do uuid do contato. */
const ROTULO_DO_ID = "substring(p_contact_id::text from 1 for 8)";
/**
 * O outro defeito, medido pela AUSÊNCIA: o passo 3 de `messages` (0620) redigia corpo,
 * mídia e metadata, e a coluna `external_id` — o telefone do titular — ficava fora do `set`,
 * legível na linha que resta. O conserto é a linha nova `external_id = null,`.
 */
const PASSO_3_MARCA = "media_derived_text = null,";

describe("a cascata de LGPD tem rótulo opaco e zera o external_id (#2342)", () => {
  it("a sonda está viva — a função existe nas duas origens e a cadeia tem história", () => {
    expect(queRedefinem.length, "nenhuma migration redefine a cascata — o parser mudou?").toBeGreaterThan(1);
    expect(ultimaNoBaseline, "a última definição da cascata sumiu do baseline").not.toBe("");
    expect(ultimaNaCadeia, "nenhuma migration redefine a cascata").not.toBe("");
    // A 0019 é onde a cascata nasceu; ela continua na árvore com o corpo de antes.
    expect(queRedefinem.some((f) => f.includes("_0019_"))).toBe(true);
  });

  it("NA CADEIA: o rótulo vem da função nova, e não há pedaço do id nele", () => {
    expect(ultimaNaCadeia, "a última definição da cadeia não chama a função de rótulo opaco").toContain(
      ROTULO_OPACO,
    );
    expect(
      ultimaNaCadeia,
      "a última definição da cadeia ainda deriva o rótulo do id do contato",
    ).not.toContain(ROTULO_DO_ID);
  });

  it("NO BASELINE: o mesmo, corpo a corpo", () => {
    expect(ultimaNoBaseline, "o apêndice do baseline não chama a função de rótulo opaco").toContain(
      ROTULO_OPACO,
    );
    expect(
      ultimaNoBaseline,
      "o apêndice do baseline ainda deriva o rótulo do id do contato",
    ).not.toContain(ROTULO_DO_ID);
  });

  it("o passo de `messages` zera o `external_id`, e o resto do passo continua igual", () => {
    // Zerar a coluna não pode virar "apagar a linha": o corpo continua virando texto fixo e
    // `status`/`conversation_id` continuam fora do `set` — é o que o invariante de efeito
    // mede no banco.
    for (const [origem, texto] of [
      ["cadeia", ultimaNaCadeia],
      ["baseline", ultimaNoBaseline],
    ] as const) {
      expect(texto, `o passo 3 do ${origem} não zera o external_id`).toContain(
        "external_id = null,",
      );
      expect(texto, `o passo 3 do ${origem} deixou de redigir o corpo`).toContain(
        "body = '[mensagem anonimizada]'",
      );
      expect(texto, `o passo 3 do ${origem} não redige mais mídia`).toContain(PASSO_3_MARCA);
    }
  });

  it("o conserto é FORWARD-FIX: sai em uma migration posterior às já aplicadas", () => {
    const ultima = queRedefinem[queRedefinem.length - 1]!;
    expect(ultima, "o conserto reescreveu uma migration já aplicada em vez de abrir uma nova").not.toMatch(
      /_(0019|0477|0482|0483|0497|0620)_/,
    );
    expect(ler(ultima), "a migration do conserto não carrega o rótulo opaco").toContain(ROTULO_OPACO);
  });

  it("a 0620 continua com o corpo antigo — a história não foi reescrita", () => {
    const aplicada = queRedefinem.find((f) => f.includes("_0620_"));
    expect(aplicada, "a 0620 sumiu da árvore").toBeTruthy();
    const texto = ler(aplicada!);
    expect(texto, "a 0620 foi editada — migration aplicada é intocável").toContain(ROTULO_DO_ID);
    // Âncora de linha, e não substring solta: o passo de `orders` da 0620 tem
    // `customer_external_id = null,`, que CONTÉM a substring sem ser o conserto do
    // passo 3. O que não pode existir é `external_id` como coluna zerada no SET.
    expect(texto, "a 0620 foi editada — o passo 3 dela não mexia no external_id").not.toMatch(
      /^\s*external_id = null,$/m,
    );
  });

  it("a função de rótulo existe no baseline, ANTES do bloco da VARREDURA anon", () => {
    // O bloco da VARREDURA anon (0116) é o último do baseline de propósito e proíbe
    // `create function` depois dele: um apêndice colocado do lado errado seria engolido pela
    // varredura do update.sh.
    const helper = BASELINE.indexOf("create or replace function public.fn_lgpd_rotulo_anonimizado(");
    const varredura = BASELINE.indexOf("-- ---- VARREDURA anon:");
    expect(helper, "a função de rótulo opaco não está no baseline").toBeGreaterThan(-1);
    expect(varredura, "o bloco da VARREDURA anon sumiu do baseline").toBeGreaterThan(-1);
    expect(helper, "a função de rótulo opaco ficou DEPOIS da VARREDURA anon").toBeLessThan(varredura);
    // E ela não deriva nada do id: a chamada não existe no corpo dela.
    const fim = BASELINE.indexOf("create or replace function", helper + 10);
    const corpo = BASELINE.slice(helper, fim < 0 ? BASELINE.length : fim);
    // Comentário não é código: o corpo guarda, de propósito, a história do sufixo antigo
    // (`substring(id::text from 1 for 8)` é o defeito sendo explicado). O que se mede aqui
    // é a parte EXECUTÁVEL — é ela que gera o rótulo que fica no banco.
    const executavel = corpo
      .split("\n")
      .filter((linha) => !linha.trim().startsWith("--"))
      .join("\n");
    expect(executavel).toContain("md5(random()::text || clock_timestamp()::text)");
    expect(executavel, "a função de rótulo leu o id para gerar o sufixo").not.toContain(
      "::text from 1 for 8",
    );
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O DESEMPATE PELO METADADO E O MARCADOR `juntou` ESTÃO NO TEXTO DOS DOIS
 * ARTEFATOS (issue #2801).
 *
 * O comportamento é medido em Postgres por
 * `tests/invariants/tags-juntar-guarda-a-cor.test.ts` (`pnpm test:db`); este
 * arquivo é a catraca BARATA que roda no `verify` e pega a regressão no PR que
 * a introduz, antes de custar um ciclo de Postgres.
 *
 * O que ele vigia, e por que texto: o kit self-host aplica SÓ o `baseline.sql`
 * (`install.sh` em banco novo, `update.sh` em existente). Uma migration correta
 * com o apêndice velho significa que o cliente recebe o defeito enquanto o repo
 * diz entregou o conserto — e `test:db` não vê, porque ele lê o baseline. O
 * par "última definição no baseline == última na cadeia" é a regra de
 * `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts`; aqui o que
 * se mede é que a última definição das DUAS coisas carrega a correção.
 */

const RAIZ = process.cwd();
const MIGRATION =
  "supabase/migrations/20261018120002_0677_renomear_que_junta_guarda_a_cor_e_avisa.sql";

/** A ÚLTIMA definição da função — é a que o Postgres deixa de pé. */
function ultimaDefinicao(texto: string, fn: string): string {
  const marca = `create or replace function public.${fn}(`;
  let achado = -1;
  for (let i = texto.indexOf(marca); i !== -1; i = texto.indexOf(marca, i + 1)) achado = i;
  if (achado === -1) return "";
  const abertura = /\$([a-z_]*)\$/i.exec(texto.slice(achado, achado + 600));
  if (!abertura) return "";
  const delimitador = abertura[0];
  const fimReal = texto.indexOf(delimitador, achado + abertura.index + delimitador.length);
  if (fimReal === -1) return "";
  // Sem comentários: o corpo CITA o desempate velho para explicar por que ele
  // mudou, e uma aserção negativa sobre o texto cru reprovaria a prosa em vez
  // do código — o instrumento acusando o arquivo por ele falar de si mesmo.
  return texto
    .slice(achado, fimReal + delimitador.length)
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/** O desempate exato que a correção introduz — metadado, antes da ordem. */
const DESEMPATE =
  /order by lower\(x\.chave\),\s*\(\(x\.valor ->> 'cor'\) is not null or \(x\.valor ->> 'descricao'\) is not null\) desc,\s*x\.ord/;

describe("renomear que junta: o desempate e o aviso estão nos DOIS artefatos", () => {
  const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
  const baseline = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");

  it("a migration existe e se descreve no próprio arquivo (não no MANIFEST)", () => {
    // A 02/10/2026 trocou a linha do MANIFEST pela linha `-- manifest:` dentro
    // do próprio .sql: uma linha não tem com quem conflitar quando dois PRs
    // entram juntos (medido: #2009, #2049, #2078, #2080, #2091, #2137).
    expect(migration).toMatch(/^-- manifest: .+/m);
  });

  it("a migration redefine a função na assinatura de CINCO argumentos e reafirma os privilégios", () => {
    expect(migration).toMatch(
      /create or replace function public\.fn_vocabulario_de_tags_operar\(\s*p_org uuid,/,
    );
    // Sem as duas linhas, o EXECUTE que o Postgres dá a PUBLIC na criação fica
    // de pé — alcançável pela anon key, que vai para o browser.
    expect(migration).toMatch(
      /revoke execute on function public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text, text\) from public, anon;/,
    );
    expect(migration).toMatch(
      /grant\s+execute on function public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text, text\) to authenticated, service_role;/,
    );
    // Nenhum grant devolve anon.
    expect(migration).not.toMatch(
      /grant\s+execute\s+on\s+function[\s\S]{0,120}?\bto\b[^;]*\banon\b/,
    );
  });

  it("⭐ a ÚLTIMA definição da migration desempata pelo metadado, antes da ordem", () => {
    const corpo = ultimaDefinicao(migration, "fn_vocabulario_de_tags_operar");
    // Sem o corpo extraído, as asserções abaixo passariam por vacuidade.
    expect(corpo.length).toBeGreaterThan(1000);
    expect(corpo).toMatch(DESEMPATE);
    // E o desempate velho, SOZINHO, não pode sobrar: é ele que fazia a cor
    // sumir conforme a posição da entrada na lista.
    expect(corpo).not.toMatch(/order by lower\(x\.chave\), x\.ord/);
    // O marcador de junção entra no retorno da MESMA função.
    expect(corpo).toMatch(/'juntou', v_juntou/);
  });

  it("⭐ o apêndice do baseline carrega a MESMA correção — é o que o self-host aplica", () => {
    // `test:db` aplica o baseline, e o `update.sh` de toda VPS reaplica ele a
    // cada atualização. Sem o apêndice, o cliente ficava com o defeito e o
    // veredito do gate continuava verde.
    const corpo = ultimaDefinicao(baseline, "fn_vocabulario_de_tags_operar");
    expect(corpo.length).toBeGreaterThan(1000);
    expect(corpo).toMatch(DESEMPATE);
    expect(corpo).not.toMatch(/order by lower\(x\.chave\), x\.ord/);
    expect(corpo).toMatch(/'juntou', v_juntou/);
  });

  it("⭐ a última definição mantém a anulação POR CHAVE da 0673 — excluir uma não apaga as outras", () => {
    // A 0673 (issue #2895) redefine a MESMA função e troca o `when v_remover
    // then null` por uma anulação que só pega a chave excluída. Esta migration
    // parte do corpo dela; partir do anterior traria o defeito de volta.
    for (const texto of [migration, baseline]) {
      const corpo = ultimaDefinicao(texto, "fn_vocabulario_de_tags_operar");
      expect(corpo.length).toBeGreaterThan(1000);
      expect(corpo).not.toMatch(/when v_remover then null/);
      expect(corpo.match(/when v_remover and lower\(btrim\(/g)?.length).toBe(3);
    }
    // E no baseline o bloco desta vem DEPOIS do da 0673, que é a ordem da cadeia.
    expect(baseline.indexOf("-- ---- renomear que junta:")).toBeGreaterThan(
      baseline.indexOf("(migration 0673, issue #2895) ----"),
    );
    expect(baseline.indexOf("(migration 0673, issue #2895) ----")).toBeGreaterThan(-1);
  });

  it("o apêndice entra ANTES da VARREDURA anon — depois dela a cura não o alcança", () => {
    // O corpo do baseline grava `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
    // FUNCTIONS TO anon` em `pg_default_acl`, e a varredura da 0116 tira anon de
    // toda definer que veio ANTES dela. Um `create or replace` colado ABAIXO
    // nasceria exposto e não haveria mais nada depois para consertar —
    // medido numa VPS real (2026-08-07): 6 definer alcançáveis pela anon key.
    // Mesma regra de `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.
    const apendice = migration.indexOf("-- ---- renomear que junta:");
    const varredura = baseline.search(/^-- ---- VARREDURA anon:/m);
    expect(apendice).toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(-1);
    expect(baseline.indexOf("-- ---- renomear que junta:")).toBeLessThan(varredura);
  });
});

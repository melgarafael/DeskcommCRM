/**
 * O `baseline.sql` TEM DE SER RE-APLICÁVEL — é o que o `update.sh` de toda VPS faz.
 *
 * ## Por que este arquivo existe (issue #184, reportada por um self-hoster)
 *
 * O corpo do baseline é um `pg_dump --schema-only` e já tinha recebido uma passada
 * PARCIAL de idempotência que parou no meio: as 38 tabelas viraram
 * `CREATE TABLE IF NOT EXISTS`, mas índices, constraints e policies ficaram como o
 * dump os emitiu. Re-aplicar produzia **301 erros** e, com `ON_ERROR_STOP=1` — que é
 * o que o README, o `docs/SETUP.md` e o `deploy-selfhost` mandam usar —, parava na
 * linha 1918 com `multiple primary keys for table "ai_agent_runs"`.
 *
 * ## O dano real não era o ruído; era uma mudança de RLS que não chegava
 *
 * Quatro `create policy` do apêndice não tinham `drop policy if exists` antes. O
 * `update.sh` roda sem `ON_ERROR_STOP` e **filtra `policy ... already exists` como
 * benigno**, então o `create` errava, o erro era engolido e a policy ANTIGA
 * sobrevivia. Medido, mudando o corpo de duas delas e re-aplicando: o clone ficava
 * com o corpo velho, e a saída do `update.sh` mostrava zero linhas não-benignas ao
 * dono da VPS. É controle de acesso por tenant em `storage.objects` divergindo em
 * silêncio entre a versão publicada e o que o cliente realmente tem.
 *
 * ## Por que policy do CORPO usa guarda e não `drop`+`create`
 *
 * Cada forma resolve um problema diferente e tem um custo diferente:
 *
 *  - **Apêndice (4 policies): `drop` + `create`.** É o único guard em que uma MUDANÇA
 *    de corpo chega ao clone, e é o defeito desta issue. É também a convenção que as
 *    outras ~89 policies do apêndice já seguem.
 *  - **Corpo (32 policies; eram 49 até 2026-09-16): guarda `IF NOT EXISTS`.** Aqui o `drop`+`create` seria
 *    troca ruim: o benefício é nulo (mudança de policy neste repo entra pelo
 *    apêndice, ninguém reescreve o dump) e o custo foi MEDIDO — um `update.sh` que
 *    morre entre o `DROP` e o `CREATE` deixa a tabela **sem** a policy, de forma
 *    persistente. Truncando o baseline no mesmo ponto, com a mesma sonda:
 *      guarda `IF NOT EXISTS` -> policy SOBREVIVEU
 *      `drop` + `create`      -> policy APAGADA
 *    É o mesmo modo de falha que `baseline-constraint-reconstruida.test.ts` condena
 *    para constraints; generalizá-lo para as policies do corpo seria trocar um erro benigno
 *    filtrado por um buraco de isolamento.
 *
 * ## O que este teste NÃO cobre
 *
 * Ele lê o texto do arquivo. Que o ciclo install→update sai 0 com `ON_ERROR_STOP=1`
 * é medido pelo job `invariants` (`scripts/test-db.sh`), que aplica o baseline de
 * verdade num Postgres efêmero. Este aqui é a catraca barata que roda no `verify` e
 * pega a regressão no PR que a introduz, antes de custar um ciclo de Postgres.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const LINHAS = SQL.split("\n");

/**
 * O corpo é o `pg_dump` (caixa ALTA); o apêndice é escrito à mão (caixa baixa).
 * A fronteira é o primeiro bloco rotulado do apêndice.
 */
const INICIO_DO_APENDICE = LINHAS.findIndex((l) => /^-- ---- .* \(migration \d+\) ----/.test(l));

describe("baseline.sql é re-aplicável", () => {
  it("o instrumento está vivo: acha o corpo, o apêndice e a fronteira", () => {
    // Controle positivo. Sem isto, um regex que parou de casar devolve lista vazia,
    // e lista vazia satisfaz "todo elemento" — o gate ficaria verde vigiando nada.
    expect(INICIO_DO_APENDICE, "fronteira corpo/apêndice não encontrada").toBeGreaterThan(1000);
    expect(LINHAS.length, "baseline suspeitosamente curto").toBeGreaterThan(10_000);
    expect(
      (SQL.match(/^CREATE TABLE IF NOT EXISTS /gm) ?? []).length,
      "tabelas do corpo já eram guardadas — se isto zerar, o arquivo não é o que se pensa",
    ).toBeGreaterThan(30);
  });

  it("todo CREATE INDEX do corpo tem IF NOT EXISTS", () => {
    const nus = LINHAS.map((l, i) => ({ l, i }))
      .filter(({ l }) => /^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/.test(l))
      .map(({ l, i }) => `${i + 1}: ${l.slice(0, 70)}`);

    expect(nus, "CREATE INDEX sem IF NOT EXISTS: re-aplicar erra 'relation already exists'").toEqual(
      [],
    );
  });

  it("todo ADD CONSTRAINT está dentro de guarda", () => {
    // O pg_dump emite `ALTER TABLE ONLY x` + `    ADD CONSTRAINT y ...`. A guarda é um
    // `DO $baseline_guard$` aberto nas linhas imediatamente acima — checar isso é mais
    // barato e mais honesto que reimplementar um parser de SQL.
    const semGuarda: string[] = [];
    for (let i = 0; i < LINHAS.length; i++) {
      if (!/^\s+ADD CONSTRAINT /.test(LINHAS[i] ?? "")) continue;
      const janela = LINHAS.slice(Math.max(0, i - 6), i).join("\n");
      if (!janela.includes("DO $baseline_guard$ BEGIN")) {
        semGuarda.push(`${i + 1}: ${(LINHAS[i] ?? "").trim().slice(0, 60)}`);
      }
    }
    expect(
      semGuarda,
      "ADD CONSTRAINT sem guarda: re-aplicar erra 'already exists' / 'multiple primary keys'",
    ).toEqual([]);
  });

  it("todo `add constraint` do APÊNDICE está guardado — e é lá que schema novo entra", () => {
    // A asserção acima usa `/^\s+ADD CONSTRAINT /`: caixa ALTA e indentado, que é a
    // forma do pg_dump — o CORPO. O apêndice é escrito à mão, em caixa baixa, e
    // escapava inteiro da régua. É o pior lugar para um ponto cego: o corpo é
    // gerado e estável, o apêndice é onde toda mudança de schema nova aterrissa.
    //
    // As formas de guarda aceitas são as quatro que o arquivo de fato usa, e não
    // uma só: o Postgres NÃO tem `add constraint if not exists`, então a forma
    // canônica aqui é `drop constraint if exists` + `add` — o que torna idempotente
    // a REGRA, não só a criação (o comentário do próprio baseline em
    // `platform_branding_logo_path` explica isso).
    const semGuarda: string[] = [];
    for (let i = 0; i < LINHAS.length; i++) {
      const m = (LINHAS[i] ?? "").match(/^\s*add constraint\s+([A-Za-z0-9_]+)/);
      if (!m) continue;
      const nome = m[1]!;
      const janela = LINHAS.slice(Math.max(0, i - 10), i).join("\n");
      const guardado =
        // 1. drop+add do MESMO nome — a forma canônica do apêndice
        new RegExp(`drop constraint if exists\\s+${nome}\\b`, "i").test(janela) ||
        // 2. bloco anônimo que engole a duplicata
        /exception when duplicate_object/.test(LINHAS.slice(i, i + 12).join("\n")) ||
        // 3. consulta explícita ao catálogo
        /from pg_constraint/.test(janela) ||
        // 4. a guarda gerada do corpo, caso o apêndice a use
        janela.includes("DO $baseline_guard$ BEGIN");
      if (!guardado) semGuarda.push(`${i + 1}: ${(LINHAS[i] ?? "").trim().slice(0, 60)}`);
    }
    expect(
      semGuarda,
      "add constraint sem drop-if-exists nem guarda: o update.sh do clone erra 'already exists'",
    ).toEqual([]);
  });

  it("toda CREATE POLICY está guardada — e cada zona com a forma que lhe cabe", () => {
    const problemas: string[] = [];
    const linhaDoPrimeiroDrop = new Map<string, number>();
    for (let i = 0; i < LINHAS.length; i++) {
      const d = (LINHAS[i] ?? "").match(/drop policy if exists "?([^"\s]+)"?\s/i);
      const alvo = d?.[1]?.toLowerCase();
      if (alvo && !linhaDoPrimeiroDrop.has(alvo)) linhaDoPrimeiroDrop.set(alvo, i);
    }
    let guardadasNoCorpo = 0;
    let guardadasNoApendice = 0;

    for (let i = 0; i < LINHAS.length; i++) {
      const linha = LINHAS[i] ?? "";
      const m = linha.match(/^(?:CREATE|create) POLICY "?([^"\s]+)"?/i) ?? linha.match(/^create policy "([^"]+)"/);
      if (!m) continue;
      const nome = m[1] ?? "";
      const janela = LINHAS.slice(Math.max(0, i - 4), i).join("\n");

      if (i < INICIO_DO_APENDICE) {
        // CORPO: guarda `IF NOT EXISTS`. Nunca drop — ver o cabeçalho.
        if (janela.includes("FROM pg_policy")) guardadasNoCorpo++;
        else problemas.push(`corpo ${i + 1}: "${nome}" sem guarda IF NOT EXISTS`);
        if (janela.includes("DROP POLICY IF EXISTS")) {
          problemas.push(
            `corpo ${i + 1}: "${nome}" usa drop+create — a janela apaga a policy se o update morrer no meio`,
          );
        }
      } else {
        // APÊNDICE: drop + create, para que uma mudança de corpo CHEGUE ao clone.
        //
        // A régua errou TRÊS vezes por ser estreita demais, e cada erro acusou
        // policy sadia — vale registrar, porque a próxima pessoa a mexer aqui vai
        // escrever a versão estreita de novo:
        //   1. janela de 12 linhas          -> 13 falsos (medição manual)
        //   2. janela de 4 linhas           -> 18 falsos (o apêndice agrupa os drops
        //      de uma tabela e só depois emite os creates: `crm_pipelines_manager_write`
        //      tem o seu 8 linhas acima)
        //   3. exigir o nome ENTRE ASPAS    -> 33 falsos (metade do apêndice escreve
        //      `drop policy if exists cae_select on ...`, sem aspas)
        // A régua correta é: o nome aparece num `drop policy if exists` em QUALQUER
        // ponto anterior, com ou sem aspas. Um gate que acusa o inocente é pior que
        // gate nenhum — ele ensina a ignorá-lo.
        // `linhaDoPrimeiroDrop` é pré-calculado: a versão anterior varria
        // LINHAS.slice(0, i) para CADA policy — quadrático sobre 25 mil linhas,
        // 5 s no normal e 16 s sob carga, contra o limite de 15 s do vitest. Um
        // gate que vermelha por carga da máquina ensina a ignorar vermelho.
        const dropAntes = (linhaDoPrimeiroDrop.get(nome.toLowerCase()) ?? Infinity) < i;
        if (dropAntes) guardadasNoApendice++;
        else problemas.push(`apêndice ${i + 1}: "${nome}" sem drop-if-exists — mudança de corpo não chega`);
      }
    }

    // A lista vem PRIMEIRO: um controle de vacuidade que falha antes dela esconde o
    // que o teste existe para mostrar (foi o que aconteceu na primeira rodada —
    // `expected 47 to be greater than 50` mascarou 33 achados que eram falsos
    // positivos meus, e eu quase os tratei como defeito do baseline).
    expect(problemas).toEqual([]);

    // Guardas de vacuidade, com números MEDIDOS e não chutados (49 no corpo, 80 no
    // apêndice em 2026-08-13; 32 no corpo em 2026-09-16, quando saíram as 17 que o
    // apêndice derruba — ver baseline-nao-constroi-o-que-derruba.test.ts): se o laço
    // parar de achar policies, `problemas` fica vazio e o `toEqual([])` acima passa
    // por omissão. A margem é folgada de propósito — este par existe para pegar
    // regex morto, não para cravar contagem.
    expect(guardadasNoCorpo, "policies guardadas no corpo").toBeGreaterThan(25);
    expect(guardadasNoApendice, "policies guardadas no apêndice").toBeGreaterThan(70);
  });
});

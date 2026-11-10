import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A atualização confere as regras de isolamento antes de dizer "deu certo".
 *
 * ## O incidente — instalação real, 2026-09-12
 *
 * O baseline aplica cada regra como APAGAR e depois CRIAR: é o único jeito
 * portável, porque o Postgres não tem `create or replace policy`. E o
 * `update.sh` roda SEM parar em erro, de propósito, para um clone bagunçado
 * conseguir se curar.
 *
 * As duas coisas juntas têm um desfecho ruim: se o "criar" falha, o "apagar" já
 * valeu. `crm_leads_select` e `crm_leads_update` sumiram, a atualização
 * reportou **success**, e o funil passou a aparecer VAZIO — para todo mundo.
 *
 * O que torna isso pior que um erro: com a regra de leitura ausente e a
 * segurança por linha ligada, o Postgres nega sem reclamar. A tela mostra uma
 * lista vazia, **indistinguível de "não há nada aqui"**. O dono da instalação
 * descobriu horas depois, pelo funil, e não pela atualização que tinha acabado
 * de dizer "concluída com sucesso".
 *
 * `push_subscriptions_own` tinha sumido junto, e ninguém havia notado: as
 * notificações do navegador simplesmente não funcionavam.
 *
 * ## Por que estes casos rodam o AWK de verdade
 *
 * A régua vive no `update.sh`, em awk. Reimplementá-la em TypeScript para poder
 * testá-la criaria duas réguas — e duas réguas divergem, sempre. Estes casos
 * extraem o programa awk do próprio script e o executam. Se alguém mexer na
 * régua, é a régua mexida que é medida.
 */

const RAIZ = process.cwd();
const UPDATE = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit", "update.sh"), "utf8");

describe("o update.sh guarda a evidência e confere o resultado", () => {
  it("⛔ guarda o log do banco — era ele que estava sendo jogado fora", () => {
    // O que o agente registra em `system_update_runs.log_tail` é a CAUDA da
    // atualização (Docker e reinício). O banco acontece antes, e sua saída
    // morria numa variável de shell. Quando as regras sumiram, não havia o que
    // ler: a única evidência que importava tinha sido descartada.
    expect(UPDATE).toMatch(/\.deskcomm-banco\.log/);
  });

  it("⛔ confere as regras de isolamento depois de aplicar o banco", () => {
    expect(UPDATE).toMatch(/pg_policy/);
    expect(UPDATE).toMatch(/faltando=/);
  });

  it("⛔ e GRITA quando falta — silêncio aqui é uma tela vazia lá", () => {
    // A mensagem precisa dizer o que acontece, não só que algo faltou: "regra
    // ausente" não significa nada para quem opera uma VPS. "As telas aparecem
    // vazias" significa.
    const bloco = UPDATE.slice(UPDATE.indexOf("REGRAS DE ISOLAMENTO AUSENTES"));
    expect(bloco.slice(0, 600)).toMatch(/VAZIA/i);
    expect(UPDATE).toMatch(/c_red "⛔ REGRAS DE ISOLAMENTO AUSENTES/);
  });

  it("⛔ NÃO reaplica o arquivo inteiro — isso não converge", () => {
    // ⚠️ ESTE CASO MUDOU DE LADO, e o motivo importa mais que a asserção.
    //
    // Ele cobrava o contrário: "tenta de novo UMA vez antes de gritar". A
    // justificativa era medida e verdadeira até onde ia — reaplicado depois, o
    // mesmo arquivo passou sem um único erro e as regras voltaram.
    //
    // O que faltava medir era se reaplicar CONVERGE. Não converge: a segunda
    // passada devolveu `conversations_select` e levou embora
    // `conversations_agent_insert`; a terceira trocou o conjunto outra vez.
    // Cada passada sorteia, porque cada passada é a mesma corrida de APAGAR e
    // CRIAR 92 vezes que causou o problema.
    //
    // "Funcionou uma vez" não é "resolve". Uma medição a mais virou o oposto.
    expect(UPDATE).not.toMatch(/Tentando aplicar o banco mais uma vez/);
    expect(UPDATE).toMatch(/Recriando exatamente as que faltam/);
  });

  it("⛔ e PARA quando ainda falta — não devolve o CRM ao ar quebrado", () => {
    // Antes o bloco vermelho era impresso e o script seguia para o passo que
    // sobe o app. O CRM voltava sem regra de isolamento, com tela vazia para
    // todo mundo, e o vermelho já tinha rolado para fora da tela.
    const bloco = UPDATE.slice(UPDATE.indexOf("REGRAS DE ISOLAMENTO AUSENTES"));
    expect(bloco.slice(0, 1200)).toMatch(/REGRAS_FALTANDO="\$faltando"/);
    expect(bloco.slice(0, 1200)).toMatch(/\bexit 1\b/);
  });

  it("⛔ para quem fala com o banco ANTES de aplicar, e pendura o trap", () => {
    // A conferência tem de acontecer com os serviços ainda parados: é a única
    // janela sem disputa. E o trap é o que impede um erro no meio de deixar a
    // instalação pela metade.
    //
    // ⚠️ A SONDA DA APLICAÇÃO É `reaplicar_baseline`, e não o `psql … -f /b.sql`.
    // O comando nu não mora mais no `update.sh`: desde a issue #1040 ele vive
    // dentro de `reaplicar_baseline` (`_common.sh`), que repete a passada quando
    // o banco está ocupado. Uma sonda presa ao texto antigo devolve -1 contra um
    // `update.sh` CORRETO — e -1 é sempre "menor que a pausa", ou seja, vermelho
    // que acusa o código de uma ordem que ele respeita.
    const pausa = UPDATE.indexOf("pausar_o_que_fala_com_o_banco");
    const aplica = UPDATE.indexOf('reaplicar_baseline "$PROJECT_DIR/supabase/baseline.sql"');
    expect(pausa).toBeGreaterThan(-1);
    expect(aplica).toBeGreaterThan(pausa);
    expect(UPDATE).toMatch(/trap restaurar_servicos EXIT/);
  });
});

/** Extrai o programa awk do `update.sh` — a régua de verdade, não uma cópia. */
function programaAwk(): string {
  const i = UPDATE.indexOf("esperadas=\"$(awk '");
  const j = UPDATE.indexOf("' supabase/baseline.sql", i);
  return UPDATE.slice(i + "esperadas=\"$(awk '".length, j);
}

const temAwk = (() => {
  try {
    execFileSync("awk", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("awk", ["-W", "version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
})();

describe.skipIf(!temAwk)("a régua: vale a ÚLTIMA operação de cada regra", () => {
  function esperadas(sql: string): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regua-"));
    const arq = path.join(dir, "b.sql");
    fs.writeFileSync(arq, sql, "utf8");
    try {
      const out = execFileSync("awk", [programaAwk(), arq], { encoding: "utf8" });
      return out.split("\n").map((l) => l.trim()).filter(Boolean).sort();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("regra criada e não apagada depois: É esperada", () => {
    expect(esperadas(`create policy "x_select" on public.x for select using (true);`)).toEqual([
      "x_select|x",
    ]);
  });

  it("⛔ regra criada e APAGADA depois: NÃO é esperada", () => {
    // O caso que derruba a régua ingênua. O baseline faz isso de propósito —
    // `conversations_agent_write` vira três regras separadas mais adiante no
    // arquivo. Contar toda criação acusaria uma decisão deliberada, e falso
    // positivo derruba a confiança no aviso inteiro: quem vê o alarme tocar sem
    // motivo aprende a ignorá-lo, e aí ele não serve para o dia em que é real.
    expect(
      esperadas(
        `create policy "velha" on public.x for all using (true);\n` +
          `drop policy if exists "velha" on public.x;\n` +
          `create policy "nova" on public.x for select using (true);`,
      ),
    ).toEqual(["nova|x"]);
  });

  it("regra apagada e recriada depois: É esperada — é o padrão do baseline", () => {
    expect(
      esperadas(
        `drop policy if exists "x_select" on public.x;\n` +
          `create policy "x_select" on public.x for select using (true);`,
      ),
    ).toEqual(["x_select|x"]);
  });

  it("aceita com e sem aspas — o baseline usa as duas formas", () => {
    // `crm_leads_select` vem com aspas; `push_subscriptions_own`, sem. Uma
    // régua que só entendesse uma delas ignoraria metade das regras em silêncio
    // — e teria aprovado exatamente a instalação quebrada que originou tudo.
    expect(
      esperadas(
        `create policy "com_aspas" on public.a for select using (true);\n` +
          `create policy sem_aspas on public.b for all using (true);`,
      ),
    ).toEqual(["com_aspas|a", "sem_aspas|b"]);
  });

  it("CONTROLE: sem regra nenhuma, devolve vazio", () => {
    expect(esperadas(`select 1;`)).toEqual([]);
  });
});

/**
 * Extrai o awk que RECRIA as regras que faltam — a régua de verdade, tirada do
 * próprio script, nunca uma cópia. Se alguém mexer nela, é a mexida que é
 * medida.
 */
function programaAwkRecria(): string {
  // Crase e não aspas: a âncora termina numa aspa simples, e escapá-la dentro
  // de uma string de aspas simples é o tipo de linha que se quebra em silêncio
  // na primeira edição.
  const abre = "recria=\"$(awk '";
  const i = UPDATE.indexOf(abre);
  const j = UPDATE.indexOf(`' "$faltam_arq" supabase/baseline.sql`, i);
  return UPDATE.slice(i + abre.length, j);
}

/**
 * Recriar as que faltam — nunca reaplicar o arquivo inteiro.
 *
 * A versão anterior deste script mandava reaplicar o `baseline.sql` e conferir
 * de novo. Era o que eu tinha feito no servidor, e a medição mostrou que não
 * fecha: reaplicar NÃO CONVERGE. A segunda passada devolveu
 * `conversations_select` e levou embora `conversations_agent_insert`; a
 * terceira trocou o conjunto outra vez. Cada passada sorteia, porque cada
 * passada é a mesma corrida de APAGAR e CRIAR 92 vezes.
 */
describe.skipIf(!temAwk)("recriar o que falta: o comando INTEIRO, nunca o nome", () => {
  function recria(sql: string, faltantes: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recria-"));
    const b = path.join(dir, "b.sql");
    const f = path.join(dir, "faltam.txt");
    fs.writeFileSync(b, sql, "utf8");
    fs.writeFileSync(f, faltantes.join("\n") + "\n", "utf8");
    try {
      // Dois arquivos, na ordem que o `NR == FNR` espera: o que falta primeiro,
      // o baseline depois. Nada de `-v`: ele processa escapes no valor e come
      // as barras de um caminho do Windows.
      return execFileSync("awk", [programaAwkRecria(), f, b], { encoding: "utf8" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("GUARDA DE VACUIDADE: o programa foi mesmo encontrado no script", () => {
    // Sem este caso, um `indexOf` que devolvesse -1 faria o programa sair vazio,
    // o awk não imprimir nada, e TODO caso que espera vazio passar por acidente
    // — inclusive a sabotagem, que é a prova mais importante do arquivo.
    expect(programaAwkRecria()).toMatch(/create policy/);
    expect(programaAwkRecria().length).toBeGreaterThan(100);
  });

  it("devolve o comando completo da regra que falta", () => {
    const saida = recria(`create policy "x_select" on public.x for select using (true);\n`, [
      "x_select|x",
    ]);
    expect(saida).toMatch(/create policy "x_select" on public\.x for select using \(true\);/);
  });

  it("⛔ comando de VÁRIAS LINHAS vem inteiro — senão o SQL sai quebrado", () => {
    // As regras reais do baseline ocupam várias linhas. Recriar só a primeira
    // produziria um comando sem `;` e sem predicado — pior que não recriar,
    // porque falharia deixando a impressão de que tentou.
    const saida = recria(
      `create policy "y_all" on public.y\n  for all\n  using (fn_user_org_ids() @> array[organization_id]);\n`,
      ["y_all|y"],
    );
    expect(saida).toMatch(/for all/);
    expect(saida).toMatch(/fn_user_org_ids/);
    expect(saida.trim().endsWith(";")).toBe(true);
  });

  it("⛔ NÃO devolve regra que o arquivo apaga depois — é decisão deliberada", () => {
    const saida = recria(
      `create policy "velha" on public.z for all using (true);\n` +
        `drop policy if exists "velha" on public.z;\n`,
      ["velha|z"],
    );
    expect(saida.trim()).toBe("");
  });

  it("devolve SÓ o que foi pedido, nunca o arquivo inteiro", () => {
    const saida = recria(
      `create policy "a1" on public.a for select using (true);\n` +
        `create policy "b1" on public.b for select using (true);\n`,
      ["a1|a"],
    );
    expect(saida).toMatch(/a1/);
    expect(saida).not.toMatch(/b1/);
  });

  it("⛔ SABOTAGEM: regra que o arquivo não declara NÃO é inventada", () => {
    // A metade que importa da sabotagem. Se a regra não está no baseline, ela
    // não é fabricada — `REGRAS_FALTANDO` continua preenchida e o CRM não volta
    // ao ar (provado no caso 7 do teste de shell).
    const saida = recria(`create policy "existe" on public.a for select using (true);\n`, [
      "sumida|b",
    ]);
    expect(saida.trim()).toBe("");
  });

  it("CONTROLE: nada faltando devolve vazio", () => {
    expect(recria(`create policy "a1" on public.a for select using (true);\n`, []).trim()).toBe("");
  });

  /**
   * A comparação das regras NÃO pode depender do locale de quem roda o update.
   *
   * ## O incidente — instalação real, 2026-09-28
   *
   * `sort` e `comm` precisam concordar na ordenação, e sob um locale UTF-8 eles
   * não concordam. O `en_US.UTF-8` — padrão de muita VPS — ordena IGNORANDO
   * pontuação: `_` e `|` não pesam, e o `sort` devolve uma ordem que o `comm`
   * não reconhece. Ele mesmo denuncia, na stderr — "comm: input is not in
   * sorted order" —, e o que devolve depois é lixo.
   *
   * Com as 114 regras TODAS no banco, a conferência acusou 2 faltando. O alarme
   * falso manda recriar as duas, o banco responde "already exists", a
   * conferência seguinte tropeça na mesma ordenação — e a atualização PARA,
   * com o aviso de manutenção de pé. O dono ficou 8 horas em 503 com o banco
   * íntegro, procurando regra que nunca faltou.
   *
   * ## Por que este caso roda o bash de verdade
   *
   * A comparação vive no `update.sh`, em `sort`/`comm`. Reescrevê-la em
   * TypeScript para poder testá-la criaria duas réguas — e duas réguas
   * divergem. Este caso extrai do script a ordenação e a linha de comparação, e
   * as executa: se alguém tirar o pin do locale, é a linha sem o pin que roda.
   */
  describe.skipIf(!temAwk)("⛔ a conferência não depende do locale de quem roda", () => {
    // O script roda `bash` (usa substituição de processo), então o teste também.
    const BASH = "bash";

    /** A ordenação, com o prefixo que estiver lá — `LC_ALL=C` ou nada. */
    function ordenacao(): string {
      const m = UPDATE.match(/(?:\S+=\S+ )?sort -u/);
      return m ? m[0] : "sort -u";
    }

    /** A linha que compara, inteira e como está no script. */
    function linhaDeComparacao(): string {
      const linha = UPDATE.split("\n").find((l) => l.includes("faltando=") && l.includes("comm -23"));
      return (linha ?? 'faltando="$(comm -23 "$a" "$b")"').trim();
    }

    /** O script sem o pin — a forma SABOTADA, para medir o ambiente. */
    const semPin = (s: string) => s.replace(/\bLC_ALL=\S+ /g, "").replace(/\bLC_COLLATE=\S+ /g, "");

    /**
     * Se o `comm` reclamou — em QUALQUER idioma, sem citar a mensagem.
     *
     * Medido neste host (2026-10-23): `comm (uutils coreutils) 0.10.0` avisa
     * "comm: o arquivo 1 não está em ordem" até com `LC_ALL=C` e
     * `LC_MESSAGES=C` — o texto é fixo, não traduz. O GNU avisa "comm: input
     * is not in sorted order". Citar a frase inglesa faria o caso ficar
     * VERMELHO com o script CORRETO só porque a máquina roda uutils: o caso
     * passaria a medir o ambiente de quem roda, não a regra. O que se quer
     * saber é se houve reclamação — e isso não tem idioma.
     */
    const reclamou = (stderr: string): boolean => stderr.trim().length > 0;

    function comparar(
      a: string[],
      b: string[],
      ordem: string,
      comparacao: string,
      locale: string | undefined,
    ): { faltando: string[]; stderr: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colacao-"));
      const err = path.join(dir, "err");
      // A linha REAL do script, com as listas que vierem — nunca uma cópia da
      // régua. `esperadas`/`existentes` são ordenadas antes, como no script.
      const script = [
        `esperadas="$(printf '%s\\n' "$A" | ${ordem})"`,
        `existentes="$(printf '%s\\n' "$B" | ${ordem})"`,
        comparacao,
        `printf '%s' "$faltando"`,
      ].join("\n");
      // O locale hostil vai só na ORDENAÇÃO: `LC_ALL` também escolhe as
      // mensagens, então ele é apagado daqui, e `LC_MESSAGES=C` é tentado para
      // o GNU. Medido neste host, porém, o `comm (uutils coreutils) 0.10.0`
      // responde em português FIXO até com `LC_MESSAGES=C` — por isso nenhum
      // caso cita a frase do `comm`: mede-se reclamado vs. calado.
      const env: NodeJS.ProcessEnv = { ...process.env, A: a.join("\n"), B: b.join("\n") };
      const colacao = locale ?? env.LC_ALL;
      delete env.LC_ALL;
      if (colacao) {
        env.LC_COLLATE = colacao;
        env.LC_CTYPE = colacao;
      }
      env.LC_MESSAGES = "C";
      try {
        const out = execFileSync(BASH, ["-c", script], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env,
          stdio: ["ignore", "pipe", fs.openSync(err, "w")],
        });
        return {
          faltando: out.split("\n").map((l) => l.trim()).filter(Boolean),
          stderr: fs.readFileSync(err, "utf8"),
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    /** As regras que a conferência ESPERA — a régua awk do próprio script. */
    function esperadas(): string[] {
      const baseline = path.join(RAIZ, "supabase", "baseline.sql");
      const out = execFileSync("awk", [programaAwk(), baseline], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    }

    /**
     * O que a query do `update.sh` devolve: TODA política do schema `public`.
     *
     * ⚠️ O par de listas importa, e a primeira tentativa deste caso errou aqui —
     * listas IDÊNTICAS não reproduzem o defeito (medido: `comm` só reclama
     * quando as duas entradas DIFEREM). O incidente tinha as duas diferentes, e
     * a diferença é estrutural: o `esperadas` traz só as regras cuja ÚLTIMA
     * operação no arquivo é `create`, e o `existentes` traz toda política do
     * schema — inclusive as que o baseline APAGA de propósito. Medido contra o
     * baseline real: 114 esperadas, 152 políticas declaradas em `public`, 38 de
     * diferença. Um banco íntegro é um SUPERCONJUNTO do esperado, e é essa
     * forma que o defeito precisa para aparecer.
     *
     * Isto é dado de entrada, não a régua: a comparação continua sendo a do
     * `update.sh`, extraída de lá.
     */
    function todasAsPoliticasDePublic(): string[] {
      const sql = fs.readFileSync(path.join(RAIZ, "supabase", "baseline.sql"), "utf8");
      const achadas = sql.matchAll(
        /create policy\s+"?([A-Za-z0-9_]+)"?\s+on\s+"?public"?\s*\.\s*"?([A-Za-z0-9_]+)"?/gi,
      );
      return [...new Set([...achadas].map((m) => `${m[1]}|${m[2]}`))];
    }

    /**
     * Um locale que faz o `comm` reclamar, medido e não presumido: nem todo
     * UTF-8 reproduz (o `C.UTF-8` ordena por bytes e é inofensivo), e a lista
     * do que existe muda de máquina para máquina.
     */
    function localeHostil(esperadas: string[], existentes: string[]): string | undefined {
      let disponiveis: string[] = [];
      try {
        disponiveis = execFileSync("locale", ["-a"], { encoding: "utf8" })
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !/^(C|POSIX|C\.(UTF-8|utf8))$/i.test(l));
      } catch {
        return undefined;
      }
      for (const loc of disponiveis) {
        // Sonda: a mesma comparação SEM o pin, com o locale candidato.
        const r = comparar(esperadas, existentes, "sort -u", semPin(linhaDeComparacao()), loc);
        if (reclamou(r.stderr) || r.faltando.length > 0) return loc;
      }
      return undefined;
    }

    it("GUARDA DE VACUIDADE: o script tem o pin, e a linha foi achada", () => {
      // Sem este caso, um `match` que devolvesse o fallback sem pin faria os
      // casos abaixo medirem uma régua que não é a do script — e o de baixo
      // passaria por acidente num ambiente onde a ordenação não é hostil.
      expect(linhaDeComparacao()).toMatch(/comm -23/);
      expect(linhaDeComparacao()).toMatch(/LC_ALL=C/);
      expect(ordenacao()).toMatch(/LC_ALL=C sort -u/);
    });

    it("⛔ TODA comparação e TODA ordenação da conferência carregam o pin", () => {
      // O par `sort`/`comm` tem de concordar, e o pin é o que garante isso. Um
      // `sort -u` novo sem o pin, num passo futuro, traria o defeito de volta
      // pela porta dos fundos — é este caso que o barra.
      const comComm = UPDATE.split("\n").filter((l) => /\bcomm -23/.test(l));
      expect(comComm.length).toBeGreaterThan(0);
      for (const l of comComm) expect(l).toMatch(/LC_ALL=C comm -23/);

      const ordenacoes = UPDATE.split("\n").filter((l) => /\bsort -u/.test(l));
      expect(ordenacoes.length).toBeGreaterThan(0);
      for (const l of ordenacoes) expect(l).toMatch(/LC_ALL=C sort -u/);
    });

    it("⛔ com o banco ÍNTEGRO, a conferência não acusa nada — em qualquer locale", () => {
      const regras = esperadas();
      const noBanco = todasAsPoliticasDePublic();
      expect(regras.length).toBeGreaterThan(50); // o baseline real tem centenas
      // A forma do banco íntegro: tudo que a régua espera ESTÁ lá, e há mais.
      expect(noBanco.length).toBeGreaterThan(regras.length);
      for (const r of regras) expect(noBanco).toContain(r);

      const hostil = localeHostil(regras, noBanco);
      // O ambiente que reproduz o defeito, quando existe. Onde não existe (uma
      // imagem sem locale UTF-8 gerado), o caso do pin segue de pé, e o PR
      // declara o que não foi medido.
      const locais = hostil ? [hostil, undefined] : [undefined];

      for (const loc of locais) {
        const r = comparar(regras, noBanco, ordenacao(), linhaDeComparacao(), loc);
        // Com o pin o `comm` fica CALADO: nem a frase inglesa do GNU nem o
        // português fixo do uutils. Pedir "não contém a frase inglesa" aqui
        // passaria num host uutils até com o aviso na stderr — escondendo
        // exatamente o que este caso existe para pegar. Calado é calado.
        expect(r.stderr).toBe("");
        expect(r.faltando).toEqual([]);
      }
    });

    it("⛔ SABOTAGEM: sem o pin, as mesmas listas acusam regra que existe", () => {
      // A metade que importa: prova que o caso acima sabe ficar vermelho. Se
      // aqui der vazio, este ambiente não exercita o defeito — e o verde do
      // caso anterior não é prova de nada nele.
      const regras = esperadas();
      const noBanco = todasAsPoliticasDePublic();
      const hostil = localeHostil(regras, noBanco);
      if (!hostil) return; // declarado no PR: sem locale hostil, não medido

      const r = comparar(regras, noBanco, "sort -u", semPin(linhaDeComparacao()), hostil);
      // O `comm` reclamou — em português aqui (uutils), em inglês no GNU.
      // Citar a frase de um dos dois amarraria o caso ao ambiente de quem roda.
      expect(r.stderr.trim()).not.toBe("");
      expect(r.faltando.length).toBeGreaterThan(0);
      // E o que ele acusa existe de verdade no banco — é alarme falso, que é o
      // que dói: a tela manda procurar uma regra que nunca faltou.
      for (const f of r.faltando) expect(noBanco).toContain(f);
    });
  });

  it("CONTROLE VIVO: contra o baseline REAL, recria uma regra de verdade", () => {
    // Os casos acima usam SQL de brinquedo. Este roda contra o arquivo que o
    // cliente aplica de fato — e é ele que pega uma régua que só funciona no
    // exemplo. A regra escolhida não é aleatória: `crm_leads_select` é uma das
    // duas que sumiram no incidente e deixaram o funil vazio.
    const baseline = path.join(RAIZ, "supabase", "baseline.sql");
    expect(fs.readFileSync(baseline, "utf8")).toMatch(/create policy "crm_leads_select"/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recria-real-"));
    const f = path.join(dir, "faltam.txt");
    fs.writeFileSync(f, "crm_leads_select|crm_leads\n", "utf8");
    try {
      const saida = execFileSync("awk", [programaAwkRecria(), f, baseline], {
        encoding: "utf8",
      });
      expect(saida).toMatch(/create policy "crm_leads_select" on public\.crm_leads/);
      expect(saida.trim().endsWith(";")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A CHECAGEM DE "NÚMERO DA PRÓPRIA ORGANIZAÇÃO" NÃO PODE CONTAR CONEXÃO ARQUIVADA.
 *
 * ## O defeito que este arquivo vigia
 *
 * A 0292 fechou o laço robô-com-robô do aviso de caso com uma consulta a
 * `channel_sessions` da organização. Ela não pergunta se a conexão está ATIVA —
 * e uma conexão REMOVIDA continua na tabela, com `archived_at` preenchido.
 *
 * O número dela, então, segue recusado como destino do aviso. E o bloqueio é
 * DEFINITIVO, porque existe o outro lado: uma conexão que já teve agente
 * publicado não pode ser apagada (`ai_agent_versions.channel_session_id` é
 * ON DELETE RESTRICT, e o gatilho de imutabilidade recusa soltar a coluna de uma
 * versão publicada ou superseded). As duas regras fazem sentido sozinhas; juntas,
 * o número de uma conexão que já teve agente nunca mais recebe aviso. Medido numa
 * instalação de produção: a saída foi apagar o agente, as versões, os runs, os
 * rascunhos e as conversas para conseguir apagar a conexão.
 *
 * ## O que a régua mede — e o que ela NÃO mede
 *
 * Aqui se mede o TEXTO que o Postgres instala, nos DOIS artefatos que o repo
 * mantém (a cadeia de migrations, que o Supabase CLI aplica, e o apêndice do
 * `baseline.sql`, que o kit self-host aplica) — e a IGUALDADE entre eles, que é
 * o modo de falha silencioso desta casa: um bloco de apêndice NOVO com o corpo
 * novo deixaria o bloco antigo valendo para quem aplica a cadeia, porque a 0292
 * roda antes e `create or replace` de assinatura igual sobrescreve.
 *
 * **NÃO MEDIDO aqui:** o comportamento com dados. Quem prova isso é
 * `tests/invariants/aviso-de-caso-escrita.test.ts`, que roda contra Postgres de
 * verdade no job `invariants` — uma conexão arquivada deixa de bloquear e uma
 * ATIVA continua bloqueando.
 *
 * ## As mutações que este arquivo reprova
 *
 *   · tirar `and s.archived_at is null` da cadeia OU do baseline (o defeito);
 *   · deixar o baseline como estava e criar só a migration (cadeia ≠ baseline);
 *   · apagar a guarda inteira — as asserções de "a proteção continua de pé"
 *     caem junto, e é isso que separa consertar de enfraquecer;
 *   · mudar a guarda de CLIENTE (`p_confirma_contato`), que nada tem a ver com
 *     arquivamento.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** O comentário que abre a guarda. É a âncora; o texto vem por `indexOf` declarado. */
const ABRE_A_GUARDA = "O NÚMERO DE AVISO NÃO PODE SER UM NÚMERO DA PRÓPRIA ORGANIZAÇÃO";
/** A guarda do CLIENTE, que a mudança não toca — e é o controle de "uma coisa só". */
const ABRE_A_GUARDA_DE_CLIENTE = "O número de aviso vira INTERNO";
/** O que fecha cada guarda. */
const FECHA_A_GUARDA = "end if;";
/** O marcador de bloco do apêndice do baseline. */
const MARCA_DE_APENDICE = /^-- ---- .* \(migration \d+\) ----/m;

/** A última definição da função que o Postgres usa. */
function ultimaDefinicao(texto: string): string {
  // O parêntese delimita o nome exato: `_local` é outra função, não uma
  // redefinição da guarda canônica.
  const nome = "create or replace function public.fn_definir_aviso_de_caso(";
  // `lastIndexOf`, nunca `find`: o baseline é dump + apêndice e a ÚLTIMA é a que
  // fica de pé. Ancorar na primeira mede a definição morta.
  const i = texto.lastIndexOf(nome);
  expect(i, `nenhuma definição de fn_definir_aviso_de_caso: ${nome}`).toBeGreaterThan(-1);
  const fim = texto.indexOf("$$;", i);
  return texto.slice(i, fim === -1 ? texto.length : fim + 3);
}

/** O trecho da guarda: do comentário que a abre até o `end if;` que a fecha. */
function guarda(corpo: string, ancora: string): string {
  const i = corpo.indexOf(ancora);
  expect(i, `a guarda ${JSON.stringify(ancora)} sumiu da função`).toBeGreaterThan(-1);
  const j = corpo.indexOf(FECHA_A_GUARDA, i);
  return corpo.slice(i, j === -1 ? corpo.length : j + FECHA_A_GUARDA.length);
}

/** As migrations que trazem o comentário da guarda, em ordem de aplicação. */
const cadeia = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((arquivo) => ({ arquivo, texto: readFileSync(join(MIGRATIONS, arquivo), "utf8") }))
  .filter((x) => x.texto.includes(ABRE_A_GUARDA));

describe("a guarda de número da própria organização, nos dois artefatos", () => {
  it("a sonda ignora um wrapper com sufixo e continua escolhendo a última definição exata", () => {
    const anterior =
      "create or replace function public.fn_definir_aviso_de_caso() returns void as $$ begin perform 'anterior'; end; $$;";
    const vigente =
      "create or replace function public.fn_definir_aviso_de_caso() returns void as $$ begin perform 'vigente'; end; $$;";
    const wrapper =
      "create or replace function public.fn_definir_aviso_de_caso_local() returns void as $$ begin perform public.fn_definir_aviso_de_caso(); end; $$;";
    expect(ultimaDefinicao([anterior, vigente, wrapper].join("\n"))).toBe(vigente);
    expect(ultimaDefinicao([anterior, wrapper, vigente].join("\n"))).toBe(vigente);
  });

  it("o wrapper local reutiliza a função canônica antes de gravar o modo local", () => {
    const local = readFileSync(
      join(MIGRATIONS, "20261008120000_0600_aviso_de_caso_sem_link.sql"),
      "utf8",
    );
    const chamada = local.indexOf("v_resultado := public.fn_definir_aviso_de_caso(");
    const gravacao = local.indexOf("update public.config_aviso_de_caso");
    expect(chamada, "o wrapper deve passar pelas guardas canônicas").toBeGreaterThan(-1);
    expect(gravacao, "o modo local deve ser gravado depois das guardas").toBeGreaterThan(chamada);
    expect(local.slice(chamada, gravacao)).toContain(
      "p_org, p_channel, p_telefone, p_rotulo, p_ligado, p_confirma_contato",
    );
  });

  it("a sonda está viva — a guarda existe na cadeia e no baseline", () => {
    // Sem este controle, um `indexOf` que voltasse -1 faria tudo passar por
    // vacuidade: é a mesma armadilha do "instrumento quebrado devolve zero".
    expect(
      cadeia.length,
      "nenhuma migration traz a guarda — o texto mudou de forma?",
    ).toBeGreaterThan(0);
    expect(MARCA_DE_APENDICE.test(BASELINE), "nenhum rótulo de apêndice no baseline").toBe(true);
    expect(BASELINE).toContain(ABRE_A_GUARDA);
  });

  it("a ÚLTIMA definição na CADEIA deixa a conexão arquivada de fora", () => {
    const ultima = cadeia.at(-1)!;
    const g = guarda(ultimaDefinicao(ultima.texto), ABRE_A_GUARDA);
    expect(
      g,
      `a guarda da 0292 (${ultima.arquivo}) conta a conexão arquivada: o número de uma conexão \
       removida fica bloqueado para sempre como destino do aviso`,
    ).toContain("s.archived_at is null");
  });

  it("a ÚLTIMA definição no BASELINE também — senão a correção não chega a quem tem VPS", () => {
    // O kit self-host aplica SÓ o `baseline.sql`. Migration sem o bloco do
    // apêndice é correção que não sai do repositório.
    const g = guarda(ultimaDefinicao(BASELINE), ABRE_A_GUARDA);
    expect(g, "o apêndice do baseline ficou com o corpo antigo da guarda").toContain(
      "s.archived_at is null",
    );
  });

  it("cadeia e baseline instalam o MESMO corpo da função", () => {
    // O modo de falha silencioso: assinatura igual ⇒ `create or replace`
    // sobrescreve, e quem aplica a cadeia fica com o corpo de antes de um
    // conserto. Comentário reescrito de um lado só é divergência de TEXTO, não de
    // comportamento — por isso se compara o CÓDIGO, sem as linhas de `--`.
    const semComentarios = (sql: string) =>
      sql
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join(" ")
        .replace(/\$[a-z_]*\$/gi, "$$$$")
        .replace(/\s+/g, " ")
        .replace(/\s*([(),])\s*/g, "$1")
        .trim();
    const naCadeia = semComentarios(ultimaDefinicao(cadeia.at(-1)!.texto));
    const noBaseline = semComentarios(ultimaDefinicao(BASELINE));
    expect(
      noBaseline,
      "quem aplica a cadeia e quem aplica o baseline recebem corpos diferentes",
    ).toBe(naCadeia);
  });
});

describe("o conserto não enfraquece o que a guarda protegia", () => {
  it("a conexão ATIVA com o mesmo número continua recusada, nas duas grafias", () => {
    // A proteção inteira: é o laço robô-com-robô que a 0292 fechou. Tirar o
    // filtro de arquivamento é o conserto; tirar o telefone ou a comparação das
    // variantes é abrir o laço de novo.
    const g = guarda(ultimaDefinicao(cadeia.at(-1)!.texto), ABRE_A_GUARDA);
    expect(g).toContain("s.phone_number is not null");
    expect(g).toContain("regexp_replace(s.phone_number, '\\D', '', 'g') = any (v_variantes)");
    expect(g).toContain("raise exception 'aviso_de_caso_numero_da_propria_org'");
  });

  it("a guarda de número que já é CLIENTE não foi tocada — uma coisa só por vez", () => {
    // Ela responde a outra pergunta (o número vira INTERNO e as mensagens daquele
    // cliente param de chegar ao CRM) e continua exigindo `p_confirma_contato`.
    for (const artefato of [cadeia.at(-1)!.texto, BASELINE]) {
      const g = guarda(ultimaDefinicao(artefato), ABRE_A_GUARDA_DE_CLIENTE);
      expect(g).toContain("not coalesce(p_confirma_contato, false)");
      expect(g).toContain("raise exception 'aviso_de_caso_numero_de_cliente'");
      expect(g, "a guarda de cliente passou a ignorar arquivamento também").not.toContain(
        "archived_at",
      );
    }
  });
});

import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * VARREDURA da pergunta da 0149: "a função confere DE QUAL organização é quem
 * chamou?" — para TODAS as funções, não para uma lista de duas.
 *
 * ## O vão entre os gates que já existem
 *
 * Três perguntas parecidas, e cada uma deixa passar o que a outra pega:
 *
 *   - `hardening-definer-varredura.test.ts` — **QUEM** pode executar. Varre
 *     todas. Não olha o corpo: uma definer legitimamente executável por
 *     `authenticated` passa verde mesmo usando o org do ARGUMENTO como único
 *     filtro de tenant.
 *   - `definer-valida-membership.test.ts` — **a função confere o org de quem
 *     chamou?** Mede comportamento de verdade, sob role real, com controle
 *     positivo. É a prova mais forte que existe aqui — e cobre **duas**
 *     funções: `emit_event` e `retrieve_top_k_chunks`.
 *   - este arquivo — a mesma pergunta da 0149, aplicada a **todas**.
 *
 * O vão é função NOVA. Ela nasce fora da lista de duas, e nenhum gate a
 * alcança. Foi medido na prática em 2026-09-12: uma função de etiquetas escrita
 * nesta mesma semana nascia `security definer` recebendo o org por argumento,
 * sem conferir pertencimento — e os gates ficaram todos verdes. Só apareceu
 * porque quem a escreveu sabotou o próprio código de propósito para testar o
 * teste. O produto vende um tenant por cliente: uma organização ler dado de
 * outra não é bug grave, é o fim do produto.
 *
 * O precedente de que trocar lista por varredura paga: a pergunta vizinha
 * (issue #128) era lista fixa de 6, virou varredura, e naquele dia **8 de 25**
 * definer de public estavam expostas com os seis gates obrigatórios verdes.
 *
 * ## A régua, e por que é esta
 *
 * Entra na varredura a função que tem a FORMA do risco — as três condições
 * juntas, medidas no catálogo do Postgres, nunca no texto do arquivo:
 *
 *   1. `security definer` em `public` — roda com o dono, por cima da RLS;
 *   2. executável por `authenticated` — alcançável pelo PostgREST com a sessão
 *      de um usuário logado, que é o atacante que importa aqui (o `anon` é
 *      problema do outro gate, e lá a regra é "nenhuma");
 *   3. **recebe um argumento de organização** — é o que faz o org vir de FORA.
 *      Sem argumento de org, a função só alcança o que ela mesma derivar de
 *      `auth.uid()`, e o vetor desta varredura não existe.
 *
 * Quem tem a forma precisa CONFERIR, e conferir é uma destas três:
 *
 *   - chamar `fn_user_org_ids()` — a mesma função que as policies de RLS usam;
 *   - recusar com `caller_not_authorized_for_org` — o erro que a 0149 criou;
 *   - **perguntar de próprio punho**: consultar `user_organizations` filtrando
 *     por `auth.uid()`. É o que fazem as duas primitivas da casa, e é onde toda
 *     a cadeia termina — `fn_user_org_ids` e `fn_user_role_in_org` têm
 *     exatamente este corpo, e não citam nem uma nem outra das duas marcas
 *     acima. Uma régua que só olhasse as duas primeiras acusaria a base do
 *     próprio sistema de pertencimento de não conferir pertencimento.
 *
 * **E conferir POR DELEGAÇÃO conta.** Esta é a diferença entre um gate que se
 * usa e um que se desliga: a primeira versão desta varredura exigia a marca no
 * corpo da própria função e acusou **18**; medindo uma a uma, **14 já faziam a
 * coisa certa** — `fn_role_at_least` pergunta a `fn_user_role_in_org`,
 * `fn_log_event` repassa a `emit_event`, e as que escrevem (`fn_meet_action`,
 * `fn_reply_action`, `fn_mesclar_contatos`…) passam por `fn_role_at_least`.
 * Um gate que acusa 14 inocentes de uma vez não é rigoroso: ele é ignorado na
 * primeira semana, ou ganha uma allowlist de 14 linhas que ninguém revisa — que
 * é a lista fixa de volta, com outro nome. Por isso a consulta calcula o fecho
 * transitivo de quem confere, em vez de procurar texto.
 *
 * ## O que esta varredura NÃO prova
 *
 * Ela lê o corpo; não executa. Uma função pode citar `fn_user_org_ids` numa
 * linha morta e passar aqui. É por isso que o gate de comportamento continua
 * existindo ao lado, e é por isso que função nova de risco alto merece o seu
 * caso executado lá — o certo é ter os dois, como já acontece com a pergunta
 * do `anon`.
 */

/** Uma exceção só existe com razão escrita — entrada sem razão é dívida muda. */
interface Excecao {
  readonly fn: string;
  readonly razao: string;
}

/**
 * Definer alcançável por `authenticated`, com org no argumento, que NÃO confere
 * pertencimento — e por que isso é aceitável nela.
 *
 * ⚠️ **Esta lista só encolhe.** Lista de exceção que ninguém revisa vira
 * permissão permanente. Entrada nova exige a razão escrita E o motivo de o
 * caminho certo (conferir com `fn_user_org_ids`) não servir.
 */
const SEM_CONFERENCIA_PERMITIDO: readonly Excecao[] = [
  {
    fn: "fn_support_write_allowed(p_org uuid)",
    razao:
      "Ela não CONCEDE nada — só pode tirar. É usada exclusivamente como policy " +
      "RESTRITIVA (`create policy ... as restrictive`, baseline ~18471), que no Postgres " +
      "soma-se por AND às permissivas: devolver `true` deixa a decisão inteira com a " +
      "policy de tenant, que continua exigindo pertencimento. Conferir membership aqui " +
      "não fecharia porta nenhuma, e trocaria o assunto da função: ela responde 'a sessão " +
      "de SUPORTE em curso permite escrever nesta organização?', e para isso já filtra por " +
      "auth.uid() através de fn_support_context(). O `true` quando a org do argumento " +
      "difere da org da sessão é deliberado — fora da org sob suporte, esta restrição não " +
      "tem o que dizer.",
  },
];

interface Fn {
  readonly assinatura: string;
  readonly confere: boolean;
}

/**
 * Pergunta ao CATÁLOGO, não ao arquivo: `prosecdef` é o que o banco tem, e
 * `has_function_privilege` responde pelas DUAS origens de EXECUTE (o grant
 * direto a `authenticated` do `ALTER DEFAULT PRIVILEGES` e o grant a `PUBLIC`
 * que o Postgres dá a toda função ao criá-la). Ler o `baseline.sql` com regex
 * enxergaria só uma delas.
 *
 * `pg_get_function_arguments` traz os NOMES dos parâmetros (é o que permite
 * achar o de organização); `pg_get_function_identity_arguments` traz só os
 * tipos, e é a chave estável para a allowlist.
 */
function varrer(): Fn[] {
  /*
   * Uma linha por função de `public`, com CINCO campos separados por `|`:
   *
   *   assinatura | proname | confere_direto | na_forma_do_risco | quem_ela_chama
   *
   * O banco responde "quem chama quem"; o fecho transitivo é calculado aqui em
   * baixo. A primeira versão fazia o fecho numa CTE `with recursive` e ele
   * **não andava** — `fn_log_event` continuava acusada mesmo repassando para
   * `emit_event`. Em vez de insistir numa recursão que eu não conseguia
   * inspecionar de dentro do teste, a aresta vem crua e o fecho fica em código
   * que dá para depurar e para ler. É também mais honesto sobre o que o gate
   * faz: casamento de nome no corpo, não análise de fluxo.
   */
  const out = sql(`
    with todas as (
      select p.oid,
             p.proname,
             coalesce(p.prosrc, '') as src,
             p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as assinatura,
             (p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'EXECUTE')
              and pg_get_function_arguments(p.oid) ~* '(^|,) *[a-z_]*org[a-z_]* +uuid'
             ) as na_forma_do_risco
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    )
    select f.assinatura,
           f.proname,
           (f.src ~* '(fn_user_org_ids|caller_not_authorized)'
            or (f.src ~* 'user_organizations' and f.src ~* 'auth[.]uid[(][)]'))::int,
           f.na_forma_do_risco::int,
           coalesce(string_agg(distinct g.proname, ','), '')
      from todas f
      left join todas g
        on g.oid <> f.oid
       and f.src ~ ('(^|[^a-z0-9_])' || g.proname || '([^a-z0-9_]|$)')
     group by f.assinatura, f.proname, f.src, f.na_forma_do_risco
     order by 1;
  `);

  interface Bruta {
    readonly assinatura: string;
    readonly proname: string;
    readonly direto: boolean;
    readonly naForma: boolean;
    readonly chama: string[];
  }

  const brutas: Bruta[] = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const c = l.split("|");
      return {
        assinatura: c[0] ?? "",
        proname: c[1] ?? "",
        direto: c[2] === "1",
        naForma: c[3] === "1",
        chama: (c[4] ?? "").split(",").filter(Boolean),
      };
    });

  // Fecho transitivo por NOME: uma função está protegida se confere de próprio
  // punho, ou se chama alguém que está protegida. Repete até parar de crescer —
  // o grafo tem ~230 nós, então o custo é irrelevante e a terminação é garantida
  // (o conjunto só cresce e é limitado).
  const protegidos = new Set(brutas.filter((b) => b.direto).map((b) => b.proname));
  for (;;) {
    const antes = protegidos.size;
    for (const b of brutas) {
      if (protegidos.has(b.proname)) continue;
      if (b.chama.some((n) => protegidos.has(n))) protegidos.add(b.proname);
    }
    if (protegidos.size === antes) break;
  }

  return brutas
    .filter((b) => b.naForma)
    .map((b) => ({ assinatura: b.assinatura, confere: protegidos.has(b.proname) }));
}

const FUNCOES = varrer();
const PERMITIDAS = new Set(SEM_CONFERENCIA_PERMITIDO.map((e) => e.fn));

describe("0149 em varredura — definer com org no argumento confere quem chamou", () => {
  it("CONTROLE: a varredura ACHA funções — se zerar, o resto do arquivo não prova nada", () => {
    // Sem este caso, um erro de digitação no regex do catálogo devolveria lista
    // vazia e todos os casos abaixo ficariam verdes pelo motivo errado. É o
    // mesmo defeito que já deixou um `revoke` sem gate nenhum nesta semana:
    // medir o sintoma e ler o silêncio como aprovação.
    expect(FUNCOES.length).toBeGreaterThan(0);
  });

  it("CONTROLE: as duas funções da 0149 estão no alcance da varredura e conferem", () => {
    // Ancora a régua no caso conhecido. Se `emit_event` sair desta lista, foi o
    // filtro que mudou — não o mundo —, e o resto do arquivo passou a medir
    // outra coisa sem avisar.
    const nomes = FUNCOES.filter((f) => f.confere).map((f) => f.assinatura.split("(")[0]);
    expect(nomes).toContain("emit_event");
    expect(nomes).toContain("retrieve_top_k_chunks");
  });

  it("CONTROLE: a conferência POR DELEGAÇÃO é reconhecida", () => {
    // `fn_log_event` não tem marca nenhuma no corpo: ela repassa para
    // `emit_event`, que confere. Se este caso cair, o fecho transitivo da
    // consulta parou de andar, e a varredura volta a acusar 14 inocentes —
    // o caminho mais curto para o gate ser desligado por quem o encontrar.
    const protegidas = FUNCOES.filter((f) => f.confere).map((f) => f.assinatura.split("(")[0]);
    expect(protegidas).toContain("fn_log_event");
    expect(protegidas).toContain("fn_role_at_least");
  });

  it("⛔ toda definer alcançável com org no argumento confere o pertencimento", () => {
    const faltando = FUNCOES.filter((f) => !f.confere && !PERMITIDAS.has(f.assinatura)).map(
      (f) => f.assinatura,
    );
    expect(
      faltando,
      `Função SECURITY DEFINER alcançável por 'authenticated' que recebe a organização\n` +
        `por argumento e NÃO confere de qual organização é quem chamou. Rodando como dono,\n` +
        `ela passa por cima da RLS: um usuário logado no tenant A a chama com o id do\n` +
        `tenant B.\n\n` +
        `O conserto é o da migration 0149 — conferir com fn_user_org_ids() e recusar com\n` +
        `caller_not_authorized_for_org. Se houver motivo real para não conferir, declare em\n` +
        `SEM_CONFERENCIA_PERMITIDO deste arquivo COM a razão escrita:\n  ` +
        faltando.join("\n  "),
    ).toEqual([]);
  });

  it("a allowlist não guarda função que já não existe (ou que já foi corrigida)", () => {
    const vivas = new Set(FUNCOES.filter((f) => !f.confere).map((f) => f.assinatura));
    const mortas = SEM_CONFERENCIA_PERMITIDO.filter((e) => !vivas.has(e.fn)).map((e) => e.fn);
    expect(
      mortas,
      `Exceção que virou peso morto — REMOVA-A da lista:\n  ${mortas.join("\n  ")}`,
    ).toEqual([]);
  });

  it("toda entrada da allowlist explica o porquê", () => {
    const mudas = SEM_CONFERENCIA_PERMITIDO.filter((e) => e.razao.trim().length < 40).map(
      (e) => e.fn,
    );
    expect(mudas).toEqual([]);
  });
});

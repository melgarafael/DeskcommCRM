/**
 * GET /api/v1/conversations/counts — contagens por visão do inbox (G4-02).
 *
 * Usa o client user-scoped (cookie session) → toda contagem HERDA a RLS de
 * SELECT de `conversations` (fn_can_view_conversation, migration 0035). Um agent
 * em modo own* recebe a contagem do SEU escopo, NUNCA o total da org — a mesma
 * garantia do listing. As abas acionáveis usam head count (`count: 'exact'`,
 * `head: true`), que não devolve linha; as pastas de histórico contam LINHAS até
 * `TETO_DAS_PASTAS` (#4451) — nunca estimativa.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { idsDosCanaisDesativados } from "@/lib/channels/desativado";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import { orgTemAutomatico } from "@/lib/ai/agents/org-tem-automatico";
import { comandosDaFila, comPreFiltroDoComando } from "@/lib/inbox/comando-da-conversa";
import { aplicarMarcadores, modoDeEtiqueta } from "@/lib/inbox/marcador-da-conversa";
import { createClient } from "@/lib/supabase/server";
import { idsDeContatosPessoais, idsDeContatosPessoaisVisiveis } from "../_handler";

export const dynamic = "force-dynamic";

/**
 * O teto das contagens das PASTAS DE HISTÓRICO (#4451).
 *
 * "Fechadas" e "Arquivadas" não podem ser contadas de dois jeitos que este
 * arquivo já teve:
 *
 * - `count: 'exact'` varre o histórico INTEIRO a cada 30 s, por pessoa, em toda
 *   tela — o custo que o #4325 mediu (820 ms de média, 7,3 s de máximo numa
 *   instalação de 270 conversas);
 * - `count: 'planned'` custa barato, mas o planejador do Postgres NUNCA estima
 *   menos de UMA linha: pasta com zero conversas saía `rows=1` no `EXPLAIN`, e
 *   a instalação nova nascia mostrando "1 (aprox.)" numa pasta vazia (#4451).
 *
 * O terceiro caminho — o de agora — conta ATÉ cem LINHAS e para: custo limitado
 * por construção e número EXATO enquanto ele é pequeno, que é o caso de toda
 * pasta recém-criada. No teto o badge diz "99+" em vez de prometer um total que
 * ninguém mediu.
 */
export const TETO_DAS_PASTAS = 100;

/** Um par pronto para virar predicado: coluna e valor. */
export type FiltroDeContagem = readonly [coluna: string, valor: string | boolean];

/**
 * Os filtros AUXILIARES que a lista aplicou e que a contagem tem de aplicar junto.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 * Medido na tela: com "Não lidos" ligado, a lista mostrava ZERO linhas e a aba
 * continuava estampando "Todas 2". Este próprio arquivo já declarava a regra —
 * "um badge que conta o que a aba não mostra manda o atendente procurar trabalho
 * que não existe" — e a regra estava certa: a COBERTURA parou no predicado da
 * aba e nunca alcançou os filtros ao lado dela.
 *
 * ─── Por que uma lista só, e não um `if` por contagem ──────────────────────
 * Uma lista aplicada a TODAS as contagens torna a divergência impossível por
 * construção: não existe o caminho "esqueci de pôr o filtro na contagem X".
 * `tests/unit/badge-espelha-o-filtro.test.ts` vigia que nenhuma contagem seja
 * montada por fora.
 *
 * A busca (`search`) NÃO entra: ela casa contato por uma consulta auxiliar em
 * `contacts`, e repetir aquela lógica aqui criaria uma SEGUNDA régua de busca —
 * e a segunda régua sempre diverge. Enquanto isso, o badge sob busca fica maior
 * que a lista, e isso está declarado, não esquecido.
 */
export function filtrosAuxiliaresDaContagem(
  sp: URLSearchParams,
): FiltroDeContagem[] {
  const filtros: FiltroDeContagem[] = [];
  const canal = sp.get("channel_session_id");
  if (canal) filtros.push(["channel_session_id", canal]);
  // O atendente escolhido pelo gerente. Só id de usuário (uuid) entra: qualquer
  // outra coisa seria ignorada em silêncio e a contagem divergiria da lista.
  // A FILA (#3876): o badge conta a fila ESCOLHIDA, não todas. Sem esta linha o
  // seletor de fila mostraria "Fila 7" listando 2 — a divergência que este
  // arquivo existe para impedir, pelo caminho do setor em vez do de canal.
  const fila = sp.get("sector_id");
  if (fila && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fila)) {
    filtros.push(["sector_id", fila]);
  }
  const atendente = sp.get("assigned_to");
  if (atendente && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(atendente)) {
    filtros.push(["assigned_to_user_id", atendente]);
  }
  // O MARCADOR não entra nesta lista, e não é esquecimento: ele não é
  // IGUALDADE numa coluna, é um `or=` sobre DUAS caixas — `conversations.tags`
  // e o campo calculado do contato. `conversations` não tem coluna `tag` (`tag`
  // é o nome do parâmetro da URL): com ele aqui, o laço lá embaixo pedia
  // `.eq("tag", …)`, o PostgREST devolvia 42703 (`undefined_column`) e a rota
  // INTEIRA respondia 500 — com um marcador filtrado, toda aba do Inbox ficava
  // sem número, a "Fechadas" inclusive (#1223). Quem aplica o marcador é
  // `aplicarMarcador`, a mesma régua que a lista usa.
  return filtros;
}

/** Verdadeiro quando a contagem deve pedir só as não lidas. */
export function contagemSoNaoLidas(sp: URLSearchParams): boolean {
  return sp.get("unread") === "true";
}

/** O que o badge das pastas de histórico recebe: número a mostrar e se parou no teto. */
export type PlacarDasPastas = {
  /** O número da tela: no máximo `TETO_DAS_PASTAS - 1` (99), e ZERO na pasta vazia. */
  count: number;
  /** `true` quando as cem linhas vieram: o número é "pelo menos 100". */
  truncada: boolean;
  error: { message: string } | null;
};

/**
 * Lê o resultado de `linhasCom()` — LINHAS, não contagem (#4451).
 *
 * A pasta vazia devolve `data: []` e portanto ZERO. É o caso que o `count:
 * 'planned'` não sabia responder (o planejador do Postgres nunca estima menos de
 * uma linha) e que fazia a instalação nova nascer com "1 (aprox.)" no histórico.
 *
 * No teto o número mostrado para em 99 e `truncada` avisa a tela: "99+" é
 * honesto, "100" seria um total que ninguém contou.
 */
export function placarDasLinhas(resposta: {
  data: unknown[] | null;
  error: { message: string } | null;
}): PlacarDasPastas {
  const linhas = resposta.data?.length ?? 0;
  return {
    count: Math.min(linhas, TETO_DAS_PASTAS - 1),
    truncada: linhas >= TETO_DAS_PASTAS,
    error: resposta.error,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail(
      "no_active_org",
      traduzir("No active organization.", authUser?.idioma ?? "pt-BR"),
      403,
      { requestId },
    );
  }

  const org = activeOrg.orgId;
  const sp = req.nextUrl.searchParams;
  const auxiliares = filtrosAuxiliaresDaContagem(sp);
  const soNaoLidas = contagemSoNaoLidas(sp);
  // ⚠️ O badge conta o MESMO que a lista mostra, então o marcador é lido com
  // `getAll` e o `modo` viaja junto (#1274). Ler com `get` aqui deixaria o badge
  // de um filtro de duas etiquetas contando uma só — e a aba diria "Fila 3"
  // listando duas: exatamente a divergência que este arquivo existe para
  // impedir, agora pelo caminho do marcador em vez do de canal.
  const marcadores = sp.getAll("tag");
  const modo = modoDeEtiqueta(sp.get("modo")) ?? "e";

  // ⚠️ TODA contagem nasce daqui, e daqui já sai com `organization_id` E com os
  // filtros auxiliares. Herdar tira a opção de esquecer: não existe o caminho
  // "montei uma contagem e não pus o filtro".
  //
  // Pessoal não soma em nenhuma aba (spec 21, etapa 7 — critério 3): ao marcar,
  // a contagem cai exatamente nas não-lidas daquele contato. A MESMA exclusão
  // da lista, pela mesma primitiva — sem ela o badge diria o que a aba esconde.
  const pessoais = await idsDeContatosPessoais(supabase, org);
  // Canal desativado nunca entra na inbox: o mesmo corte da lista, para badge
  // e aba nunca divergirem.
  const idsDesativados = await idsDosCanaisDesativados(supabase, org);
  const consultaCom = (
    /**
     * O que o `select` pede. `{ count: "exact", head: true }` CONTA sem trazer
     * linha; `{}` traz LINHAS (até o `.limit()` de quem chama). É o único
     * argumento que separa os dois caminhos — os filtros são sempre os mesmos.
     */
    selecao: { count?: "exact"; head?: true },
    filtrosDaAba: readonly FiltroDeContagem[] = auxiliares,
    /**
     * #4434 — a aba "Pessoal" INVERTE a exclusão: em vez de subtrair os contatos
     * pessoais, conta só os que ESTE usuário pode ver. Vem como argumento da
     * fábrica, e não como consulta solta, porque montar contagem por fora de
     * `consultaCom()` é a única forma de o badge deixar de herdar organização,
     * auxiliares e não-lidas — e há cerca para isso.
     *
     * `undefined` = régua de sempre (pessoal fora). Conjunto vazio nunca chega
     * aqui: quem chama responde zero sem consultar o banco.
     */
    pessoalVisivel?: readonly string[],
  ) => {
    let q = supabase
      .from("conversations")
      .select("id", selecao)
      .eq("organization_id", org);
    if (idsDesativados.length > 0) q = q.not("channel_session_id", "in", `(${idsDesativados.join(",")})`);
    for (const [coluna, valor] of filtrosDaAba) q = q.eq(coluna, valor);
    // O marcador entra pela régua da LISTA — a mesma função, não uma segunda.
    q = aplicarMarcadores(q, marcadores, modo);
    if (pessoalVisivel) q = q.in("contact_id", [...pessoalVisivel]);
    else if (pessoais.length > 0) q = q.not("contact_id", "in", `(${pessoais.join(",")})`);
    if (soNaoLidas) q = q.gt("unread_count_for_assignee", 0);
    return q;
  };
  /**
   * A contagem EXATA — `count: "exact"` + `head: true`: conta sem trazer linha.
   *
   * É a régua das abas em que alguém AGE, e a única saída da fábrica que TEM
   * `count`. A aba "Pessoal" (#4434) também passa por aqui, com o `pessoalVisivel`
   * — o repasse conferido na revisão continua byte a byte igual.
   */
  const countExact = (
    filtrosDaAba: readonly FiltroDeContagem[] = auxiliares,
    pessoalVisivel?: readonly string[],
  ) => consultaCom({ count: "exact", head: true }, filtrosDaAba, pessoalVisivel);
  /**
   * As LINHAS das pastas de histórico — no máximo `TETO_DAS_PASTAS`, sem `count`.
   *
   * Sem `count` porque contar é justamente o que não se pode pagar aqui: cem
   * linhas de `id` são baratas, um `count` sobre o histórico inteiro não é, e
   * `planned` mentiria "1" numa pasta vazia (#4451). Quem lê o resultado é
   * `placarDasLinhas`.
   */
  const linhasCom = (
    filtrosDaAba: readonly FiltroDeContagem[] = auxiliares,
    pessoalVisivel?: readonly string[],
  ) => consultaCom({}, filtrosDaAba, pessoalVisivel).limit(TETO_DAS_PASTAS);

  // Espelha tabToFilter (InboxLayout): unassigned = fila aberta sem dono;
  // mine = atribuídas a mim e ainda ABERTAS; all = tudo que o usuário VÊ.
  //
  // O `not in (terminais)` do `mine` espelha o `exclude_finished` da aba, e o
  // espelhamento é o ponto: um badge que conta o que a aba não mostra é pior
  // que badge nenhum — manda o atendente procurar um trabalho que não existe.
  // O fato ORG-WIDE resolvido ANTES das contagens, porque ele escolhe QUAL
  // conjunto de comandos a Fila pede. `undefined` (não deu para saber) segue a
  // convenção da regra: assume que há automático.
  const automaticoDaOrg = await orgTemAutomatico(supabase, org);
  // O conjunto de comandos que a aba Fila pede sai daqui UMA vez e serve às duas
  // pontas: o `.in(...)` da contagem e o pré-filtro (#4325), que só vale quando
  // todos os comandos pedidos são `aguardando`/`automatico`.
  const comandosFila = comandosDaFila(automaticoDaOrg);

  // O badge de "Minhas" precisa contar o MESMO que a aba lista (#2848): a aba
  // passou a trazer as conversas em que eu PARTICIPO (convite é da conversa), e
  // um badge que só conta `assigned_to=me` mandaria a convidada procurar
  // trabalho que a tela não mostra. Mesma fábrica da aba.
  // ⚠️ Sem data (mock de teste sem `.is`, banco fora) = sem participações = `.eq`
  // de sempre: o badge nunca muda de regra sozinho, só GANHA conversas quando
  // existe convite de pé.
  let idsParticipadas: string[] = [];
  try {
    const participadasDoUsuario = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("organization_id", org)
      .eq("user_id", user.id)
      .is("left_at", null);
    idsParticipadas = (participadasDoUsuario.data ?? []).map((r) => r.conversation_id);
  } catch {
    idsParticipadas = [];
  }

  // Quem vê qual pessoal (#4434): só o DONO da marca. A MESMA função que a lista
  // usa — duas réguas divergem na primeira condição nova, e aqui a divergência
  // seria um badge contando o pessoal de outra pessoa.
  const pessoaisVisiveis = await idsDeContatosPessoaisVisiveis(supabase, org, user.id);

  const [fila, automatico, mine, all, closed, archived, pessoal] = await Promise.all([
    // A FILA DEIXOU DE SER "sem dono + status de espera".
    //
    // Aquele par contava como trabalho humano pendente tudo que o robô estava
    // atendendo: medido na VPS em 2026-08-30, o badge dizia 83 enquanto 47
    // daquelas conversas tinham o automático no comando. Agora ele conta o mesmo
    // predicado que a aba pede — e o espelhamento entre badge e aba é vigiado
    // por `tests/e2e/inbox-abas-espelham-o-comando.spec.ts`,
    // `tests/unit/fila-tem-uma-definicao-so.test.ts` e
    // `tests/invariants/gov-5b-inbox-scope-counts.test.ts`, porque um badge que conta o
    // que a aba não mostra manda o atendente procurar trabalho que não existe.
    // O pré-filtro (#4325) vem junto: sem dono e fora do histórico fechado é
    // condição NECESSÁRIA do comando, então ele não muda o número — só evita
    // avaliar a função em linha que ela recusaria. Ver
    // `comPreFiltroDoComando`.
    comPreFiltroDoComando(
      countExact().in("comando_da_conversa", comandosFila),
      comandosFila,
    ),
    // A aba "Automático". Antes ela pedia `status='ai_handling'`, escrito por UM
    // caminho só em produção — por isso vivia quase vazia.
    comPreFiltroDoComando(countExact().eq("comando_da_conversa", "automatico"), "automatico"),
    // Minhas IGNORA o atendente escolhido pelo gerente: a lista da aba pede
    // `assigned_to=me`, que vence a escolha. Com o atendente aqui, o badge
    // contava `eu E ele` (zero) enquanto a aba listava as do gerente.
    // Mesma regra da lista (#2848): sem participações, `.eq` de sempre; com
    // convite de pé, `or=` com as conversas em que eu participo — porque um badge
    // que conta o que a aba não mostra manda a convidada procurar trabalho que a
    // tela não exibe.
    (idsParticipadas.length > 0
      ? countExact(auxiliares.filter(([coluna]) => coluna !== "assigned_to_user_id")).or(
          `assigned_to_user_id.eq.${user.id},id.in.(${idsParticipadas.join(",")})`,
        )
      : countExact(auxiliares.filter(([coluna]) => coluna !== "assigned_to_user_id")).eq(
          "assigned_to_user_id",
          user.id,
        ))
      .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`),
    countExact(),
    // A aba "Fechadas" existia SEM número nenhum. Num inbox antigo, é o número
    // que diz o tamanho do arquivo — e a sua ausência fazia a aba parecer um
    // lugar vazio. Mesma fábrica: herda organização e filtros.
    //
    // ⚠️ `eq("closed")`, e NÃO `in(TERMINAIS)` como antes. O par
    // fechada/arquivada agora tem DUAS abas, e cada badge tem de contar
    // exatamente a lista da sua aba: `in(TERMINAIS)` somava arquivadas (e, antes
    // da 0222, resolvidas) no número de "Fechadas", que lista só
    // `status='closed'` — o badge dizia 120 e a lista mostrava 40. Era a mesma
    // classe de defeito que este arquivo já conserta desde a Fila, encontrada
    // aqui no caminho (#923).
    //
    // #4325/#4451: conta ATÉ cem LINHAS, nunca com `count`. É a pasta que cresce
    // sem limite com o histórico (todo atendimento encerrado entra e nenhum sai),
    // e o número só serve para dizer o TAMANHO do arquivo — não é fila de
    // trabalho. `exact` pagaria O(histórico) a cada 30 s; `planned` custava
    // barato, mas mentia "1" na pasta vazia (o planejador nunca estima menos de
    // uma linha). No teto, o badge diz "99+"; ver `placarDasLinhas`.
    linhasCom().eq("status", "closed").then(placarDasLinhas),
    // A aba "Arquivadas" (#923): a pasta do histórico, separada de "Fechadas"
    // para que arquivar seja reversível e auditável sem se confundir com o
    // encerramento do atendimento. Mesmo teto do "Fechadas" (#4451): é a outra
    // pasta que só cresce.
    linhasCom().eq("status", "archived").then(placarDasLinhas),
    // A aba "Pessoal" (#4434): conta o MESMO que ela lista — o pessoal DESTE
    // usuário, em qualquer status, sem os canais desativados. NÃO pode usar a
    // régua de `undefined`, que EXCLUI pessoal: badge que conta o que a aba
    // esconde manda o atendente procurar trabalho que não existe.
    // EXATA, como as demais abas acionáveis: é fila de leitura, não arquivo.
    pessoaisVisiveis.length === 0
      ? Promise.resolve({ count: 0, error: null })
      : countExact(auxiliares, pessoaisVisiveis),
  ]);

  // ─── A CONTAGEM POR FILA (#3876) ──────────────────────────────────────────
  //
  // O seletor do Inbox mostra cada fila com quantas conversas ela ESPERA — o
  // mesmo predicado da aba Fila (quem espera gente), recortado por setor. Uma
  // contagem por fila, e não um `group by`: o PostgREST não agrupa, e contar
  // relendo linhas de uma página truncada daria número errado — o defeito que
  // este arquivo já consertou de outros jeitos. `head: true` é exato e não traz
  // uma linha sequer.
  //
  // Sem fila na organização (módulo desligado, ou ninguém criou nenhuma), o
  // mapa sai vazio e o seletor nem aparece: custo zero para quem não usa setores.
  // Uma contagem por fila, e o número de filas é escolha humana (a instalação de
  // referência tem cinco).
  //
  // ⚠️ O `sector_id` que já veio na URL sai ANTES: ele é o filtro da TELA, e
  // mantê-lo aqui pediria `sector_id = A AND sector_id = B`, devolvendo zero em
  // toda fila menos uma.
  const semOFiltroDaTela = auxiliares.filter(([coluna]) => coluna !== "sector_id");
  const { data: filasDaOrg } = await supabase
    .from("attendant_sectors")
    .select("id")
    .eq("organization_id", org);
  const idsDasFilas = ((filasDaOrg ?? []) as Array<{ id: string }>).map((f) => f.id);
  const contagensPorFila = await Promise.all(
    idsDasFilas.map(async (idDaFila) => {
      const r = await countExact([...semOFiltroDaTela, ["sector_id", idDaFila] as const]).in(
        "comando_da_conversa",
        comandosDaFila(automaticoDaOrg),
      );
      // Falha de UMA fila não derruba a tela: a contagem dela sai zero, que é
      // menos ruim que o inbox inteiro sem número. O erro real já vai ao log da
      // consulta, do lado do supabase-js.
      return [idDaFila, r.count ?? 0] as const;
    }),
  );

  const firstErr =
    fila.error ??
    automatico.error ??
    mine.error ??
    all.error ??
    closed.error ??
    archived.error ??
    pessoal.error;
  if (firstErr) {
    return fail("internal_error", firstErr.message, 500, { requestId });
  }

  return ok(
    {
      fila: fila.count ?? 0,
      automatico: automatico.count ?? 0,
      // `unassigned` continua respondendo, com o MESMO valor de `fila`. É rota
      // `/api/v1/` versionada: campo não some de uma versão para outra, e um
      // cliente com a página aberta desde antes do deploy segue lendo o nome
      // velho até recarregar.
      unassigned: fila.count ?? 0,
      mine: mine.count ?? 0,
      all: all.count ?? 0,
      closed: closed.count,
      archived: archived.count,
      /**
       * As abas cujo número PAROU no teto de cem linhas (#4451).
       *
       * Sai junto com os valores porque a tela precisa poder dizer isso: "99"
       * com "+" é "pelo menos cem", e um número que se apresenta como total é
       * pior que nenhum. Abaixo do teto a lista sai vazia, e o número é EXATO —
       * inclusive o zero da pasta vazia, que o `count: 'planned'` não sabia dar.
       */
      truncadas: [
        ...(closed.truncada ? (["closed"] as const) : []),
        ...(archived.truncada ? (["archived"] as const) : []),
      ],
      /**
       * A aba "Pessoal" (#4434): quantas conversas de contato pessoal ESTE
       * usuário pode ler — as dele, e só as dele. Campo opcional do lado da tela
       * pelo mesmo motivo de `closed`/`archived`: cache gravado antes deste
       * deploy não tem a chave, e um `number` obrigatório imprimiria `NaN` no
       * primeiro segundo.
       */
      pessoal: pessoal.count ?? 0,
      /**
       * Quantas conversas ESPERAM gente em cada fila (#3876), por id de setor.
       * Vem vazio quando a organização não tem fila — e é o que o seletor do
       * Inbox lê para mostrar o número ao lado do nome, com a cor da fila.
       */
      por_fila: Object.fromEntries(contagensPorFila) as Record<string, number>,
    },
    { requestId },
  );
}

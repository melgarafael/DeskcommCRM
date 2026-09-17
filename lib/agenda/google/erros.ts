/**
 * O mapa de desfechos de um erro do Google — a tabela que decide o
 * comportamento do sistema inteiro.
 *
 * ─── Por que uma tabela, e não um `catch` em cada chamada ─────────────────
 *
 * Errar esta classificação é o que produz sync que APAGA dado. Dois exemplos
 * concretos, e nenhum deles é hipotético:
 *
 *  - `410` na exclusão significa "já não existe" — que é exatamente o estado
 *    que queríamos. Tratar como falha trava o cancelamento do CRM para sempre
 *    por causa de um evento que a pessoa já apagou na mão do lado de lá.
 *  - `410` na sincronização incremental significa **outra coisa**: o
 *    `syncToken` morreu e o Google mandou recomeçar do zero. Tratar como
 *    "evento sumiu" faria apagar as linhas de uma agenda inteira.
 *
 * É o mesmo número, com desfechos opostos. Por isso a operação é parâmetro
 * OBRIGATÓRIO: um valor padrão escolheria em silêncio uma das duas leituras, e a
 * escolha errada é justamente a que destrói dado.
 *
 * ─── `invalid_grant` não chega como 401 ───────────────────────────────────
 *
 * A renovação de token falha com **HTTP 400** e `{"error":"invalid_grant"}` no
 * corpo — é assim que o Google diz "o usuário revogou o acesso" ou "este
 * refresh_token passou seis meses sem uso". Quem classifica só por status lê
 * isso como "requisição malformada", tenta de novo para sempre, e a agenda do
 * cliente fica desconectada sem ninguém ser avisado.
 *
 * ─── O que este arquivo NÃO decide ────────────────────────────────────────
 *
 * Ele nomeia o desfecho; não executa nenhum. Quanto esperar depois de `recuar`,
 * quando abrir aviso na Central, quando marcar a conexão como `token_expired` —
 * tudo isso é de quem chama. Aqui não há relógio, nem banco, nem rede.
 */

import type { SituacaoDaConexao } from "@/lib/agenda/tipos";

/** Qual chamada falhou. Muda o significado de `404` e de `410`. */
export type OperacaoNoGoogle =
  | "criar"
  | "atualizar"
  | "apagar"
  | "listar"
  | "sincronizar"
  | "disponibilidade"
  | "token";

export type DesfechoDoGoogle =
  /** O humano precisa reconectar a agenda. Nenhum retry resolve. */
  | "reautenticar"
  /** Cota/limite: esperar e tentar de novo, com folga crescente. */
  | "recuar"
  /** Credencial válida, mas sem direito sobre este calendário. */
  | "sem_permissao"
  /** O evento não está mais lá — nossa referência ficou órfã. */
  | "evento_sumiu"
  /**
   * O CALENDÁRIO não existe ou a conta perdeu acesso a ele.
   *
   * Separado de `evento_sumiu` porque o conserto é outro: aqui não há o que
   * reconciliar, a pessoa precisa reconectar (ou o calendário foi apagado no
   * Google). Enquanto os dois eram o mesmo desfecho, um 404 de criação mandava
   * quem lia procurar um evento que nunca existiu.
   */
  | "calendario_sumiu"
  /** O `syncToken` morreu: limpar e ressincronizar a agenda inteira. */
  | "ressincronizar"
  /** O estado desejado já vale. Não é falha. */
  | "ja_esta_feito"
  /** Passageiro (5xx, rede). Tentar de novo mais tarde. */
  | "transitorio"
  /** Repetir não muda nada. Precisa de conserto humano ou de código. */
  | "permanente";

export interface ClassificacaoDoErro {
  desfecho: DesfechoDoGoogle;
  /** HTTP, quando havia. `null` em falha de rede. */
  status: number | null;
  /** O `reason` do Google (`rateLimitExceeded`, `notFound`, `invalid_grant`…). */
  motivo: string | null;
  /** Só quando o Google mandou `Retry-After` em segundos. */
  esperarSegundos: number | null;
  /** Frase curta para gravar em `google_sync_error` e mostrar a quem opera. */
  mensagem: string;
}

/** Cota estourada — o Google usa 403 para isto, não só 429. */
const MOTIVOS_DE_COTA = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
  "quotaexceeded",
  "dailylimitexceeded",
]);

/** O app OAuth da instalação está errado — reconectar não conserta. */
const MOTIVOS_DE_APP_ERRADO = new Set(["invalid_client", "unauthorized_client", "redirect_uri_mismatch"]);

function ehNumero(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * O status HTTP, de onde quer que ele esteja.
 *
 * As bibliotecas discordam: `googleapis` põe em `code`, os embrulhos de `fetch`
 * em `response.status` ou `statusCode`, e o corpo de erro do Google repete em
 * `error.code`. E `code` também carrega string de rede (`ECONNRESET`), que não
 * é status — por isso a checagem de número.
 *
 * ⚠️ **`error.code` NO TOPO é o caso que mais importa, e era o que faltava.**
 * Este repo não tem `googleapis` nas dependências, então quem escrever o
 * cliente vai de `fetch` — e o objeto natural de um `await res.json()` é o
 * corpo CRU, `{ error: { code, message, errors[], status } }`. Sem lê-lo, um
 * erro perfeitamente bem-formado do Google chegava aqui sem status e sem
 * motivo, caía no desfecho conservador `transitorio`, e virava repetição
 * infinita. O pior caso medido: um `410 fullSyncRequired` nessa forma vira
 * "tentar de novo", o worker repete a MESMA requisição com o MESMO `syncToken`
 * morto, e a sincronização daquela agenda congela para sempre — em silêncio,
 * porque cada tentativa parece uma falha passageira. Achado pelo QA na revisão
 * fria, e o comentário anterior deste bloco JÁ prometia ler `error.code`: a
 * promessa estava aqui e a implementação não.
 */
function extrairStatus(erro: unknown): number | null {
  const e = comoObjeto(erro);
  if (!e) return null;
  if (ehNumero(e.code)) return e.code;
  if (ehNumero(e.status)) return e.status;
  if (ehNumero(e.statusCode)) return e.statusCode;

  // O corpo CRU do Google, entregue direto por `await res.json()`.
  const erroNoTopo = comoObjeto(e.error);
  if (erroNoTopo && ehNumero(erroNoTopo.code)) return erroNoTopo.code;

  const resposta = comoObjeto(e.response);
  if (resposta && ehNumero(resposta.status)) return resposta.status;

  const dados = resposta ? comoObjeto(resposta.data) : null;
  const erroDoCorpo = dados ? comoObjeto(dados.error) : null;
  if (erroDoCorpo && ehNumero(erroDoCorpo.code)) return erroDoCorpo.code;

  return null;
}

/** Todos os `reason` que o erro carrega, em minúsculas, sem repetir. */
function extrairMotivos(erro: unknown): string[] {
  const achados: string[] = [];
  const e = comoObjeto(erro);
  if (!e) return achados;

  const empilhar = (v: unknown) => {
    if (typeof v === "string" && v.trim()) achados.push(v.trim().toLowerCase());
  };

  const listaDeReasons = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const item of v) {
      const i = comoObjeto(item);
      if (i) empilhar(i.reason);
    }
  };

  // `{ error: "invalid_grant" }` — o formato do endpoint de token, em que
  // `error` é STRING.
  empilhar(e.error);
  // …e `{ error: { code, errors[], status } }` — o corpo cru da API, em que
  // `error` é OBJETO. Só aceitar a string descartava este em silêncio, e era
  // metade da causa do defeito descrito em `extrairStatus`.
  const erroNoTopo = comoObjeto(e.error);
  if (erroNoTopo) {
    empilhar(erroNoTopo.status);
    listaDeReasons(erroNoTopo.errors);
  }
  // `code` só entra como motivo quando NÃO é status (ECONNRESET, ETIMEDOUT…).
  if (typeof e.code === "string") empilhar(e.code);
  listaDeReasons(e.errors);

  const resposta = comoObjeto(e.response);
  const dados = resposta ? comoObjeto(resposta.data) : null;
  if (dados) {
    empilhar(dados.error);
    const erroDoCorpo = comoObjeto(dados.error);
    if (erroDoCorpo) {
      empilhar(erroDoCorpo.status);
      listaDeReasons(erroDoCorpo.errors);
    }
  }

  // O corpo CRU da recusa quando quem lançou foi o TRANSPORTE da agenda: o
  // `GoogleHttpError` guarda o corpo do Google ao lado do status, em `corpo`, e
  // ele não tem `response` — sem este unwrap a recusa de uma ESCRITA chegava
  // aqui com status e sem motivo nenhum, e a frase persistida ficava só
  // "Google HTTP 400" para um erro que o Google tinha explicado.
  //
  // Os `reason` entram ANTES do `status` simbólico de propósito: é o primeiro
  // motivo que vira a frase persistida, e `invalid` diz o que consertar
  // enquanto `INVALID_ARGUMENT` só repete a categoria. (O bloco do corpo cru
  // logo acima mantém a ordem antiga — trocá-la não é o escopo da #950.)
  //
  // Daqui só sai o que tem FORMATO de identificador (`invalid`,
  // `INVALID_ARGUMENT`). O corpo é de quem respondeu, e nem sempre é o Google:
  // um proxy que devolva `{"error":"<texto livre>"}` levaria nome e e-mail para
  // a frase gravada no compromisso.
  const corpoDaRecusa = comoObjeto(e.corpo);
  if (corpoDaRecusa) {
    const antes = achados.length;
    empilhar(corpoDaRecusa.error);
    const erroDaRecusa = comoObjeto(corpoDaRecusa.error);
    if (erroDaRecusa) listaDeReasons(erroDaRecusa.errors);
    listaDeReasons(corpoDaRecusa.errors);
    if (erroDaRecusa) empilhar(erroDaRecusa.status);
    const doCorpo = achados.splice(antes).filter((m) => /^[a-z_]{1,64}$/.test(m));
    achados.push(...doCorpo);
  }

  // A mensagem entra por último e só serve para os motivos que o Google manda
  // em texto puro na renovação de token — `googleapis` copia `invalid_grant`
  // para `message` e não preenche `errors[]`.
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    for (const conhecido of ["invalid_grant", ...MOTIVOS_DE_APP_ERRADO]) {
      if (m.includes(conhecido)) achados.push(conhecido);
    }
  }

  return [...new Set(achados)];
}

/**
 * `Retry-After`, quando veio em segundos.
 *
 * A forma em data HTTP é ignorada de propósito: convertê-la exigiria um relógio
 * aqui dentro, e esta camada não tem nenhum. Sem o número, quem chama aplica a
 * própria folga — nunca fica sem resposta.
 */
function extrairRetryAfter(erro: unknown): number | null {
  const e = comoObjeto(erro);
  const resposta = e ? comoObjeto(e.response) : null;
  const cabecalhos: unknown = resposta?.headers;
  if (!cabecalhos) return null;

  let bruto: unknown = null;
  if (typeof (cabecalhos as Headers).get === "function") {
    bruto = (cabecalhos as Headers).get("retry-after");
  } else {
    const obj = comoObjeto(cabecalhos);
    if (obj) {
      const chave = Object.keys(obj).find((k) => k.toLowerCase() === "retry-after");
      bruto = chave ? obj[chave] : null;
    }
  }

  if (bruto === null || bruto === undefined) return null;
  const segundos = Number(bruto);
  return Number.isFinite(segundos) && segundos >= 0 ? Math.ceil(segundos) : null;
}

const FRASE: Record<DesfechoDoGoogle, string> = {
  reautenticar: "a agenda do Google perdeu a autorização — é preciso reconectar",
  recuar: "o Google pediu para desacelerar (limite de uso)",
  sem_permissao: "sem permissão de escrita neste calendário",
  evento_sumiu: "o evento não existe mais no Google",
  calendario_sumiu: "o calendário do Google não existe mais, ou a conta perdeu acesso a ele",
  ressincronizar: "a sincronização incremental expirou — recomeçar do zero",
  ja_esta_feito: "o Google já estava no estado desejado",
  transitorio: "falha passageira do Google — tentar de novo",
  permanente: "o Google recusou e repetir não muda o resultado",
};

export function classificarErroDoGoogle(erro: unknown, operacao: OperacaoNoGoogle): ClassificacaoDoErro {
  const status = extrairStatus(erro);
  const motivos = extrairMotivos(erro);
  const esperarSegundos = extrairRetryAfter(erro);
  const primeiroMotivo = motivos[0] ?? null;

  const tem = (nome: string) => motivos.includes(nome);
  const temCota = motivos.some((m) => MOTIVOS_DE_COTA.has(m));
  const temAppErrado = motivos.some((m) => MOTIVOS_DE_APP_ERRADO.has(m));

  const desfecho: DesfechoDoGoogle = (() => {
    // O app OAuth da instalação está mal configurado. Vem antes de tudo porque
    // o status é 400/401 e mandaria o dono para uma tela de reconexão que não
    // resolve — ele reconectaria para sempre.
    if (temAppErrado) return "permanente";
    if (tem("invalid_grant")) return "reautenticar";
    // O Google nomeia este caso: o `syncToken` morreu. Vale mais que o status,
    // porque é a única leitura possível dele.
    if (tem("fullsyncrequired")) return "ressincronizar";

    if (status === 401) return "reautenticar";
    if (status === 429) return "recuar";
    if (status === 403) return temCota ? "recuar" : "sem_permissao";

    // ⚠️ O 404 TEM TRÊS LEITURAS, e tratá-lo como uma só foi o que fez a VPS do
    // dono registrar `evento_sumiu` três vezes para eventos que NUNCA existiram.
    //
    //   apagar  → o evento já não está lá: é o estado desejado, não falha.
    //   criar   → a URL do POST é a COLEÇÃO e não leva id de evento nenhum, então
    //             404 aqui só pode ser o CALENDÁRIO que não existe (ou ao qual a
    //             conta perdeu acesso). Dizer "o evento sumiu" manda quem lê
    //             procurar um evento — e o que falta é o calendário.
    //   demais  → tínhamos o id guardado e ele não está mais lá: órfão de verdade.
    //
    // A distinção não é cosmética: `evento_sumiu` pede reconciliar (recriar),
    // `calendario_sumiu` pede reconectar. Consertos opostos.
    // A recusa veio da consulta ao CALENDÁRIO (o transporte marca `alvo`): o
    // evento nem chegou a ser a pergunta, e nenhuma das leituras acima vale.
    if ((status === 404 || status === 410) && comoObjeto(erro)?.alvo === "calendario")
      return "calendario_sumiu";
    if (status === 404) {
      if (operacao === "apagar") return "ja_esta_feito";
      if (operacao === "criar") return "calendario_sumiu";
      return "evento_sumiu";
    }
    if (status === 410) {
      if (operacao === "apagar") return "ja_esta_feito";
      if (operacao === "listar" || operacao === "sincronizar") return "ressincronizar";
      return "evento_sumiu";
    }

    if (status !== null && status >= 500) return "transitorio";
    // Sem status é falha de rede (DNS, conexão cortada, timeout): o Google
    // nunca respondeu, então nada foi decidido do lado de lá.
    if (status === null) return "transitorio";
    return "permanente";
  })();

  const detalhe = primeiroMotivo ? ` (${primeiroMotivo})` : "";
  const numero = status !== null ? `HTTP ${status}` : "sem resposta";
  return {
    desfecho,
    status,
    motivo: primeiroMotivo,
    esperarSegundos,
    mensagem: `${FRASE[desfecho]} — ${numero}${detalhe}`,
  };
}

/**
 * O estado da conexão é o vocabulário da entrega — **não uma lista minha**.
 *
 * `SITUACOES_DA_CONEXAO` (`lib/agenda/tipos.ts`) já declara os sete valores do
 * `calendar_connections_status_check` da 0177, com os rótulos em português ao
 * lado. Este arquivo teve por um tempo um `StatusDaConexao` próprio, e ele era a
 * TERCEIRA lista do mesmo vocabulário — que é literalmente o que o invariante
 * `vocabulario-banco-x-typescript` existe para proibir; o cabeçalho de lá diz
 * isso com todas as letras.
 *
 * Nasceu porque a camada pura veio antes do schema e antes de `tipos.ts`. O
 * remédio é o mesmo da conversão de fuso: quando o dono do vocabulário aparece,
 * a lista adiantada não é corrigida — é APAGADA, e quem precisava dela importa.
 */
export type { SituacaoDaConexao } from "@/lib/agenda/tipos";

/**
 * Em que estado este desfecho deixa a agenda conectada — e, com isso, se ela
 * continua contando como fonte de conflito.
 *
 * É a metade que faltava para a DECISÃO 3.2 fechar: nenhum dos oito desfechos
 * dizia "pare de contar este calendário", que é a ação que ela exige. Contar
 * uma fonte que não responde é pior que não ter fonte — marcaria compromisso
 * em cima de compromisso real, porque a agenda que não responde parece vazia.
 *
 * `null` significa **não mexa no estado**: o desfecho é sobre um evento, não
 * sobre a conexão, e rebaixar a conexão por causa de um evento que sumiu
 * desligaria a agenda inteira por um caso isolado.
 */
export function estadoDaConexaoApos(desfecho: DesfechoDoGoogle): SituacaoDaConexao | null {
  switch (desfecho) {
    case "reautenticar":
      return "token_expired";
    case "sem_permissao":
      return "scope_missing";
    case "permanente":
      return "error";
    case "ja_esta_feito":
      return "healthy";
    // O Google mandou desacelerar. O estado existe no banco e é diferente de
    // "quebrada": a conexão está boa, só não pode ser consultada agora.
    case "recuar":
      return "rate_limited";
    // O CALENDÁRIO sumiu, e isso É sobre a conexão — ao contrário de um evento
    // órfão, que é caso isolado. Sem calendário alcançável não há sincronização
    // nenhuma, e deixar a conexão `healthy` faria a tela dizer que está tudo bem
    // enquanto nada sai nem entra.
    case "calendario_sumiu":
      return "error";
    case "transitorio":
    case "ressincronizar":
    case "evento_sumiu":
      return null;
  }
}

/**
 * ⚠️ AQUI MORAVA `contaComoConflito`, E ELA FOI APAGADA — DECISÃO 23.
 *
 * Ela devolvia `true` só para `healthy`, e a docstring argumentava que "não sei"
 * nunca pode ser lido como "está livre". O argumento é bom, era meu, e está
 * INVERTIDO — o maestro corrigiu a DECISÃO 3.2 e a versão em vigor
 * (`lib/agenda/ocupados.ts`) faz o oposto: **conexão caída CONTINUA ocupando**.
 * O compromisso não deixou de existir na agenda do Google da pessoa; o que
 * parou foi a atualização dele. Parar de contar é que oferece o horário tomado.
 *
 * O perigo não era a duplicação — era a QUALIDADE DO TEXTO. A função tinha nome
 * certo, argumento convincente, antecipava a objeção do `rate_limited` e teste
 * verde. Quem chegasse para ligar o motor de horários encontraria tudo isso e
 * ligaria, e o Google desconectado passaria a parecer VAZIO — oferecendo as 14h
 * que já têm consulta.
 *
 * Não foi renomeada de propósito: nome novo para semântica invertida é a mesma
 * armadilha com disfarce melhor. Quem precisa saber se uma fonte defasada entra
 * no cálculo pergunta a `lib/agenda/ocupados.ts`, que é quem decide.
 */

/**
 * Vale tentar de novo sozinho?
 *
 * `reautenticar`, `sem_permissao` e `permanente` ficam de fora porque nenhum
 * deles muda com o tempo: repetir só gasta cota e enche o log, escondendo o
 * pedido de socorro que deveria chegar a quem opera.
 */
export function deveTentarDeNovo(desfecho: DesfechoDoGoogle): boolean {
  return desfecho === "recuar" || desfecho === "transitorio" || desfecho === "ressincronizar";
}

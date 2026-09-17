/**
 * O consentimento e o token do Google — a parte pura.
 *
 * Sem rede, sem `process.env` e sem relógio próprio: quem chama injeta a
 * configuração do app e o instante. É o que permite provar, em teste de
 * unidade, as três primeiras armadilhas desta integração em produção — e a
 * GUARDA contra a quarta. São quatro, e elas não se dividem só pelo estrago
 * (três matam a conexão em silêncio, a quarta tranca quem tem a agenda num
 * e-mail diferente do login do CRM): dividem-se também pelo que um teste de
 * unidade alcança. Nas três primeiras o mecanismo É o que enviamos, então
 * medir o que sai mede a armadilha inteira. Na quarta o mecanismo é a tela do
 * Google pular o seletor — daqui só se prova que `select_account` SAI, nunca
 * que o seletor aparece. O teste irmão já faz essa distinção, e o cabeçalho
 * não pode desfazê-la: `tests/unit/agenda-google-oauth.test.ts` abre com
 * "três armadilhas medidas" e só depois com "e uma quarta".
 *
 * ─── Armadilha 1: sem `prompt=consent` não vem `refresh_token` ────────────
 *
 * O Google devolve `refresh_token` apenas no PRIMEIRO consentimento de cada
 * usuário. Numa reconexão — que é o caminho normal depois de trocar de senha ou
 * revogar acesso — a resposta vem sem ele. A conexão então funciona por uma
 * hora e morre calada, e o sintoma chega como "minha agenda parou de
 * sincronizar" no dia seguinte. `access_type=offline` + `prompt=consent`
 * forçam o refresh_token em toda reconexão.
 *
 * ─── Armadilha 2: a resposta da RENOVAÇÃO não repete o `refresh_token` ────
 *
 * Quem faz `token = novaResposta` apaga o refresh_token e mata a conexão que
 * acabou de renovar. É a armadilha nº 1 de quem implementa isto do zero. Por
 * isso `fundirTokens` existe e é a única forma de escrever token novo por cima
 * de token velho.
 *
 * ─── Armadilha 3: `expires_in` é RELATIVO ─────────────────────────────────
 *
 * O Google manda "faltam 3599 segundos", não "expira às 14h". Persistir o
 * número relativo dá um token eternamente novo — a validade nunca chega. Aqui
 * ele vira instante absoluto na leitura, usando o `agora` injetado, e o valor
 * relativo não sobrevive à fronteira desta função.
 *
 * ─── Armadilha 4: sem `select_account` o `login_hint` vira imposição ───────
 *
 * `login_hint` SUGERE a conta, não obriga. Com uma sessão do Google já aberta
 * no navegador e `prompt=consent` sozinho, o Google autoriza aquela conta e
 * pula o seletor: quem tem a agenda de trabalho num e-mail diferente do login
 * do CRM chega na tela, autoriza, e a agenda que volta para o CRM é a do login
 * — sem caminho nenhum para trocar. `select_account` PEDE o seletor de volta, e
 * o `login_hint` continua junto como sugestão. O que a tela do Google faz com
 * essa sugestão — destacar a conta, pré-selecionar, ignorar — é decisão dele, e
 * ninguém deste lado observou: daqui só se prova o que SAI (ver o topo).
 */

/**
 * Os dois escopos, e por que não são três.
 *
 * `calendar.events` cobre criar, alterar, apagar e observar eventos.
 * `calendar.readonly` cobre `calendarList.list`, `calendars.get` e
 * `freebusy.query` — inclusive o e-mail da conta, que sai do id do calendário
 * primário. É por isso que NÃO pedimos `userinfo.email` nem `userinfo.profile`:
 * cada linha a mais na tela de consentimento é uma chance a mais de a pessoa
 * desmarcar algo e a conexão nascer quebrada.
 */
export const ESCOPOS_OBRIGATORIOS: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export const ENDERECO_DE_CONSENTIMENTO = "https://accounts.google.com/o/oauth2/v2/auth";
export const ENDERECO_DE_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Renovar com folga, não no vencimento.
 *
 * O `access_token` dura cerca de uma hora. Renovar só quando ele já expirou
 * transforma toda requisição de borda num 401 e num retry; um minuto de folga
 * cobre a latência da própria chamada e o desencontro de relógio entre a nossa
 * máquina e a do Google.
 */
export const FOLGA_DE_RENOVACAO_MS = 60_000;

/** O app OAuth da INSTALAÇÃO (não da pessoa) — `03-DECISOES.md` §3.1. */
export interface AppDoGoogle {
  clientId: string;
  /** Tem de ser byte a byte igual ao registrado no console do Google. */
  redirectUri: string;
}

/**
 * A URL para onde mandamos a pessoa autorizar a agenda dela.
 *
 * Lança quando o app não está configurado: sem `client_id` o Google devolve uma
 * página de erro em inglês que não explica nada, e quem instalou fica sem saber
 * que faltou uma variável. Quem chama transforma isto no cartão "conectar o
 * Google ainda não está configurado", com o nome exato do que falta.
 */
export function montarUrlDeConsentimento(
  app: AppDoGoogle,
  opcoes: { state: string; contaSugerida?: string | null },
): string {
  const clientId = app.clientId?.trim();
  const redirectUri = app.redirectUri?.trim();
  if (!clientId) throw new Error("GOOGLE_CALENDAR_CLIENT_ID ausente: não há app OAuth para pedir consentimento");
  if (!redirectUri) throw new Error("redirect_uri ausente: o Google exige o endereço de retorno registrado");
  if (!opcoes.state?.trim()) throw new Error("state ausente: sem ele o retorno do Google não é verificável");

  const parametros = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ESCOPOS_OBRIGATORIOS.join(" "),
    // Sem `offline` não vem refresh_token nenhum; sem `consent` ele some na
    // segunda vez; sem `select_account` o Google pula o seletor de contas e
    // autoriza direto a conta do `login_hint`. Os três juntos, sempre — ver o
    // cabeçalho.
    access_type: "offline",
    prompt: "consent select_account",
    state: opcoes.state,
  });

  // Cada atendente conecta a agenda DELE. Sugerir a conta evita o erro mais
  // comum do fluxo: autorizar com a conta pessoal que já estava logada no
  // navegador e ver a agenda errada aparecer no CRM.
  //
  // Sugerir NÃO é decidir: quem tem a agenda de trabalho num e-mail diferente do
  // login do CRM precisa conseguir escolher o dele na tela do Google — é o
  // `select_account` acima que mantém o seletor de pé. Como o Google desenha a
  // sugestão DENTRO do seletor é com ele; o que garantimos é que o seletor é
  // pedido.
  const conta = opcoes.contaSugerida?.trim();
  if (conta) parametros.set("login_hint", conta);

  return `${ENDERECO_DE_CONSENTIMENTO}?${parametros.toString()}`;
}

export interface TokenDoGoogle {
  access_token: string;
  /** `null` quando a resposta não trouxe — ver `fundirTokens`. */
  refresh_token: string | null;
  scope: string[];
  token_type: string;
  /** Instante absoluto, ISO-8601. Nunca o `expires_in` relativo. */
  expira_em: string;
}

export type MotivoDeTokenIlegivel = "resposta_invalida" | "erro_do_google" | "sem_access_token";

export type LeituraDeToken =
  | { ok: true; token: TokenDoGoogle }
  | { ok: false; motivo: MotivoDeTokenIlegivel; detalhe: string };

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Lê a resposta do endpoint de token (troca do `code` ou renovação).
 *
 * Não lança: a resposta vem da rede, e um `throw` aqui viraria 500 numa rota que
 * precisa redirecionar o navegador com um motivo legível.
 */
export function lerRespostaDeToken(bruto: unknown, opcoes: { agora: Date }): LeituraDeToken {
  if (typeof bruto !== "object" || bruto === null) {
    return { ok: false, motivo: "resposta_invalida", detalhe: `resposta não é objeto: ${typeof bruto}` };
  }
  const r = bruto as Record<string, unknown>;

  const erro = texto(r.error);
  if (erro) {
    const descricao = texto(r.error_description);
    return { ok: false, motivo: "erro_do_google", detalhe: descricao ? `${erro}: ${descricao}` : erro };
  }

  const accessToken = texto(r.access_token);
  if (!accessToken) {
    return { ok: false, motivo: "sem_access_token", detalhe: "resposta sem `access_token`" };
  }

  // Sem validade declarada, tratamos como JÁ vencido. É o desfecho conservador:
  // no pior caso gastamos uma renovação a mais; o contrário — supor uma hora que
  // ninguém prometeu — dá 401 no meio de um agendamento.
  // `expires_in` também chega como STRING em alguns fluxos do Google e em
  // proxies que serializam o corpo. Recusar a string mandaria o token nascer
  // "já vencido" e a renovação passaria a rodar em TODA chamada — caro, e
  // invisível, porque cada renovação isolada parece legítima.
  const expiresInBruto = typeof r.expires_in === "string" ? Number(r.expires_in.trim()) : r.expires_in;
  const expiresIn =
    typeof expiresInBruto === "number" && Number.isFinite(expiresInBruto) ? expiresInBruto : null;
  const expiraEm =
    expiresIn === null
      ? new Date(opcoes.agora.getTime())
      : new Date(opcoes.agora.getTime() + expiresIn * 1000);

  const escopoBruto = texto(r.scope);
  return {
    ok: true,
    token: {
      access_token: accessToken,
      refresh_token: texto(r.refresh_token),
      scope: escopoBruto ? escopoBruto.split(/\s+/).filter(Boolean) : [],
      token_type: texto(r.token_type) ?? "Bearer",
      expira_em: expiraEm.toISOString(),
    },
  };
}

/**
 * Escreve o token novo por cima do velho SEM perder o `refresh_token`.
 *
 * A resposta da renovação não repete o refresh_token — e não repete o `scope`
 * em algumas respostas. Substituir o objeto inteiro apaga os dois: o primeiro
 * mata a conexão na hora seguinte, o segundo faz a verificação de escopo acusar
 * falta do que está concedido.
 */
export function fundirTokens(atual: TokenDoGoogle | null | undefined, novo: TokenDoGoogle): TokenDoGoogle {
  return {
    access_token: novo.access_token,
    refresh_token: novo.refresh_token ?? atual?.refresh_token ?? null,
    scope: novo.scope.length > 0 ? novo.scope : (atual?.scope ?? []),
    token_type: novo.token_type || atual?.token_type || "Bearer",
    expira_em: novo.expira_em,
  };
}

/**
 * Quais escopos obrigatórios a pessoa NÃO concedeu.
 *
 * A tela de consentimento do Google permite desmarcar escopo por escopo. Sem
 * esta conferência, a conexão é gravada como saudável e falha só no primeiro
 * agendamento — longe da tela que causou o problema, com uma mensagem que
 * culpa o calendário.
 *
 * ⚠️ **ORDEM OBRIGATÓRIA: confira DEPOIS de `fundirTokens`, nunca antes.** A
 * resposta de uma RENOVAÇÃO costuma vir sem `scope`; perguntar a ela
 * diretamente acusa os dois escopos como faltando numa conexão perfeitamente
 * boa, e o desfecho seria marcar `scope_missing` e mandar o dono reconectar
 * uma agenda que nunca teve problema. Quem preserva o escopo é a fusão. Há
 * teste pinando as duas ordens.
 */
export function escoposFaltando(concedidos: string[] | string | null | undefined): string[] {
  const lista =
    typeof concedidos === "string"
      ? concedidos.split(/\s+/).filter(Boolean)
      : Array.isArray(concedidos)
        ? concedidos.filter((s): s is string => typeof s === "string")
        : [];
  const tem = new Set(lista.map((s) => s.trim()));
  return ESCOPOS_OBRIGATORIOS.filter((necessario) => !tem.has(necessario));
}

/**
 * Está na hora de renovar?
 *
 * `agora` é parâmetro, nunca `new Date()` aqui dentro: uma função de tempo que
 * lê o próprio relógio não tem como ser testada nas bordas, e a borda é o único
 * lugar onde esta decisão erra.
 *
 * Validade ausente ou ilegível responde `true`. Não saber quando vence é o
 * mesmo risco de estar vencido, e renovar à toa custa uma requisição.
 */
export function precisaRenovar(
  expiraEm: string | Date | null | undefined,
  agora: Date,
  folgaMs: number = FOLGA_DE_RENOVACAO_MS,
): boolean {
  if (expiraEm === null || expiraEm === undefined || expiraEm === "") return true;
  const vencimento = expiraEm instanceof Date ? expiraEm : new Date(expiraEm);
  const t = vencimento.getTime();
  if (Number.isNaN(t)) return true;
  return t - agora.getTime() <= folgaMs;
}

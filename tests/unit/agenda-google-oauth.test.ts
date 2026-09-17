/**
 * O consentimento e o token do Google.
 *
 * Três armadilhas medidas, e as três matam a conexão em silêncio — a agenda
 * simplesmente para de sincronizar no dia seguinte, sem erro na tela:
 *
 *  1. sem `prompt=consent`, a RECONEXÃO volta sem `refresh_token`;
 *  2. a resposta da RENOVAÇÃO não repete o `refresh_token` — quem substitui o
 *     objeto inteiro apaga o que acabou de renovar;
 *  3. `expires_in` é relativo; persistido cru, dá um token que nunca vence.
 *
 * E uma quarta, que não mata conexão nenhuma: tranca quem tem a agenda num
 * e-mail diferente do login do CRM. Sem `select_account`, o `login_hint` deixa
 * de sugerir e passa a impor — o Google autoriza a conta que já estava logada
 * no navegador, sem mostrar o seletor (issue #929).
 */
import { describe, expect, it } from "vitest";

import {
  ESCOPOS_OBRIGATORIOS,
  FOLGA_DE_RENOVACAO_MS,
  type TokenDoGoogle,
  escoposFaltando,
  fundirTokens,
  lerRespostaDeToken,
  montarUrlDeConsentimento,
  precisaRenovar,
} from "@/lib/agenda/google/oauth";

const APP = { clientId: "123.apps.googleusercontent.com", redirectUri: "https://crm.exemplo/api/v1/agenda/google/callback" };
const AGORA = new Date("2026-08-26T12:00:00.000Z");

function token(sobrescreve: Partial<TokenDoGoogle> = {}): TokenDoGoogle {
  return {
    access_token: "ya29.velho",
    refresh_token: "1//refresh-original",
    scope: [...ESCOPOS_OBRIGATORIOS],
    token_type: "Bearer",
    expira_em: "2026-08-26T13:00:00.000Z",
    ...sobrescreve,
  };
}

describe("montarUrlDeConsentimento", () => {
  it("pede acesso offline COM consentimento forçado — é o que garante refresh_token", () => {
    // Sem `offline` não vem refresh_token nenhum; sem `consent` ele some na
    // segunda conexão, e a integração morre uma hora depois.
    const bruto = montarUrlDeConsentimento(APP, { state: "abc" });
    const url = new URL(bruto);
    expect(url.searchParams.get("access_type")).toBe("offline");
    // `prompt` é um CONJUNTO para o Google, não um valor: pinar a lista inteira
    // impede que tirar um dos dois passe despercebido (ver o cabeçalho).
    expect(url.searchParams.get("prompt")?.split(" ").sort()).toEqual(["consent", "select_account"]);
    // Os asserts acima leem por `searchParams.get()`, que DECODIFICA antes de
    // comparar — um espaço mal codificado no fio chegaria aqui já consertado, e
    // nenhum gate veria. Este prende a forma que SAI: `URLSearchParams` serializa
    // o espaço como `+`, e o endpoint de autorização do Google lê a query como
    // form-urlencoded, onde `+` é espaço.
    expect(bruto).toMatch(/[?&]prompt=consent(\+|%20)select_account(&|$)/);
  });

  it("deixa escolher OUTRA conta — a agenda pode estar num e-mail diferente do login do CRM", () => {
    // Issue #929: quem entra no CRM com um e-mail e tem a agenda em outro chega
    // na tela do Google e autoriza, sem seletor, a conta que já estava logada no
    // navegador — e a agenda errada volta para o CRM.
    const url = new URL(montarUrlDeConsentimento(APP, { state: "abc", contaSugerida: "ana@clinica.com.br" }));
    const pedidos = url.searchParams.get("prompt")?.split(" ") ?? [];

    expect(pedidos).toContain("select_account");
    // E a sugestão continua de pé — o que provamos é que ela SAI no pedido; como o
    // Google a desenha dentro do seletor é dele, e ninguém daqui observou.
    expect(url.searchParams.get("login_hint")).toBe("ana@clinica.com.br");
  });

  it("pede exatamente os dois escopos, e nenhum de perfil", () => {
    // Cada linha a mais na tela de consentimento é uma chance a mais de a
    // pessoa desmarcar algo e a conexão nascer quebrada.
    const url = new URL(montarUrlDeConsentimento(APP, { state: "abc" }));
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(url.searchParams.get("scope")).not.toContain("userinfo");
  });

  it("leva o state e o retorno registrado", () => {
    const url = new URL(montarUrlDeConsentimento(APP, { state: "o-state-assinado" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("o-state-assinado");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(APP.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(APP.redirectUri);
  });

  it("sugere a conta quando sabemos qual é — cada atendente conecta a dele", () => {
    const url = new URL(montarUrlDeConsentimento(APP, { state: "abc", contaSugerida: "ana@clinica.com.br" }));
    expect(url.searchParams.get("login_hint")).toBe("ana@clinica.com.br");
    const sem = new URL(montarUrlDeConsentimento(APP, { state: "abc", contaSugerida: null }));
    expect(sem.searchParams.has("login_hint")).toBe(false);
  });

  it("recusa montar URL quebrada: o erro do Google não explicaria nada a quem instalou", () => {
    expect(() => montarUrlDeConsentimento({ ...APP, clientId: "" }, { state: "abc" })).toThrow(
      /GOOGLE_CALENDAR_CLIENT_ID/,
    );
    expect(() => montarUrlDeConsentimento({ ...APP, redirectUri: "" }, { state: "abc" })).toThrow(/redirect_uri/);
    expect(() => montarUrlDeConsentimento(APP, { state: "  " })).toThrow(/state/);
  });
});

describe("lerRespostaDeToken", () => {
  it("transforma o `expires_in` relativo em instante absoluto", () => {
    const r = lerRespostaDeToken(
      { access_token: "ya29.novo", expires_in: 3599, refresh_token: "1//r", scope: ESCOPOS_OBRIGATORIOS.join(" "), token_type: "Bearer" },
      { agora: AGORA },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.expira_em).toBe("2026-08-26T12:59:59.000Z");
    expect(r.token.scope).toEqual([...ESCOPOS_OBRIGATORIOS]);
    expect(r.token.refresh_token).toBe("1//r");
  });

  it("resposta sem validade declarada conta como JÁ vencida", () => {
    // O desfecho conservador: no pior caso gastamos uma renovação a mais. O
    // contrário — supor uma hora que ninguém prometeu — dá 401 no meio de um
    // agendamento.
    const r = lerRespostaDeToken({ access_token: "ya29.novo" }, { agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.expira_em).toBe(AGORA.toISOString());
    expect(precisaRenovar(r.token.expira_em, AGORA)).toBe(true);
  });

  it("a renovação vem sem refresh_token, e isso não é erro", () => {
    const r = lerRespostaDeToken({ access_token: "ya29.novo", expires_in: 3600 }, { agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.refresh_token).toBeNull();
  });

  it("recusa com motivo em vez de lançar", () => {
    const erro = lerRespostaDeToken({ error: "invalid_grant", error_description: "Token expired" }, { agora: AGORA });
    expect(erro).toMatchObject({ ok: false, motivo: "erro_do_google" });
    if (!erro.ok) expect(erro.detalhe).toContain("Token expired");

    expect(lerRespostaDeToken({ token_type: "Bearer" }, { agora: AGORA })).toMatchObject({
      ok: false,
      motivo: "sem_access_token",
    });
    expect(lerRespostaDeToken("não é json", { agora: AGORA })).toMatchObject({
      ok: false,
      motivo: "resposta_invalida",
    });
    expect(lerRespostaDeToken(null, { agora: AGORA })).toMatchObject({ ok: false, motivo: "resposta_invalida" });
  });
});

describe("lerRespostaDeToken — expires_in que chega como texto", () => {
  it("aceita o número em string, em vez de nascer 'já vencido'", () => {
    // Recusar a string faria a renovação rodar em TODA chamada — caro, e
    // invisível, porque cada renovação isolada parece legítima.
    const r = lerRespostaDeToken({ access_token: "ya29.novo", expires_in: "3599" }, { agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.expira_em).toBe("2026-08-26T12:59:59.000Z");
    expect(precisaRenovar(r.token.expira_em, AGORA)).toBe(false);
  });

  it("texto que não é número continua caindo no conservador 'já vencido'", () => {
    const r = lerRespostaDeToken({ access_token: "ya29.novo", expires_in: "uma hora" }, { agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.expira_em).toBe(AGORA.toISOString());
  });
});

describe("a ORDEM entre fundir e conferir escopo — e não o contrário", () => {
  it("conferir a resposta da renovação DIRETO acusa escopo faltando numa conexão boa", () => {
    // Esta asserção existe para pinar a armadilha, não para abençoá-la: é o
    // resultado ERRADO, e ele é o que se obtém invertendo a ordem.
    const respostaDaRenovacao = lerRespostaDeToken(
      { access_token: "ya29.novo", expires_in: 3600 },
      { agora: AGORA },
    );
    expect(respostaDaRenovacao.ok).toBe(true);
    if (!respostaDaRenovacao.ok) return;
    expect(escoposFaltando(respostaDaRenovacao.token.scope)).toEqual([...ESCOPOS_OBRIGATORIOS]);

    // A ordem certa: fundir primeiro, conferir depois. A fusão é quem preserva
    // o escopo que a renovação não repetiu.
    const fundido = fundirTokens(token(), respostaDaRenovacao.token);
    expect(escoposFaltando(fundido.scope)).toEqual([]);
  });
});

describe("fundirTokens", () => {
  it("PRESERVA o refresh_token que a renovação não repetiu", () => {
    // A armadilha nº 1 de quem implementa isto do zero: `token = novaResposta`
    // apaga o refresh_token e mata a conexão que acabou de renovar.
    const renovado = fundirTokens(
      token(),
      token({ access_token: "ya29.novo", refresh_token: null, expira_em: "2026-08-26T14:00:00.000Z" }),
    );
    expect(renovado.refresh_token).toBe("1//refresh-original");
    expect(renovado.access_token).toBe("ya29.novo");
    expect(renovado.expira_em).toBe("2026-08-26T14:00:00.000Z");
  });

  it("aceita o refresh_token novo quando ele vem — reconexão troca a chave", () => {
    const r = fundirTokens(token(), token({ refresh_token: "1//refresh-novo" }));
    expect(r.refresh_token).toBe("1//refresh-novo");
  });

  it("preserva o escopo quando a resposta não o repete", () => {
    // Perder o escopo faria a conferência acusar falta do que está concedido, e
    // a conexão seria marcada como quebrada estando saudável.
    const r = fundirTokens(token(), token({ scope: [] }));
    expect(r.scope).toEqual([...ESCOPOS_OBRIGATORIOS]);
  });

  it("funciona na primeira conexão, quando não há token anterior", () => {
    const r = fundirTokens(null, token());
    expect(r.refresh_token).toBe("1//refresh-original");
  });
});

describe("escoposFaltando", () => {
  it("acusa o escopo que a pessoa desmarcou na tela de consentimento", () => {
    // Sem esta conferência a conexão é gravada como saudável e falha só no
    // primeiro agendamento, longe da tela que causou o problema.
    expect(escoposFaltando(ESCOPOS_OBRIGATORIOS.join(" "))).toEqual([]);
    expect(escoposFaltando([...ESCOPOS_OBRIGATORIOS, "https://www.googleapis.com/auth/userinfo.profile"])).toEqual([]);
    expect(escoposFaltando("https://www.googleapis.com/auth/calendar.events")).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(escoposFaltando("")).toEqual([...ESCOPOS_OBRIGATORIOS]);
    expect(escoposFaltando(null)).toEqual([...ESCOPOS_OBRIGATORIOS]);
  });
});

describe("precisaRenovar", () => {
  it("renova com folga, não no vencimento", () => {
    const vence = new Date("2026-08-26T13:00:00.000Z");
    // Um minuto e um milissegundo antes: ainda dá para usar.
    expect(precisaRenovar(vence, new Date(vence.getTime() - FOLGA_DE_RENOVACAO_MS - 1))).toBe(false);
    // Exatamente na folga: já renova. A borda é o único lugar onde isto erra.
    expect(precisaRenovar(vence, new Date(vence.getTime() - FOLGA_DE_RENOVACAO_MS))).toBe(true);
    expect(precisaRenovar(vence, new Date(vence.getTime() + 1))).toBe(true);
  });

  it("aceita a validade como texto ou como data", () => {
    expect(precisaRenovar("2026-08-26T13:00:00.000Z", AGORA)).toBe(false);
    expect(precisaRenovar(new Date("2026-08-26T13:00:00.000Z"), AGORA)).toBe(false);
  });

  it("não saber quando vence é o mesmo risco de estar vencido", () => {
    expect(precisaRenovar(null, AGORA)).toBe(true);
    expect(precisaRenovar(undefined, AGORA)).toBe(true);
    expect(precisaRenovar("", AGORA)).toBe(true);
    expect(precisaRenovar("daqui a pouco", AGORA)).toBe(true);
  });

  it("aceita folga própria de quem chama", () => {
    const vence = new Date("2026-08-26T13:00:00.000Z");
    expect(precisaRenovar(vence, new Date("2026-08-26T12:50:00.000Z"), 15 * 60_000)).toBe(true);
    expect(precisaRenovar(vence, new Date("2026-08-26T12:50:00.000Z"), 60_000)).toBe(false);
  });
});

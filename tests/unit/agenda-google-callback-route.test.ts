/**
 * A volta do consentimento do Google.
 *
 * Este arquivo é retorno de NAVEGADOR, e é isso que a maioria destes casos
 * prende: nenhum desfecho pode ser JSON nem 500. Quem clicou num botão e voltou
 * tem de ver a tela da Agenda dizendo o que houve — em português, sem citar
 * parceiro nenhum, e sem que a falha vire uma página em branco.
 *
 * O caso que mais importa não é nenhum erro: é a pessoa clicando "Cancelar" na
 * tela do Google. Isso não é falha, é alguém mudando de ideia — e tratá-lo como
 * erro enche o log e assusta quem não fez nada errado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { emitirEstado } from "@/lib/agenda/google/estado";
import { assinarVinculo, NOME_DO_VINCULO } from "@/lib/agenda/google/vinculo";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
// `@/lib/auth/server` não é mais mockado: o callback deixou de ler a sessão.
// Ela nunca chegava — `sameSite: "strict"` não viaja na volta do Google.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async () => "\\xdeadbeef") }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const SEGREDO = "um-segredo-de-instalacao-bem-comprido";

process.env.INTERNAL_SECRET = SEGREDO;
process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo";
process.env.GOOGLE_CALENDAR_CLIENT_ID = "123.apps.googleusercontent.com";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "GOCSPX-segredo";

const ESCOPOS = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";

/**
 * O nonce do último `state` emitido. O callback deixou de ler a SESSÃO (que
 * nunca chegava: o cookie é `sameSite: "strict"` e não viaja na volta do
 * Google) e passou a exigir o cookie de vínculo emitido na ida. Guardar o nonce
 * aqui é o que permite ao teste montar essa volta como o navegador a faria.
 */
let ultimoNonce = "";

function estadoValido(authSessionId?: string): string {
  ultimoNonce = `nonce-de-teste-${noncesGravados.length}-${Math.random().toString(36).slice(2)}`;
  return emitirEstado(
    { organizationId: ORG, userId: ANA, authSessionId },
    { segredo: SEGREDO, agora: new Date(), nonce: ultimoNonce },
  );
}

/**
 * @param vinculo `"casa"` (o padrão) manda o cookie que a ida emitiu; `"ausente"`
 * omite; `"de-outro"` manda um assinado sobre OUTRO nonce — que é a volta de um
 * navegador que não iniciou este fluxo.
 */
function pedido(
  query: Record<string, string>,
  vinculo: "casa" | "ausente" | "de-outro" = "casa",
): NextRequest {
  const u = new URL("https://crm.exemplo/api/v1/agenda/google/callback");
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const req = new NextRequest(u);
  if (vinculo === "casa" && ultimoNonce) {
    req.cookies.set(NOME_DO_VINCULO, assinarVinculo(ultimoNonce, SEGREDO));
  } else if (vinculo === "de-outro") {
    req.cookies.set(NOME_DO_VINCULO, assinarVinculo("nonce-de-outra-pessoa", SEGREDO));
  }
  return req;
}

/** O `upsert` fake, para inspecionar o que foi gravado. */
let upsertRecebido: Record<string, unknown> | null = null;
/** O que foi gravado em `calendar_connection_calendars` — o registro do calendário primário. */
let calendarioRecebido: Record<string, unknown> | null = null;
/** O que já está gravado para esta conta, quando o teste quer simular reconexão. */
let linhaExistente: Record<string, unknown> | null = null;
/** Erro que o INSERT do nonce devolve — `23505` simula state reapresentado. */
let erroDoNonce: { code: string; message: string } | null = null;
let noncesGravados: string[] = [];
let opcoesDoUpsert: Record<string, unknown> | null = null;
let erroDoUpsert: { message: string } | null = null;

function respostaHttp(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as unknown as Response;
}

function googleRespondendoBem() {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      respostaHttp({ access_token: "ya29.novo", refresh_token: "1//r", expires_in: 3599, scope: ESCOPOS, token_type: "Bearer" }),
    )
    .mockResolvedValueOnce(respostaHttp({ id: "ana@clinica.com.br", timeZone: "America/Sao_Paulo" }));
}

beforeEach(() => {
  upsertRecebido = null;
  calendarioRecebido = null;
  opcoesDoUpsert = null;
  linhaExistente = null;
  erroDoNonce = null;
  noncesGravados = [];
  erroDoUpsert = null;
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(encryptWebhookSecret).mockResolvedValue("\\xdeadbeef");
  vi.mocked(audit).mockClear();
  // Quem volta é, por padrão, o MESMO navegador que pediu o consentimento — o
  // que `pedido()` monta pondo o cookie de vínculo do último `state` emitido.
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => ({
      insert: async (linha: Record<string, unknown>) => {
        noncesGravados.push(String(linha.nonce));
        return { error: erroDoNonce };
      },
      select: () => {
        const cadeia = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: linhaExistente }),
        };
        return cadeia;
      },
      upsert: (linha: Record<string, unknown>, opcoes?: Record<string, unknown>) => {
        // A rota grava DUAS tabelas: a conexão e o calendário primário. Guardar as duas
        // separadamente é o que permite assertar que o sync deixou de nascer mudo — a
        // `calendar_connection_calendars` não tinha UM insert em produção.
        if (tabela === "calendar_connection_calendars") {
          calendarioRecebido = linha;
          return Promise.resolve({ error: null });
        }
        upsertRecebido = linha;
        opcoesDoUpsert = opcoes ?? null;
        // O `.select("id").single()` da rota: o id da conexão é o que liga o calendário a ela.
        const resultado = { data: erroDoUpsert ? null : { id: "conexao-1" }, error: erroDoUpsert };
        return {
          select: () => ({ single: () => Promise.resolve(resultado) }),
          then: (r: (v: unknown) => void) => r(resultado),
        };
      },
    }),
  } as unknown as ReturnType<typeof createAdminClient>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function chamar(
  query: Record<string, string>,
  vinculo: "casa" | "ausente" | "de-outro" = "casa",
) {
  const { GET } = await import("@/app/api/v1/agenda/google/callback/route");
  return GET(pedido(query, vinculo));
}

/**
 * O destino da volta — lido do CORPO da página-ponte, e não do header.
 *
 * ⚠️ A VOLTA DEIXOU DE SER UM 307. Um redirect daqui para `/app/agenda` herda a
 * cadeia iniciada em `accounts.google.com`, o cookie `SameSite=Strict` não
 * viaja, e a pessoa cai no `/login` achando que foi deslogada — o relato do dono
 * na v1.9.0, reproduzido em navegador. Agora `voltar()` responde 200 com uma
 * página que navega por `location.replace`, disparada do NOSSO origin.
 *
 * Este helper existir é o que faz os 14 casos deste arquivo continuarem medindo
 * o que sempre mediram — QUAL destino cada caminho escolhe — sem que nenhum
 * precise saber a forma da resposta.
 */
async function destino(res: Response): Promise<string> {
  const corpo = await res.clone().text();
  const m = /location\.replace\((["'])(.*?)\1\)/.exec(corpo);
  return m?.[2] ?? res.headers.get("location") ?? "";
}

describe("GET /api/v1/agenda/google/callback", () => {
  it("grava a conexão e volta dizendo que conectou", async () => {
    googleRespondendoBem();
    const res = await chamar({ code: "o-codigo", state: estadoValido() });

    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?ok=agenda_conectada");
    expect(upsertRecebido).toMatchObject({
      organization_id: ORG,
      user_id: ANA,
      provider: "google_calendar",
      account_email: "ana@clinica.com.br",
      status: "healthy",
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "agenda.google.conexao_concluida" }));
  });

  it("REGISTRA O CALENDÁRIO PRIMÁRIO — sem ele a conexão existe e não sincroniza nada", async () => {
    // O cron lê `calendar_connection_calendars` filtrando `counts_for_conflicts`. Enquanto
    // ninguém populava essa tabela — medido: ZERO inserts em todo o código de produção —, o
    // select devolvia vazio e o sync iterava zero calendários para sempre. A conexão ficava
    // "healthy" e nada acontecia.
    //
    // Este caso assere o CONTEÚDO, não a chamada: `external_calendar_id` tem de ser o e-mail
    // (é ele o id do calendário primário no Google) e o fuso tem de chegar à coluna em vez de
    // morrer no metadado de auditoria.
    googleRespondendoBem();
    await chamar({ code: "o-codigo", state: estadoValido() });

    expect(calendarioRecebido).toMatchObject({
      organization_id: ORG,
      connection_id: "conexao-1",
      external_calendar_id: "ana@clinica.com.br",
      is_primary: true,
    });
    // O fuso: qualquer valor menos `undefined` — a coluna existe desde a 0193 e o callback
    // tinha o valor na mão, gastando-o só em log.
    expect(calendarioRecebido).toHaveProperty("time_zone");
  });

  it("a org e a pessoa vêm do state ASSINADO, nunca da query", async () => {
    // Service role bypassa RLS. Aceitar org da query aqui seria deixar qualquer
    // um gravar conexão na organização de outro.
    googleRespondendoBem();
    await chamar({
      code: "c",
      state: estadoValido(),
      organization_id: "99999999-9999-4999-8999-999999999999",
      user_id: "88888888-8888-4888-8888-888888888888",
    });
    expect(upsertRecebido).toMatchObject({ organization_id: ORG, user_id: ANA });
  });

  it("o token vai CIFRADO — nunca em claro", async () => {
    googleRespondendoBem();
    await chamar({ code: "c", state: estadoValido() });
    expect(encryptWebhookSecret).toHaveBeenCalledWith(expect.anything(), "ya29.novo");
    expect(encryptWebhookSecret).toHaveBeenCalledWith(expect.anything(), "1//r");
    expect(JSON.stringify(upsertRecebido)).not.toContain("ya29.novo");
    expect(JSON.stringify(upsertRecebido)).not.toContain("1//r");
  });

  // ─── O QUE A MINHA SABOTAGEM NÃO ALCANÇAVA ───────────────────────────────
  //
  // A verificação independente mediu que TRÊS quebras no upsert deixavam a
  // suíte inteira verde. Sabotagem que não alcança o mecanismo dá confiança
  // sobre uma proteção que não existe — é pior que sabotagem que falha, porque
  // falha é visível. Os três casos abaixo são exatamente essas três.

  it("o refresh_token CIFRADO chega à linha — sem ele a conexão morre em uma hora", async () => {
    // Esta é a mais cara das três, e é a que o commit da rota de ida argumenta
    // sem guardar: todo o raciocínio do `prompt=consent` existe para GARANTIR o
    // refresh_token, e nada vigiava o lado que o GRAVA. Quebrando a gravação, a
    // conexão nasce `healthy`, funciona uma hora e morre calada — o relato chega
    // como "minha agenda parou de sincronizar", no dia seguinte, longe daqui.
    googleRespondendoBem();
    vi.mocked(encryptWebhookSecret).mockImplementation(async (_admin, texto) =>
      texto === "1//r" ? "\\xREFRESH" : "\\xACCESS",
    );
    await chamar({ code: "c", state: estadoValido() });

    expect(upsertRecebido).toMatchObject({
      oauth_access_token_encrypted: "\\xACCESS",
      oauth_refresh_token_encrypted: "\\xREFRESH",
    });
    // Controle positivo DENTRO do mesmo objeto: se o `toMatchObject` deixasse de
    // ler o literal, esta linha cairia junto e a asserção acima não passaria por
    // vacuidade.
    expect(upsertRecebido?.account_email).toBe("ana@clinica.com.br");
  });

  it("o vencimento gravado é o que o Google disse, não um palpite", async () => {
    // `expires_in` é RELATIVO. Gravar um vencimento inventado faz o worker de
    // renovação renovar cedo demais (caro) ou tarde demais (401 no meio de um
    // agendamento) — e nenhum dos dois aparece como erro.
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respostaHttp({ access_token: "ya29.novo", refresh_token: "1//r", expires_in: 3599, scope: ESCOPOS, token_type: "Bearer" }),
      )
      .mockResolvedValueOnce(respostaHttp({ id: "ana@clinica.com.br", timeZone: "America/Sao_Paulo" }));
    await chamar({ code: "c", state: estadoValido() });

    expect(upsertRecebido?.token_expires_at).toBe("2026-08-26T12:59:59.000Z");
    vi.useRealTimers();
  });

  it("a chave do upsert separa PESSOAS — duas agendas não viram uma", async () => {
    // `calendar_connections` é por pessoa. Se o `onConflict` esquecer `user_id`,
    // o segundo atendente que conectar SOBRESCREVE a conexão do primeiro: a
    // agenda de um passa a alimentar os horários do outro, e ninguém vê erro
    // nenhum — os dois continuam com uma linha "healthy".
    googleRespondendoBem();
    await chamar({ code: "c", state: estadoValido() });

    const chave = String(opcoesDoUpsert?.onConflict ?? "");
    for (const coluna of ["organization_id", "user_id", "provider", "account_email"]) {
      expect(chave.split(",").map((c) => c.trim())).toContain(coluna);
    }
  });

  it("sem chave de renovação e sem uma guardada, RECUSA — conexão morta não nasce healthy", async () => {
    // Todo o argumento do `prompt=consent` na rota de ida existe para garantir
    // que a chave venha. Se ainda assim não vier, gravar `healthy` faz a agenda
    // funcionar por uma hora e parar calada — o relato chega no dia seguinte,
    // longe daqui, como "minha agenda parou de sincronizar".
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respostaHttp({ access_token: "ya29.x", expires_in: 3599, scope: ESCOPOS, token_type: "Bearer" }),
      )
      .mockResolvedValueOnce(respostaHttp({ id: "ana@clinica.com.br", timeZone: "America/Sao_Paulo" }));

    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=sem_token_de_renovacao");
    expect(upsertRecebido).toBeNull();
  });

  it("reconexão SEM chave nova preserva a guardada — omitir a coluna, nunca mandar null", async () => {
    // `on conflict do update` só toca o que recebe. Mandar `null` apagaria a
    // chave que faz a conexão sobreviver à primeira hora — a mesma armadilha de
    // `fundirTokens`, um andar acima.
    linhaExistente = { oauth_refresh_token_encrypted: "\\xJAGUARDADO" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respostaHttp({ access_token: "ya29.x", expires_in: 3599, scope: ESCOPOS, token_type: "Bearer" }),
      )
      .mockResolvedValueOnce(respostaHttp({ id: "ana@clinica.com.br", timeZone: "America/Sao_Paulo" }));

    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?ok=agenda_conectada");
    expect(upsertRecebido).not.toHaveProperty("oauth_refresh_token_encrypted");
    // Controle positivo: a linha FOI montada, então a ausência acima é omissão
    // deliberada e não objeto vazio.
    expect(upsertRecebido).toMatchObject({ status: "healthy", account_email: "ana@clinica.com.br" });
  });

  it("NENHUM audit carrega token — e o audit é append-only por cinco anos", async () => {
    // `lib/audit` insere `metadata` CRU em `api_audit_log`, sem sanitizador, e a
    // retenção padrão é de cinco anos. O scrub do Sentry não alcança ali. Hoje a
    // rota está certa POR HÁBITO — este caso é o mecanismo, que sobrevive à
    // próxima pessoa.
    googleRespondendoBem();
    await chamar({ code: "c", state: estadoValido() });
    const tudo = JSON.stringify(vi.mocked(audit).mock.calls);
    expect(tudo).not.toContain("ya29.novo");
    expect(tudo).not.toContain("1//r");
    expect(tudo).not.toContain("o-codigo");
    // Controle positivo: o audit FOI chamado, então as ausências acima são
    // ausência de token e não ausência de chamada.
    expect(tudo).toContain("agenda.google.conexao_concluida");
  });

  it("quem clicou Cancelar volta sem erro no log — não é falha, é desistência", async () => {
    const res = await chamar({ error: "access_denied", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=conexao_cancelada");
    expect(audit).not.toHaveBeenCalled();
  });

  it("state de OUTRA pessoa não grava — assinatura não é identidade", async () => {
    // Assinatura prova que o `state` foi emitido por nós; NÃO prova que quem
    // volta é quem pediu. Sem esta checagem, quem interceptar o `state` de
    // outra pessoa dentro dos dez minutos grava a agenda DELA apontando para a
    // conta Google DELE — e os compromissos daquela pessoa passam a ser lidos e
    // escritos numa agenda que não é a dela.
    // O PORTADOR MUDOU, A PROPRIEDADE NÃO. Este caso lia a SESSÃO de outra
    // pessoa; hoje lê o vínculo de outro navegador — que é o que resta quando o
    // cookie de sessão não viaja (`sameSite: "strict"` na volta cross-site, o
    // defeito que a v1.8.0 levou a produção). O que se prova continua sendo:
    // `state` interceptado por terceiro NÃO grava conexão.
    googleRespondendoBem();

    const res = await chamar({ code: "c", state: estadoValido() }, "de-outro");
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=retorno_nao_verificavel");
    expect(upsertRecebido).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.google.conexao_falhou",
        metadata: expect.objectContaining({ reason: "vinculo_ausente_ou_nao_confere" }),
      }),
    );
  });

  it("sem vínculo nenhum também não grava, e o destino é o MESMO", async () => {
    // Um destino só para os dois: distinguir "não trouxe vínculo" de "trouxe o
    // de outro navegador" na URL contaria a quem ataca se o `state` que ele tem
    // pertence a alguém que passou por aqui.
    googleRespondendoBem();

    const res = await chamar({ code: "c", state: estadoValido() }, "ausente");
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=retorno_nao_verificavel");
    expect(upsertRecebido).toBeNull();
  });

  it("o mesmo state NÃO vale duas vezes — o nonce é queimado no primeiro uso", async () => {
    // Ele é assinado e tem dez minutos de prazo; dentro deles valia quantas
    // vezes fosse apresentado. A chave primária da tabela é o próprio nonce: a
    // segunda tentativa viola a unicidade.
    googleRespondendoBem();
    erroDoNonce = { code: "23505", message: "duplicate key value" };

    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=retorno_nao_verificavel");
    expect(upsertRecebido).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: "state_reutilizado" }) }),
    );
  });

  it("a queima vem ANTES da troca do código — senão o `code` é gasto à toa", async () => {
    // O `code` do Google é de uso único. Queimar depois gastaria ele antes de
    // descobrir que o state era repetido, e quem apresentasse o legítimo
    // receberia "código já usado" — um erro que aponta para o Google e não para
    // o replay.
    erroDoNonce = { code: "23505", message: "duplicate key value" };
    await chamar({ code: "c", state: estadoValido() });
    expect(fetch).not.toHaveBeenCalled();
    // Controle positivo: o nonce FOI tentado, então o `fetch` ausente é ordem
    // correta e não rota que parou antes.
    expect(noncesGravados).toHaveLength(1);
  });

  it("nonce indisponível por OUTRO motivo também recusa — falhar fechado", async () => {
    // Sem conseguir gravar não há como garantir uso único, e seguir abriria a
    // porta justamente quando o guarda está indisponível.
    //
    // ⚠️ O Google é mockado AQUI de propósito, e a razão saiu de uma sabotagem:
    // sem isto o caso passava a depender de a queima vir antes do `fetch` —
    // mover a ordem o deixava vermelho por FALTA DE MOCK, não pelo que ele
    // afirma. Teste tem de falhar pelo próprio motivo, senão vira testemunha de
    // uma propriedade que não é a dele.
    googleRespondendoBem();
    erroDoNonce = { code: "08006", message: "connection failure" };
    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=retorno_nao_verificavel");
    expect(upsertRecebido).toBeNull();
  });

  it("state inválido dá UM motivo só — distinguir na URL ajudaria um atacante", async () => {
    const res = await chamar({ code: "c", state: "forjado.zzz" });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=retorno_nao_verificavel");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.google.conexao_falhou" }),
    );
    expect(upsertRecebido).toBeNull();
  });

  it("escopo desmarcado NÃO vira conexão saudável", async () => {
    // A tela do Google deixa desmarcar escopo por escopo. Gravar assim faria a
    // conexão falhar só no primeiro agendamento, longe daqui, com uma mensagem
    // que culpa o calendário.
    vi.mocked(fetch).mockResolvedValueOnce(
      respostaHttp({
        access_token: "ya29.x",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        token_type: "Bearer",
      }),
    );
    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=permissao_incompleta");
    expect(upsertRecebido).toBeNull();
  });

  it("sem chave de cifra ativa, RECUSA — e a recusa não nomeia parceiro nenhum", async () => {
    googleRespondendoBem();
    vi.mocked(encryptWebhookSecret).mockResolvedValue(null);
    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=cifra_indisponivel");
    expect((await destino(res)).toLowerCase()).not.toContain("nuvemshop");
    expect(upsertRecebido).toBeNull();
  });

  it("Google recusando a troca do código não vira 500", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respostaHttp({ error: "invalid_grant" }, 400));
    const res = await chamar({ code: "usado-duas-vezes", state: estadoValido() });
    expect(res.status).toBe(200);
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=troca_de_codigo_falhou");
  });

  it("falha ao gravar volta com motivo, em vez de dizer que conectou", async () => {
    googleRespondendoBem();
    erroDoUpsert = { message: "duplicate key" };
    const res = await chamar({ code: "c", state: estadoValido() });
    expect(await destino(res)).toBe("https://crm.exemplo/app/agenda?erro=nao_consegui_guardar");
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.google.conexao_concluida" }),
    );
  });

  it("NENHUM desfecho é JSON e nenhum é 500", async () => {
    const casos: Array<Record<string, string>> = [
      { error: "access_denied", state: estadoValido() },
      { code: "c", state: "lixo" },
      { state: estadoValido() },
    ];
    for (const q of casos) {
      const res = await chamar(q);
      expect(res.status).toBe(200);
      expect(await destino(res)).toContain("/app/agenda?");
    }
  });
});

const { callbackAllowed } = vi.hoisted(() => ({ callbackAllowed: vi.fn(async () => true) }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: callbackAllowed }));
it("suporte restrito recusa callback antes de trocar código ou gravar conexão", async () => {
  callbackAllowed.mockResolvedValueOnce(false);
  googleRespondendoBem();
  const res = await chamar({ code: "o-codigo", state: estadoValido() });
  expect(await destino(res)).toContain("erro=retorno_nao_verificavel");
  expect(upsertRecebido).toBeNull();
});

 it("auditoria recebe ator e sessão do state validado sem cookie JWT", async () => {
  googleRespondendoBem();
  const session = "33333333-3333-4333-8333-333333333333";
  const { GET } = await import("@/app/api/v1/agenda/google/callback/route");
  await GET(pedido({ state: estadoValido(session), code: "legitimo" }));
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "agenda.google.conexao_concluida", actorUserId: ANA, actorAuthSessionId: session, organizationId: ORG }));
 });

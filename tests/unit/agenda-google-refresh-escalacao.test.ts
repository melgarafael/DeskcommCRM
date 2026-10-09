/**
 * A janela de renovação do Google Agenda — quando a recusa vira RECONECTAR.
 *
 * ─── O defeito que dá nome ao arquivo (#2384) ─────────────────────────────
 *
 * `oauth.ts` monta o `detalhe` da renovação como
 * `` `${error}: ${error_description}` `` — ex.:
 * `invalid_grant: Token has been expired or revoked.`. O cron passa esse texto
 * inteiro em `classificarErroDoGoogle({ error: leitura.detalhe }, "token")`, e
 * a régua era `motivos.includes("invalid_grant")`, de IGUALDADE EXATA: a string
 * com a descrição não casava.
 *
 * Sem o motivo, o desfecho caía em `transitorio`, `estadoDaConexaoApos`
 * devolvia `null`, a conexão continuava `healthy` e a rodada só somava
 * `falhas`. É o sintoma medido na issue: auditoria com
 * `{"examinadas":1,"renovadas":0,"falhas":1,"reautenticar":0}` em TODO ciclo,
 * `last_sync_error` genérico e ninguém avisado de que é preciso reconectar —
 * enquanto o caminho de ENVIO do mesmo evento já dizia "é preciso reconectar".
 *
 * ─── O que este arquivo prende ────────────────────────────────────────────
 *
 * 1. a classificação pura: código + descrição → `reautenticar`; sem descrição
 *    (o caso que já funcionava) → continua; código embutido noutra palavra →
 *    NÃO casa; erro de rede → continua `transitorio`;
 * 2. a ESCALAÇÃO na rodada do cron: a mesma recusa grava `token_expired` e
 *    conta `reautenticar: 1` — o número que ficava preso em 0.
 *
 * O caso 2 é o que separa isto de um teste de função: o defeito não estava na
 * frase, estava em ninguém executar o desfecho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classificarErroDoGoogle, estadoDaConexaoApos } from "@/lib/agenda/google/erros";
import { audit } from "@/lib/audit";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "\\xNOVO"),
  decryptWebhookSecret: vi.fn(async () => "1//refresh-guardado"),
}));

// ⚠️ `import` IÇADO, pelo mesmo motivo do worker: `process.env` escrito no corpo
// do arquivo acontece DEPOIS de `@/lib/env` já ter lido o ambiente.
const AMBIENTE = {
  GOOGLE_CALENDAR_CLIENT_ID: "123.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-segredo",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
};

async function carregarRota() {
  vi.resetModules();
  for (const [k, v] of Object.entries(AMBIENTE)) process.env[k] = v;
  return import("@/app/api/v1/cron/agenda-google-refresh/route");
}

const AGORA = new Date("2026-08-26T12:00:00.000Z");

/** A recusa real do Google, com a descrição que quebra a régua antiga. */
const RECUSA_COM_DESCRICAO = "invalid_grant: Token has been expired or revoked.";

let atualizacoes: Array<{ id: string; campos: Record<string, unknown> }> = [];
let linhas: Array<Record<string, unknown>> = [];
let vinculos: Record<string, unknown>[] = [{ organization_id: "org-1", user_id: "user-1", revoked_at: null }];

function admin() {
  return {
    from: (tabela: string) => {
      if (tabela === "user_organizations") {
        const c: Record<string, unknown> = {
          select: () => c,
          in: () => c,
          then: (r: (v: unknown) => void) => r({ data: vinculos, error: null }),
        };
        return c;
      }
      const consulta = {
        select: () => consulta,
        in: () => consulta,
        not: () => consulta,
        lte: () => consulta,
        order: () => consulta,
        limit: async () => ({ data: linhas, error: null }),
        update: (campos: Record<string, unknown>) => ({
          eq: async (_coluna: string, id: string) => {
            atualizacoes.push({ id, campos });
            return { error: null };
          },
        }),
      };
      return consulta;
    },
  } as never;
}

function conexao(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    organization_id: "org-1",
    user_id: "user-1",
    account_email: "ana@clinica.com.br",
    status: "healthy",
    token_expires_at: "2026-08-26T12:05:00.000Z",
    oauth_access_token_encrypted: "\\xVELHO",
    oauth_refresh_token_encrypted: "\\xREFRESH",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    ...sobrescreve,
  };
}

function respostaHttp(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as unknown as Response;
}

beforeEach(() => {
  atualizacoes = [];
  linhas = [];
  vinculos = [{ organization_id: "org-1", user_id: "user-1", revoked_at: null }];
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(audit).mockClear();
  vi.mocked(decryptWebhookSecret).mockResolvedValue("1//refresh-guardado");
  vi.mocked(encryptWebhookSecret).mockResolvedValue("\\xNOVO");
});
afterEach(() => vi.unstubAllGlobals());

describe("classificarErroDoGoogle — `invalid_grant` com descrição", () => {
  it("a recusa da renovação com `error_description` pede RECONECTAR", () => {
    const c = classificarErroDoGoogle({ error: RECUSA_COM_DESCRICAO }, "token");
    expect(c.desfecho).toBe("reautenticar");
    // É a conexão que muda de estado — `transitorio` devolveria `null` e o
    // banco continuaria `healthy`.
    expect(estadoDaConexaoApos(c.desfecho)).toBe("token_expired");
    // A frase gravada em `last_sync_error` leva o que o Google disse.
    expect(c.mensagem).toContain("reconectar");
    expect(c.mensagem).toContain("invalid_grant");
  });

  it("sem descrição, e com o separador sem texto, o MESMO desfecho — não regredir", () => {
    // São as duas formas que já passavam (só o código) ou que o `oauth.ts`
    // pode montar quando a descrição vem vazia.
    expect(classificarErroDoGoogle({ error: "invalid_grant" }, "token").desfecho).toBe("reautenticar");
    expect(classificarErroDoGoogle({ error: "invalid_grant:" }, "token").desfecho).toBe("reautenticar");
    expect(classificarErroDoGoogle({ error: "invalid_grant: " }, "token").desfecho).toBe("reautenticar");
    // O caso da própria issue, com o status HTTP que o endpoint de token usa.
    expect(classificarErroDoGoogle({ code: 400, error: RECUSA_COM_DESCRICAO }, "token").desfecho).toBe(
      "reautenticar",
    );
  });

  it("código embutido noutra palavra NÃO casa — o prefixo tem de terminar em separador", () => {
    // Controle negativo da régua nova: sem esta asserção, um `startsWith` puro
    // passaria qualquer string que apenas COMEÇA pelo código.
    const c = classificarErroDoGoogle({ error: "invalid_grantante: texto livre" }, "token");
    expect(c.desfecho).toBe("transitorio");
    expect(c.desfecho).not.toBe("reautenticar");
  });

  it("app OAuth errado com descrição continua PERMANENTE — reconectar não conserta", () => {
    // Mesma classe de defeito, logo ao lado: `invalid_client` também chega com
    // `error_description`, e mandar o dono para a tela de consentimento seria
    // um laço (ele autoriza, volta e falha de novo).
    expect(classificarErroDoGoogle({ error: "invalid_client: Client secret not found." }, "token").desfecho).toBe(
      "permanente",
    );
  });

  it("erro de rede continua TRANSITÓRIO — ninguém é mandado reconectar por um timeout", () => {
    // É a outra perna do critério: o prefixo não pode transformar queda de
    // rede em pedido de reconexão.
    for (const erro of [
      { code: "ECONNRESET" },
      { code: "ETIMEDOUT" },
      // O `detalhe` que `token.ts` devolve quando o `fetch` lança.
      { error: "sem resposta do Google: fetch failed" },
      { error: "HTTP 400 com corpo ilegível" },
    ]) {
      const c = classificarErroDoGoogle(erro, "token");
      expect(c.desfecho).toBe("transitorio");
      expect(estadoDaConexaoApos(c.desfecho)).toBeNull();
    }
  });

  it("recusa SEM motivo reconhecido: o status decide — HTTP 400 é `permanente`, sem status é `transitorio` (#2393)", () => {
    // É a mudança que acompanha o status: a régua de `transitorio` já era
    // "status é null ou >= 500"; o que faltava era o status CHEGAR aqui.
    const comStatus = classificarErroDoGoogle({ error: "algo_desconhecido", status: 400 }, "token");
    expect(comStatus.desfecho).toBe("permanente");
    expect(estadoDaConexaoApos(comStatus.desfecho)).toBe("error");
    expect(comStatus.mensagem).toContain("HTTP 400");

    const semStatus = classificarErroDoGoogle({ error: "sem resposta do Google: fetch failed" }, "token");
    expect(semStatus.desfecho).toBe("transitorio");
    expect(estadoDaConexaoApos(semStatus.desfecho)).toBeNull();
    expect(semStatus.mensagem).toContain("sem resposta");
  });
});

describe("agenda-google-refresh — a rodada que precisa ESCALAR para reconectar", () => {
  it("`invalid_grant` com descrição grava `token_expired` e conta `reautenticar: 1`", async () => {
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(
      respostaHttp(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        400,
      ),
    );

    const { renovarAgendasDoGoogle } = await carregarRota();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    // O número que ficava preso em 0 em todo ciclo da auditoria (#2384).
    expect(resumo).toMatchObject({ examinadas: 1, renovadas: 0, reautenticar: 1, falhas: 0 });
    expect(atualizacoes[0]?.campos).toMatchObject({ status: "token_expired" });
    expect(String(atualizacoes[0]?.campos.last_sync_error)).toContain("reconectar");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.google.renovacao_executada",
        metadata: expect.objectContaining({ reautenticar: 1 }),
      }),
    );
  });

  it("falha de REDE não rebaixa a conexão: só `falhas`, sem escrever nada", async () => {
    linhas = [conexao()];
    vi.mocked(fetch).mockRejectedValue(new Error("fetch failed"));

    const { renovarAgendasDoGoogle } = await carregarRota();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo).toMatchObject({ examinadas: 1, renovadas: 0, reautenticar: 0, falhas: 1 });
    // `transitorio` não mexe no estado: a agenda segue saudável e a próxima
    // rodada tenta de novo.
    expect(atualizacoes).toEqual([]);
  });

  it("a recusa SEM descrição também escala — o caso que já funcionava não regride", async () => {
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(respostaHttp({ error: "invalid_grant" }, 400));

    const { renovarAgendasDoGoogle } = await carregarRota();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo).toMatchObject({ reautenticar: 1, falhas: 0 });
    expect(atualizacoes[0]?.campos).toMatchObject({ status: "token_expired" });
  });

  it("recusa 400 SEM motivo reconhecido vira `error`, e a frase diz HTTP 400 (#2393)", async () => {
    // Antes do status, esta mesma recusa caía em `transitorio`: a conexão
    // seguia saudável repetindo para sempre, e a tela dizia "sem resposta"
    // para um Google que respondeu.
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(respostaHttp({ error: "algo_desconhecido" }, 400));

    const { renovarAgendasDoGoogle } = await carregarRota();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo).toMatchObject({ renovadas: 0, reautenticar: 0, falhas: 1 });
    expect(atualizacoes[0]?.campos).toMatchObject({ status: "error" });
    const frase = String(atualizacoes[0]?.campos.last_sync_error);
    expect(frase).toContain("HTTP 400");
    expect(frase).not.toContain("sem resposta");
  });
});

describe("agenda-google-refresh — o status certo para cada resposta do Google (#2393)", () => {
  /** Resposta 200 cujo corpo cai no meio da leitura (timeout ou reset). */
  const corpoCortado = {
    ok: true,
    status: 200,
    json: async () => {
      throw new TypeError("terminated");
    },
  } as unknown as Response;

  it.each([
    ["400 invalid_grant pede reconectar", respostaHttp({ error: "invalid_grant" }, 400), "token_expired"],
    ["401 sem motivo pede reconectar", respostaHttp({}, 401), "token_expired"],
    ["429 recua", respostaHttp({}, 429), "rate_limited"],
    ["503 é passageiro: não mexe na conexão", respostaHttp({}, 503), null],
    ["200 com o corpo cortado é rede: não mexe na conexão", corpoCortado, null],
    ["200 sem access_token não é recusa: não mexe na conexão", respostaHttp({}, 200), null],
  ] as const)("%s", async (_nome, resposta, estado) => {
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(resposta);

    const { renovarAgendasDoGoogle } = await carregarRota();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo).toMatchObject({ examinadas: 1, renovadas: 0 });
    if (estado === null) expect(atualizacoes).toEqual([]);
    else expect(atualizacoes[0]?.campos).toMatchObject({ status: estado });
  });
});

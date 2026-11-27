/**
 * O anti-morte da agenda conectada — a rodada que impede o token de vencer.
 *
 * Este arquivo é o único worker de refresh de OAuth deste repo: medido antes de
 * escrever, `tenant_integrations` carrega colunas de refresh desde sempre com
 * ZERO leitores, porque o token da Nuvemshop não expira. O do Google expira em
 * cerca de uma hora — sem esta rodada a agenda conectada morre no fim do
 * primeiro dia útil, calada.
 *
 * As duas propriedades que mais importam aqui não aparecem no caminho feliz:
 * a rodada não pode APAGAR a chave de renovação ao gravar, e não pode desistir
 * das outras conexões quando uma falha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "\\xNOVO"),
  decryptWebhookSecret: vi.fn(async () => "1//refresh-guardado"),
}));

// ⚠️ `import` é IÇADO: atribuir `process.env` no corpo do arquivo acontece
// DEPOIS de `@/lib/env` já ter lido o ambiente. O worker então enxergava a
// instalação como "sem app OAuth" e devolvia zero em tudo — sete casos
// vermelhos por defeito do instrumento, não do código. A carga vai por import
// dinâmico, com o ambiente montado antes.
const AMBIENTE = {
  GOOGLE_CALENDAR_CLIENT_ID: "123.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-segredo",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
};

async function carregarWorker(sobrescreve: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...AMBIENTE, ...sobrescreve })) process.env[k] = v;
  return import("@/app/api/v1/cron/agenda-google-refresh/route");
}

const AGORA = new Date("2026-08-26T12:00:00.000Z");

/** As atualizações que a rodada mandou ao banco, por id de conexão. */
let atualizacoes: Array<{ id: string; campos: Record<string, unknown> }> = [];
let linhas: Array<Record<string, unknown>> = [];
/** Vínculos de `user_organizations`: por padrão a pessoa é membro ATIVO. */
let vinculos: Record<string, unknown>[] = [{ organization_id: "org-1", user_id: "user-1", revoked_at: null }];

/** Os filtros `in()` pedidos à tabela de conexões. */
let filtros: Array<[string, unknown]> = [];

function admin() {
  return {
    from: (tabela: string) => {
      // `user_organizations` responde quem ainda é membro ATIVO — é o filtro que
      // impede a agenda de um ex-funcionário de continuar sendo lida.
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
        in: (coluna: string, valores: unknown) => {
          filtros.push([coluna, valores]);
          return consulta;
        },
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
  filtros = [];
  linhas = [];
  vinculos = [{ organization_id: "org-1", user_id: "user-1", revoked_at: null }];
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(audit).mockClear();
  vi.mocked(decryptWebhookSecret).mockResolvedValue("1//refresh-guardado");
  vi.mocked(encryptWebhookSecret).mockResolvedValue("\\xNOVO");
});
afterEach(() => vi.unstubAllGlobals());

describe("renovarAgendasDoGoogle", () => {
  it("só pede as conexões do Google — a do Outlook seria marcada para reconectar", async () => {
    const { renovarAgendasDoGoogle } = await carregarWorker();
    await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(filtros).toContainEqual(["provider", ["google_calendar"]]);
  });

  it("QUEM SAIU DA EMPRESA para de ter a agenda renovada", async () => {
    // O token do Google continua válido depois da revogação — ele não sabe nada de RH.
    // Sem este filtro, a agenda PESSOAL de um ex-funcionário segue sendo lida para dentro
    // da empresa da qual ele saiu, indefinidamente. Medido antes de existir: `team/` não
    // mencionava `calendar_connections` uma vez sequer, contra `revoked_at` em 35 arquivos.
    //
    // O corte é no CONSUMO e não só na rota de revogar: quem sair por outro caminho — SQL
    // de suporte, migração, uma segunda rota amanhã — também para de ser sincronizado.
    linhas = [conexao()];
    vinculos = [{ organization_id: "org-1", user_id: "user-1", revoked_at: "2026-08-01T00:00:00.000Z" }];

    const { renovarAgendasDoGoogle } = await carregarWorker();
    const r = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(r.examinadas).toBe(0);
    expect(atualizacoes).toEqual([]);
  });

  it("CONTROLE: sem o vínculo confirmado, NADA é renovado — falha fechada", async () => {
    // A leitura de `user_organizations` falhando não pode virar "sincroniza todo mundo":
    // uma queda de rede viraria vazamento de agenda pessoal.
    linhas = [conexao()];
    vinculos = [];

    const { renovarAgendasDoGoogle } = await carregarWorker();
    const r = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(r.examinadas).toBe(0);
  });

  it("renova quem está para vencer e grava o novo vencimento", async () => {
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(respostaHttp({ access_token: "ya29.novo", expires_in: 3599 }));

    const { renovarAgendasDoGoogle } = await carregarWorker();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo).toMatchObject({ examinadas: 1, renovadas: 1, falhas: 0 });
    expect(atualizacoes[0]?.campos).toMatchObject({
      oauth_access_token_encrypted: "\\xNOVO",
      token_expires_at: "2026-08-26T12:59:59.000Z",
      status: "healthy",
    });
  });

  it("NUNCA escreve na coluna do refresh — é ela que faz a conexão sobreviver", async () => {
    // A resposta da renovação vem SEM `refresh_token`. Se a rodada gravasse o
    // que chegou, apagaria a chave que acabou de renovar e a conexão morreria na
    // hora seguinte — parecendo que a renovação funcionou.
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(respostaHttp({ access_token: "ya29.novo", expires_in: 3599 }));

    const { renovarAgendasDoGoogle } = await carregarWorker();
    await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(atualizacoes[0]?.campos).not.toHaveProperty("oauth_refresh_token_encrypted");
    // Controle positivo: a atualização ACONTECEU, então a ausência acima é
    // omissão deliberada e não rodada que não gravou nada.
    expect(atualizacoes[0]?.campos).toHaveProperty("token_expires_at");
  });

  it("`invalid_grant` marca para reconectar — não fica tentando para sempre", async () => {
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(respostaHttp({ error: "invalid_grant" }, 400));

    const { renovarAgendasDoGoogle } = await carregarWorker();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo.reautenticar).toBe(1);
    expect(atualizacoes[0]?.campos).toMatchObject({ status: "token_expired" });
  });

  it("uma conexão que falha NÃO leva as outras junto", async () => {
    // Um timeout numa agenda não pode deixar as demais sem renovar — é o motivo
    // de `renovarToken` e `classificarErroDoGoogle` não lançarem.
    linhas = [conexao({ id: "conn-1" }), conexao({ id: "conn-2" }), conexao({ id: "conn-3" })];
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue(respostaHttp({ access_token: "ya29.novo", expires_in: 3599 }));

    const { renovarAgendasDoGoogle } = await carregarWorker();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo.examinadas).toBe(3);
    expect(resumo.renovadas).toBe(2);
    expect(atualizacoes.map((a) => a.id)).toContain("conn-3");
  });

  it("conexão sem chave guardada vai direto para reconectar, sem chamar o Google", async () => {
    linhas = [conexao({ oauth_refresh_token_encrypted: null })];
    const { renovarAgendasDoGoogle } = await carregarWorker();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo.reautenticar).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(atualizacoes[0]?.campos).toMatchObject({ status: "token_expired" });
  });

  it("cifra indisponível NÃO rebaixa a conexão — o problema é do servidor", async () => {
    // Marcar `token_expired` aqui mandaria a pessoa reconectar uma agenda que
    // está boa: o que falhou foi a chave de cifra da instalação, não a
    // autorização dela.
    linhas = [conexao()];
    vi.mocked(decryptWebhookSecret).mockResolvedValue(null);

    const { renovarAgendasDoGoogle } = await carregarWorker();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });

    expect(resumo.falhas).toBe(1);
    expect(resumo.reautenticar).toBe(0);
    expect(atualizacoes).toEqual([]);
  });

  it("rodada VAZIA não audita — cron que não fez nada não é mutação", async () => {
    // Esta base já pagou 51.840 linhas/mês de batida vazia de cron.
    linhas = [];
    const { renovarAgendasDoGoogle } = await carregarWorker();
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });
    expect(resumo.examinadas).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada COM efeito audita, com a contagem dentro", async () => {
    linhas = [conexao()];
    vi.mocked(fetch).mockResolvedValue(respostaHttp({ access_token: "ya29.novo", expires_in: 3599 }));
    const { renovarAgendasDoGoogle } = await carregarWorker();
    await renovarAgendasDoGoogle(admin(), { agora: AGORA });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.google.renovacao_executada",
        metadata: expect.objectContaining({ renovadas: 1 }),
      }),
    );
  });

  it("instalação sem app OAuth não faz nada e não audita", async () => {
    // É o estado de quem nunca conectou o Google — não é falha.
    const { renovarAgendasDoGoogle } = await carregarWorker({ GOOGLE_CALENDAR_CLIENT_ID: "" });
    const resumo = await renovarAgendasDoGoogle(admin(), { agora: AGORA });
    expect(resumo.semAppOAuth).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  // ⚠️ A METADE DO LAÇO DE RETORNO QUE AINDA NÃO EXISTE — e a guarda dela se
  // ARMA SOZINHA, em vez de ser um `skip` esperando alguém lembrar.
  //
  // Hoje a rodada marca `token_expired` e escreve o motivo: o banco muda e a
  // tela pode ler, mas ninguém é AVISADO. O invariante 7 pede que a falha
  // apareça onde o humano olha, e o lugar disso aqui é `agent_inbox_items` —
  // que ainda não tem `kind` de agenda. Acrescentá-lo é schema, e está com o
  // Maestro (frente 5), que o inclui na migration dele.
  //
  // A versão anterior disto era um `it.skip` de corpo VAZIO. Ele não
  // vermelheceria nunca: um `skip` sem asserção é marcador, não mecanismo — e o
  // Maestro planejava usá-lo como verificação de que o encaixe funcionou, o que
  // não teria funcionado. É a mesma classe que esta entrega vem caçando o dia
  // todo: a coisa que PARECE gate e não é.
  //
  // O caso abaixo lê o `baseline.sql` e decide sozinho: enquanto o kind não
  // existir, ele registra a dívida; no instante em que a migration do Maestro
  // entrar, ele passa a EXIGIR que o worker escreva o aviso — e fica vermelho
  // até alguém ligar a escrita. Ninguém precisa lembrar de flipar nada.
  it("quando o `kind` existir no banco, o worker TEM de abrir o aviso na Central", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const baseline = readFileSync(path.join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const rota = readFileSync(
      path.join(process.cwd(), "app/api/v1/cron/agenda-google-refresh/route.ts"),
      "utf8",
    );

    const kindNoBanco = baseline.includes("'agenda_google_desconectada'");
    const workerEscreve = rota.includes("agent_inbox_items");

    // Controle: o leitor está vivo? `midia_nao_lida` é um kind que existe há
    // muito, e sem esta linha um `readFileSync` apontando para o lugar errado
    // devolveria "kind não existe" para sempre e a dívida nunca cobraria.
    expect(baseline.includes("'midia_nao_lida'")).toBe(true);

    if (!kindNoBanco) {
      // Dívida ainda aberta, e declarada: nada a exigir do worker enquanto não
      // há valor válido para gravar.
      expect(workerEscreve).toBe(false);
      return;
    }

    // O kind chegou. A partir daqui a ausência do aviso é defeito, não pendência.
    expect(workerEscreve).toBe(true);
  });
});

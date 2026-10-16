import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CREDENCIAL DO GOOGLE VEM DO BANCO, E O `.env` É O PISO.
 *
 * ─── O defeito que a migration 0201 fechou ───────────────────────────────────
 * Conectar o Google exigia SSH na VPS, editar o `.env` e recriar o contêiner. O
 * produto é self-host para quem NÃO programa: o cartão da Agenda nomeava
 * `GOOGLE_CALENDAR_CLIENT_ID` para uma pessoa que não sabe o que é isso.
 *
 * ─── As três propriedades que este arquivo prende ────────────────────────────
 *
 * 1. BANCO PRIMEIRO. A ordem é a de `lib/channels/zernio/credentials.ts`, e o
 *    argumento é o mesmo: no contrário, um env esquecido silenciaria a
 *    configuração feita pela tela e o operador não entenderia por que nada
 *    mudou — o pior desfecho possível para uma tela de configuração.
 *
 * 2. O `.env` CONTINUA VALENDO quando o banco não tem nada. Ele é o piso de
 *    rollback: o `agent.sh` do kit reverte só a IMAGEM, não o schema, então o
 *    rollback põe código antigo sobre banco novo por construção. Código antigo
 *    não conhece `platform_google_oauth`. Sem o piso, a conexão do Google
 *    sumiria no meio de um rollback — o pior momento para o cliente descobrir
 *    mais um problema.
 *
 * 3. AS DUAS FONTES NÃO SE MISTURAM. Se o segredo do banco não decifrar (chave
 *    mestra trocada, linha corrompida), o resolvedor NÃO combina o `client_id`
 *    do banco com o `client_secret` do `.env`: esse par não existe em app OAuth
 *    nenhum, e o Google recusaria com um erro que aponta para ele em vez de para
 *    a divergência. Cai inteiro para o ambiente.
 *
 * ─── Por que aqui, e não no arquivo irmão ────────────────────────────────────
 * `agenda-google-config.test.ts` mede o leitor PURO (`configuracaoDoAmbiente`),
 * que continua síncrono e sem banco. Este mede a RESOLUÇÃO, que passou a ser
 * assíncrona. Separados porque são perguntas diferentes, e juntar as duas faria
 * cada caso puro depender de um dublê de banco.
 */

const ORIGINAL = { ...process.env };

/** O que o dublê do banco devolve — trocado caso a caso. */
let linhaDoBanco: { client_id: string | null; client_secret_encrypted: string | null } | null = null;
let erroDaLeitura: { code: string; message: string } | null = null;
/** O que a decifra devolve. `null` = falhou. */
let decifrado: string | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          abortSignal: () => ({
            maybeSingle: async () => ({ data: linhaDoBanco, error: erroDaLeitura }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => decifrado,
}));

const NO_ENV = {
  GOOGLE_CALENDAR_CLIENT_ID: "do-env.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-do-env",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
};

async function importarComEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  const mod = await import("@/lib/agenda/google/config");
  // O memo mora no `globalThis` (o Turbopack instancia o módulo duas vezes no
  // mesmo processo), então `resetModules` NÃO o limpa — sem esta linha, o
  // segundo caso leria o resultado do primeiro e passaria pelo motivo errado.
  mod.invalidarCredencialDoGoogle();
  return mod;
}

beforeEach(() => {
  linhaDoBanco = null;
  erroDaLeitura = null;
  decifrado = null;
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("configuracaoDoGoogle: banco primeiro, .env como piso", () => {
  it("o que está no BANCO vence o que está no .env", () => {
    // A propriedade nº 1. Sem ela, quem cadastra pela tela numa instalação que
    // já tem o par no `.env` não vê efeito nenhum e conclui que a tela não salva.
    linhaDoBanco = { client_id: "do-banco.apps.googleusercontent.com", client_secret_encrypted: "\\xCIFRADO" };
    decifrado = "GOCSPX-do-banco";
    return importarComEnv(NO_ENV).then(async ({ configuracaoDoGoogle }) => {
      const app = await configuracaoDoGoogle();
      expect(app?.clientId).toBe("do-banco.apps.googleusercontent.com");
      expect(app?.clientSecret).toBe("GOCSPX-do-banco");
    });
  });

  it("sem linha no banco, vale o .env — é o piso de rollback", async () => {
    linhaDoBanco = null;
    const { configuracaoDoGoogle } = await importarComEnv(NO_ENV);
    const app = await configuracaoDoGoogle();
    expect(app?.clientId).toBe("do-env.apps.googleusercontent.com");
    expect(app?.clientSecret).toBe("GOCSPX-do-env");
  });

  it("tabela inexistente (clone sem a 0201) NÃO derruba a Agenda", async () => {
    // Esta função roda no render da Agenda: um throw aqui é 500 na tela inteira.
    // O clone que ainda não aplicou a migration devolve 42P01, e isso não é erro
    // desta instalação — é o piso funcionando.
    erroDaLeitura = { code: "42P01", message: 'relation "platform_google_oauth" does not exist' };
    const { configuracaoDoGoogle } = await importarComEnv(NO_ENV);
    const app = await configuracaoDoGoogle();
    expect(app?.clientId).toBe("do-env.apps.googleusercontent.com");
  });

  it("decifra que falha cai para o .env INTEIRO — as fontes não se misturam", async () => {
    // A propriedade nº 3, e é a menos óbvia: o caminho tentador seria usar o
    // `client_id` do banco com o segredo do `.env`. Esse par não existe em app
    // OAuth nenhum, e o Google recusaria apontando para si mesmo.
    linhaDoBanco = { client_id: "do-banco.apps.googleusercontent.com", client_secret_encrypted: "\\xCORROMPIDO" };
    decifrado = null;
    const { configuracaoDoGoogle } = await importarComEnv(NO_ENV);
    const app = await configuracaoDoGoogle();
    expect(app?.clientId, "misturou o client_id do banco com o segredo do .env").toBe(
      "do-env.apps.googleusercontent.com",
    );
    expect(app?.clientSecret).toBe("GOCSPX-do-env");
  });

  it("banco com client_id e SEM segredo não conta como configurado", async () => {
    // Meia credencial é indistinguível de nenhuma para o Google, e usá-la faria
    // a tela dizer "conectado" e o fluxo quebrar no consentimento.
    linhaDoBanco = { client_id: "so-o-id.apps.googleusercontent.com", client_secret_encrypted: null };
    const { configuracaoDoGoogle, googleEstaConfigurado } = await importarComEnv({
      ...NO_ENV,
      GOOGLE_CALENDAR_CLIENT_ID: "",
      GOOGLE_CALENDAR_CLIENT_SECRET: "",
    });
    expect(await configuracaoDoGoogle()).toBeNull();
    expect(await googleEstaConfigurado()).toBe(false);
  });
});

describe("faltaParaConectarOGoogle: só reclama quando as DUAS fontes estão vazias", () => {
  it("com credencial no BANCO, não manda ninguém editar o .env", async () => {
    // ⚠️ Este caso é a razão de a função ter virado assíncrona. Antes ela lia só
    // o ambiente — e depois da 0201 isso mandaria o dono de uma instalação que
    // JÁ cadastrou a credencial pela tela ir procurar variáveis num arquivo.
    linhaDoBanco = { client_id: "do-banco.apps.googleusercontent.com", client_secret_encrypted: "\\xCIFRADO" };
    decifrado = "GOCSPX-do-banco";
    const { faltaParaConectarOGoogle } = await importarComEnv({
      NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
      GOOGLE_CALENDAR_CLIENT_ID: "",
      GOOGLE_CALENDAR_CLIENT_SECRET: "",
    });
    expect(await faltaParaConectarOGoogle()).toEqual([]);
  });

  it("sem nenhuma das duas fontes, diz os nomes das variáveis", async () => {
    const { faltaParaConectarOGoogle } = await importarComEnv({
      NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
      GOOGLE_CALENDAR_CLIENT_ID: "",
      GOOGLE_CALENDAR_CLIENT_SECRET: "",
    });
    expect(await faltaParaConectarOGoogle()).toEqual([
      "GOOGLE_CALENDAR_CLIENT_ID",
      "GOOGLE_CALENDAR_CLIENT_SECRET",
    ]);
  });
});

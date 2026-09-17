import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CREDENCIAL DO APP DA META VEM DO BANCO, E O `.env` É O PISO.
 *
 * ─── O defeito que a migration 0257 fecha ────────────────────────────────────
 *
 * Conectar a API oficial exigia SSH na VPS, editar o `.env` e recriar
 * `app`/`worker` — e só funcionava para UM número por instalação. Quem opera
 * uma VPS para a própria empresa não tem como fazer isso sozinho, e a tela do
 * canal oficial dizia apenas "não configurado nesta instalação".
 *
 * ─── As três propriedades que este arquivo prende ────────────────────────────
 *
 * 1. BANCO PRIMEIRO. A ordem é a de `lib/agenda/google/config.ts` (migration
 *    0201), e o argumento é o mesmo: no contrário, um env esquecido silenciaria
 *    a configuração feita pela tela e o operador não entenderia por que nada
 *    mudou — o pior desfecho possível para uma tela de configuração.
 *
 * 2. O `.env` CONTINUA VALENDO quando o banco não tem nada. Ele é o piso de
 *    rollback: o `agent.sh` do kit reverte só a IMAGEM, não o schema, então o
 *    rollback põe código antigo sobre banco novo por construção. Código antigo
 *    não conhece `platform_meta_app`. Sem o piso, o webhook pararia de aceitar
 *    entrega no meio de um rollback — o pior momento para o cliente descobrir
 *    mais um problema.
 *
 *    E é também a razão de a instalação que SÓ tem env continuar idêntica: o
 *    caminho antigo não muda de comportamento nem de resposta.
 *
 * 3. AS DUAS FONTES NÃO SE MISTURAM. O `META_APP_SECRET` e o verify token são
 *    as duas metades do MESMO app da Meta: um app aceita requisição assinada
 *    pelo segredo dele, e a Meta só entrega em URL cujo handshake respondeu com
 *    o verify token cadastrado nele. Segredo do `.env` com verify token do
 *    banco é um par que não existe em app nenhum — a entrega passa no handshake
 *    e toda mensagem morre em `401 invalid_signature`, que é a falha SILENCIOSA
 *    que a issue #850 mediu.
 *
 * ─── Por que aqui, e não na rota ─────────────────────────────────────────────
 * `webhook-meta-le-do-banco.test.ts` mede o que a ROTA responde (status e
 * corpo, com a Meta do outro lado). Este mede a RESOLUÇÃO: precedência, piso e
 * não-mistura, que valem para qualquer leitor — a rota do webhook e o aviso do
 * primeiro acesso, entre outros.
 */

const ORIGINAL = { ...process.env };

/** O que o dublê do banco devolve — trocado caso a caso. */
let linhaDoBanco: { app_secret_encrypted: string | null; verify_token_encrypted: string | null } | null = null;
let erroDaLeitura: { code: string; message: string } | null = null;
/** Leitura que ESTOURA (client quebrado, rede caindo) — não é o mesmo que erro devolvido. */
let estoura: Error | null = null;
/** Quantas vezes o banco foi consultado — o memo é medido, não declarado. */
let leituras = 0;
/** O que a decifra devolve, por texto cifrado. `undefined` = não decifrou. */
let decifrado: Record<string, string | null> = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            leituras += 1;
            if (estoura) throw estoura;
            return { data: linhaDoBanco, error: erroDaLeitura };
          },
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_admin: unknown, cifrado: string) => decifrado[cifrado] ?? null,
}));

/** O par como o `.env` de uma instalação que só tem ambiente o traz. */
const NO_ENV = {
  META_APP_SECRET: "segredo-do-env",
  META_WEBHOOK_VERIFY_TOKEN: "token-do-env",
};

async function importarComEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("@/lib/channels/meta/app");
  // O memo mora no `globalThis` (o Turbopack instancia o módulo duas vezes no
  // mesmo processo), então `resetModules` NÃO o limpa — sem esta linha, o
  // segundo caso leria o resultado do primeiro e passaria pelo motivo errado.
  mod.invalidarAppDaMeta();
  return mod;
}

/** A linha com as duas metades gravadas, como a server action a deixa. */
const LINHA_CHEIA = {
  app_secret_encrypted: "\\xSEGREDO_CIFRADO",
  verify_token_encrypted: "\\xTOKEN_CIFRADO",
};

beforeEach(() => {
  linhaDoBanco = null;
  erroDaLeitura = null;
  estoura = null;
  leituras = 0;
  decifrado = {};
  delete process.env.META_APP_SECRET;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("appDaMeta: banco primeiro, .env como piso", () => {
  it("o que está no BANCO vence o que está no .env", async () => {
    // A propriedade nº 1. Sem ela, quem cadastra pela tela numa instalação que
    // já tem o par no `.env` não vê efeito nenhum e conclui que a tela não salva.
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": "segredo-do-banco", "\\xTOKEN_CIFRADO": "token-do-banco" };

    const { appDaMeta } = await importarComEnv(NO_ENV);
    const app = await appDaMeta();

    expect(app.appSecret).toBe("segredo-do-banco");
    expect(app.verifyToken).toBe("token-do-banco");
  });

  it("sem linha no banco, valem as duas variáveis do .env — é o piso de rollback", async () => {
    linhaDoBanco = null;

    const { appDaMeta } = await importarComEnv(NO_ENV);
    const app = await appDaMeta();

    expect(app.appSecret).toBe("segredo-do-env");
    expect(app.verifyToken).toBe("token-do-env");
  });

  it("tabela inexistente (clone sem a 0257) NÃO derruba o webhook", async () => {
    // Esta função é chamada a cada entrega da Meta: um throw aqui é 500 no
    // webhook, e a Meta reentrega em backoff um evento que nunca vai melhorar.
    // O clone que ainda não aplicou a migration devolve 42P01, e isso não é erro
    // desta instalação — é o piso funcionando.
    erroDaLeitura = { code: "42P01", message: 'relation "platform_meta_app" does not exist' };

    const { appDaMeta } = await importarComEnv(NO_ENV);
    const app = await appDaMeta();

    expect(app.appSecret).toBe("segredo-do-env");
    expect(app.verifyToken).toBe("token-do-env");
  });

  it("leitura que ESTOURA não sobe — a rota responde com o que o .env tem", async () => {
    estoura = new Error("fetch failed");

    const { appDaMeta } = await importarComEnv(NO_ENV);
    await expect(appDaMeta()).resolves.toEqual({
      appSecret: "segredo-do-env",
      verifyToken: "token-do-env",
    });
  });

  it("decifra que falha cai para o .env INTEIRO — as fontes não se misturam", async () => {
    // A propriedade nº 3, e é a menos óbvia: o caminho tentador seria usar o
    // segredo do banco com o verify token do `.env`. Esse par não existe em app
    // nenhum da Meta, e o desfecho é a entrega passar no handshake e toda
    // mensagem morrer em 401 — sem sintoma em tela nenhuma.
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": "segredo-do-banco", "\\xTOKEN_CIFRADO": null };

    const { appDaMeta } = await importarComEnv(NO_ENV);
    const app = await appDaMeta();

    expect(app.appSecret, "misturou o segredo do banco com o verify token do .env").toBe("segredo-do-env");
    expect(app.verifyToken).toBe("token-do-env");
  });

  it("meia credencial no banco não conta — o par só vale inteiro", async () => {
    // A linha pode existir com uma metade só (gravação interrompida, coluna
    // esvaziada à mão). Meia credencial é indistinguível de nenhuma para quem
    // entrega, e usá-la faria o handshake passar enquanto o HMAC continuaria
    // reprovando toda mensagem.
    linhaDoBanco = { app_secret_encrypted: "\\xSEGREDO_CIFRADO", verify_token_encrypted: null };
    decifrado = { "\\xSEGREDO_CIFRADO": "segredo-do-banco" };

    const { appDaMeta } = await importarComEnv(NO_ENV);
    const app = await appDaMeta();

    expect(app.appSecret).toBe("segredo-do-env");
    expect(app.verifyToken).toBe("token-do-env");
  });

  it("sem nada em lugar nenhum, os DOIS campos são null — nem string vazia", async () => {
    // `""` e `null` não são a mesma coisa para quem chama: a rota passa o valor
    // direto para o HMAC e para o handshake, e string vazia é ausente — como em
    // `metaPodeReceber` (`lib/channels/meta/webhook.ts`).
    const { appDaMeta } = await importarComEnv({ META_APP_SECRET: "   ", META_WEBHOOK_VERIFY_TOKEN: "" });
    expect(await appDaMeta()).toEqual({ appSecret: null, verifyToken: null });
  });
});

describe("o memo do processo", () => {
  it("duas leituras seguidas NÃO fazem duas consultas — o webhook não paga uma ida ao banco por evento", async () => {
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": "s", "\\xTOKEN_CIFRADO": "t" };

    const { appDaMeta } = await importarComEnv(NO_ENV);
    await appDaMeta();
    await appDaMeta();

    expect(leituras).toBe(1);
  });

  it("invalidarAppDaMeta() faz a próxima leitura ir ao banco de novo", async () => {
    // É o que a server action chama no MESMO processo que renderiza (na VPS há
    // um processo de app só), para a credencial nova valer sem esperar o TTL.
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": "s", "\\xTOKEN_CIFRADO": "t" };

    const { appDaMeta, invalidarAppDaMeta } = await importarComEnv(NO_ENV);
    await appDaMeta();
    invalidarAppDaMeta();
    linhaDoBanco = null;
    const app = await appDaMeta();

    expect(leituras).toBe(2);
    expect(app.appSecret, "serviu credencial velha depois de invalidar").toBe("segredo-do-env");
  });
});

describe("fontesDoAppDaMeta: as mesmas chaves do .env, para quem lê por nome de variável", () => {
  it("com o par no BANCO, a instalação PODE receber sem tocar no .env", async () => {
    // O aviso do primeiro acesso perguntava só ao ambiente, e depois da 0257
    // isso diria "não dá para receber" a quem acabou de configurar pela tela —
    // mandando o dono editar um arquivo que ele não precisa abrir.
    linhaDoBanco = LINHA_CHEIA;
    decifrado = { "\\xSEGREDO_CIFRADO": "segredo-do-banco", "\\xTOKEN_CIFRADO": "token-do-banco" };

    const { fontesDoAppDaMeta } = await importarComEnv({});
    expect(await fontesDoAppDaMeta()).toEqual({
      META_APP_SECRET: "segredo-do-banco",
      META_WEBHOOK_VERIFY_TOKEN: "token-do-banco",
    });
  });

  it("sem banco e sem env, o que falta vem como `undefined`, não como string vazia", async () => {
    const { fontesDoAppDaMeta } = await importarComEnv({});
    const fontes = await fontesDoAppDaMeta();
    expect(fontes.META_APP_SECRET).toBeUndefined();
    expect(fontes.META_WEBHOOK_VERIFY_TOKEN).toBeUndefined();
  });
});

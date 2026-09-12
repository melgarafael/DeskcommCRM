/**
 * O app OAuth do Google desta instalação.
 *
 * O caso que estes testes existem para proteger é o do PRIMEIRO DEPLOY: uma VPS
 * recém-instalada não tem chave do Google nenhuma, e a Agenda tem de funcionar
 * inteira assim mesmo. Módulo que se recusa a abrir porque falta uma chave que o
 * operador nem sabia que existia é abandono na primeira tela.
 *
 * ⚠️ ESTES CASOS MEDEM O AMBIENTE, e agora dizem isso no nome da função que
 * chamam. `configuracaoDoGoogle()` passou a ser ASSÍNCRONA e a ler
 * `platform_google_oauth` antes do `.env` (migration 0201, banco primeiro) —
 * mantê-los apontando para ela faria cada caso puro depender de um client de
 * banco. `configuracaoDoAmbiente()` é o leitor puro e síncrono, e é ele que
 * carrega a propriedade que este arquivo existe para proteger: o piso de
 * rollback continua de pé quando o código antigo volta sobre o banco novo.
 *
 * A resolução com banco tem cerca própria em `agenda-google-credencial-do-banco`
 * (precedência, decifra que falha, e o `.env` como piso).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

// Estes casos medem o leitor do ambiente. A credencial de uma instalação local
// já configurada pela tela não pode transformar "sem chave" em teste falso.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => null,
}));

async function importarComEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return import("@/lib/agenda/google/config");
}

beforeEach(() => {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const COMPLETO = {
  GOOGLE_CALENDAR_CLIENT_ID: "123.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-segredo",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
};

describe("configuracaoDoAmbiente", () => {
  it("devolve a configuração quando a instalação tem app OAuth", async () => {
    const { configuracaoDoAmbiente } = await importarComEnv(COMPLETO);
    expect(configuracaoDoAmbiente()).toEqual({
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-segredo",
      redirectUri: "https://crm.exemplo/api/v1/agenda/google/callback",
    });
  });

  it("devolve `null` — e NÃO lança — quando falta chave", async () => {
    // Lançar aqui derrubaria a tela de Agenda inteira numa instalação que só
    // não conectou o Google, que é o estado normal de um primeiro deploy.
    const { configuracaoDoAmbiente } = await importarComEnv({
      ...COMPLETO,
      GOOGLE_CALENDAR_CLIENT_SECRET: "",
    });
    expect(() => configuracaoDoAmbiente()).not.toThrow();
    expect(configuracaoDoAmbiente()).toBeNull();
  });

  it("a URL pública vazia nem carrega o módulo — a garantia é do env.ts, não guarda daqui", async () => {
    // Este teste começou querendo exercitar uma guarda para `NEXT_PUBLIC_APP_URL`
    // vazia e NÃO CONSEGUIU MONTAR O CENÁRIO: `lib/env.ts` a declara `.url()`
    // com default, então string vazia reprova na validação e o import LANÇA
    // antes de qualquer código meu rodar. A guarda que eu tinha escrito era
    // inalcançável e foi removida — guarda que não pode ser testada dá sensação
    // de defesa sem defender. O que fica aqui é a prova da garantia real.
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_URL = "";
    await expect(import("@/lib/env")).rejects.toThrow(/Variáveis de ambiente inválidas/);
  });

  it("espaço em branco não conta como configurado", async () => {
    // `install.sh` grava a chave declarada mesmo quando o operador não
    // responde, então "vazio" chega como string — às vezes com espaço.
    const { configuracaoDoAmbiente } = await importarComEnv({ ...COMPLETO, GOOGLE_CALENDAR_CLIENT_ID: "   " });
    expect(configuracaoDoAmbiente()).toBeNull();
  });
});

describe("enderecoDeRetorno", () => {
  it("é UMA fonte só, e o consentimento e a troca do código usam ela", async () => {
    // O Google compara o redirect_uri dos dois lados byte a byte. Duas fontes
    // que divergem quebram com `redirect_uri_mismatch`, um erro que aponta para
    // o Google e não para a divergência.
    const { enderecoDeRetorno, configuracaoDoAmbiente } = await importarComEnv(COMPLETO);
    expect(configuracaoDoAmbiente()?.redirectUri).toBe(enderecoDeRetorno());
  });

  it("não produz barra dupla nem barra final", async () => {
    const { enderecoDeRetorno } = await importarComEnv(COMPLETO);
    expect(enderecoDeRetorno("https://crm.exemplo/")).toBe("https://crm.exemplo/api/v1/agenda/google/callback");
    expect(enderecoDeRetorno("https://crm.exemplo///")).toBe("https://crm.exemplo/api/v1/agenda/google/callback");
    expect(enderecoDeRetorno("https://crm.exemplo")).toBe("https://crm.exemplo/api/v1/agenda/google/callback");
  });

  it("aceita a origem localhost do navegador no desenvolvimento local", async () => {
    const { enderecoDeRetorno, origemLocalDoNavegador } = await importarComEnv({
      ...COMPLETO,
      NEXT_PUBLIC_APP_URL: "http://192.168.0.21:3001",
    });
    const origem = origemLocalDoNavegador("http://localhost:3001");
    expect(origem).toBe("http://localhost:3001");
    expect(enderecoDeRetorno(origem ?? undefined)).toBe("http://localhost:3001/api/v1/agenda/google/callback");
  });

  it("não deixa host externo substituir a URL canônica", async () => {
    const { origemLocalDoNavegador } = await importarComEnv(COMPLETO);
    expect(origemLocalDoNavegador("https://nao-confiavel.exemplo")).toBeNull();
  });

  it("lê localhost do Host real da requisição", async () => {
    const { origemLocalDosCabecalhos } = await importarComEnv(COMPLETO);
    expect(origemLocalDosCabecalhos(new Headers({ host: "localhost:3001" }))).toBe("http://localhost:3001");
    expect(origemLocalDosCabecalhos(new Headers({ host: "192.168.0.21:3001" }))).toBeNull();
  });
});

describe("faltaParaConectarOGoogle", () => {
  it("diz o que falta pelo NOME, em vez de só desabilitar o botão", async () => {
    // Controle desabilitado sem explicação é o defeito do controle decorativo
    // virado do avesso: o operador vê que não pode e não descobre por quê.
    const { faltaParaConectarOGoogle } = await importarComEnv({
      ...COMPLETO,
      GOOGLE_CALENDAR_CLIENT_ID: "",
      GOOGLE_CALENDAR_CLIENT_SECRET: "",
    });
    expect(await faltaParaConectarOGoogle()).toEqual([
      "GOOGLE_CALENDAR_CLIENT_ID",
      "GOOGLE_CALENDAR_CLIENT_SECRET",
    ]);
  });

  it("nada falta quando está tudo lá", async () => {
    const { faltaParaConectarOGoogle } = await importarComEnv(COMPLETO);
    expect(await faltaParaConectarOGoogle()).toEqual([]);
  });
});

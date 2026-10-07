/**
 * #686 — a varredura de CLASSE, não mais um caso avulso.
 *
 * O defeito de origem: o gerador de nome de sessão WAHA emitia 69 caracteres,
 * o WAHA recusa acima de 54, e o invariante que existia media ESTABILIDADE
 * (mesmo valor no retry), nunca VALIDADE. Estabilidade e validade são
 * propriedades diferentes — a primeira passa alegremente com a segunda quebrada.
 *
 * O #658 consertou o nome de sessão; o #1346 estendeu a FORMA ao nome de
 * arquivo no Storage. Esta peça fecha o que a issue pede: um registro único de
 * todo identificador que sai daqui e entra num sistema de terceiro, com o teto
 * (ou a forma) que o TERCEIRO impõe conferido aqui — e uma varredura que reprova
 * o surgimento de um site de fronteira fora do registro.
 *
 * Três regras, na ordem em que são baratas de quebrar:
 *
 *   1. se o terceiro documenta número, o número está no teste, vindo da MESMA
 *      constante que o código usa — comentário não vale;
 *   2. se o terceiro documenta forma (alfabeto/padrão), todo valor que mandamos
 *      passa por ela;
 *   3. se o terceiro NÃO documenta nada, a lacuna entra com motivo escrito.
 *      Número não medido não vira teto: vira lacuna declarada.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ALFABETO_DO_NOME_NO_STORAGE } from "@/lib/ai/skills/package";
import { TETO_NOME_DE_SESSAO_WAHA, nomeCurtoDaSessao, nomeDaSessaoNovo } from "@/lib/channels/nome-da-sessao";
import { randomId } from "@/lib/random-id";
import { nomeDaSessaoDeVoz } from "@/lib/wacalls/nome-da-sessao";

const RAIZ = process.cwd();
const ORG = "20000000-0000-4000-8000-000000000001";
const VERSAO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** RFC 9110 §5.1 — `field-name = token`. Fora disto, o HTTP do receptor recusa. */
const TOKEN_DE_CABECALHO = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type Fronteira = {
  id: string;
  /** Quem recebe o que a gente manda. */
  terceiro: string;
  /** Teto documentado PELO TERCEIRO. `null` = não documentado → lacuna obrigatória. */
  teto: number | null;
  /** Forma (alfabeto/padrão) documentada pelo terceiro. */
  forma: RegExp | null;
  /** Onde isso está escrito — URL ou arquivo do repo. Nunca "eu acho". */
  fonte: string;
  /** Motivo de não haver teto. Obrigatório quando `teto` é null. */
  lacuna?: string;
  /** O que a nossa código manda para lá, hoje. */
  medir: () => readonly string[];
};

const FRONTEIRAS: Fronteira[] = [
  {
    id: "waha.nome-da-sessao",
    terceiro: "WAHA (devlikeapro/waha)",
    teto: TETO_NOME_DE_SESSAO_WAHA,
    forma: /^[a-zA-Z0-9_-]+$/,
    fonte:
      "lib/channels/nome-da-sessao.ts:27-34 — o @MaxLength(54) e o @Matches do DTO do WAHA; o mesmo 54 é o do teste de banco",
    medir: () => [nomeCurtoDaSessao(ORG), nomeDaSessaoNovo(ORG, VERSAO)],
  },
  {
    id: "wacalls.nome-da-sessao",
    terceiro: "WaCalls (relay de voz)",
    teto: null,
    forma: null,
    fonte: "lib/wacalls/nome-da-sessao.ts — o upstream não publica limite de `name` nesta página",
    lacuna:
      "é o segundo gerador de nome de sessão do produto e vai para um terceiro diferente do WAHA. O que sai hoje é `org_` + uuid (40). Sem documento do WaCalls dizendo o teto, o teto não é inventado: fica medido aqui, pendente de número.",
    medir: () => [nomeDaSessaoDeVoz(ORG)],
  },
  {
    id: "storage.chave-de-objeto",
    terceiro: "Supabase Storage",
    teto: null,
    forma: ALFABETO_DO_NOME_NO_STORAGE,
    fonte:
      "https://supabase.com/docs/guides/storage/uploads/file-limits — seção «File name restrictions»",
    lacuna:
      "a mesma página documenta o alfabeto do nome de arquivo e não documenta teto de comprimento da chave. Forma entra no teste; número, não.",
    medir: () => [ORG, VERSAO, "minha skill", "SKILL.md", "assets", "referencia.md"],
  },
  {
    id: "api.idempotency-key",
    terceiro: "integrações de terceiro chamando a nossa API",
    teto: null,
    forma: UUID_V4,
    fonte: "lib/extensions/http.ts:96 — `z.string().uuid()`, a forma que exigimos de quem chama",
    lacuna:
      "a chave entra na NOSSA API, não na deles: quem impõe a forma somos nós (UUID v4) e o terceiro não publica teto nenhum sobre ela.",
    medir: () => [randomId()],
  },
  {
    id: "webhook.cabecalhos-de-saida",
    terceiro: "receptor do webhook de saída (sistema do cliente)",
    teto: null,
    forma: TOKEN_DE_CABECALHO,
    fonte: "RFC 9110 §5.1 — `field-name = token`; o nome fora do token não vira cabeçalho válido",
    lacuna:
      "HTTP não impõe teto de comprimento de nome de campo — impõe sintaxe. O id de entrega que sai junto é uuid v5 (36) por construção, RFC 9562 §5.5.",
    medir: () => nomesDeCabecalho(),
  },
  {
    id: "mensagens.external_id",
    terceiro: "WAHA / Meta (id da mensagem, deles para nós)",
    teto: null,
    forma: null,
    fonte: "supabase/baseline.sql — colunas `external_id`",
    lacuna:
      "identificador INBOUND: quem gera é o terceiro e ele não publica comprimento. O nosso dever aqui não é impor teto, é NÃO TRUNCAR — verificado no teste do schema logo abaixo.",
    medir: () => [],
  },
];

const IDS = new Set(FRONTEIRAS.map((f) => f.id));

const FONTE_DO_WEBHOOK = readFileSync(
  join(RAIZ, "lib", "automation", "actions", "call-webhook.ts"),
  "utf8",
);

/** Os nomes de cabeçalho que esta ação de fato emite, lidos do bloco CABECALHOS. */
function nomesDeCabecalho(): string[] {
  const corpo = FONTE_DO_WEBHOOK.match(/const CABECALHOS = \{([\s\S]*?)\} as const;/)?.[1];
  if (!corpo) throw new Error("bloco CABECALHOS não encontrado em call-webhook.ts");
  return [...corpo.matchAll(/^\s*\w+:\s*"([^"]+)"/gm)].map((m) => m[1] as string);
}

const DIRS_DE_CODIGO = ["app", "lib", "workers", "scripts", "hooks", "components"];
const IGNORADOS = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);

function varrer(dir: string, achados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (IGNORADOS.has(entrada.name)) continue;
      varrer(caminho, achados);
    } else if (/\.(ts|tsx)$/.test(entrada.name) && !/\.(test|spec)\./.test(entrada.name)) {
      achados.push(caminho);
    }
  }
  return achados;
}

function caminhosCom(padrao: RegExp): string[] {
  return DIRS_DE_CODIGO.flatMap((d) => varrer(join(RAIZ, d)))
    .filter((c) => padrao.test(readFileSync(c, "utf8")))
    .map((c) => c.slice(RAIZ.length + 1).replaceAll("\\", "/"));
}

/**
 * Os sites de fronteira que existem HOJE, um a um ligado à fronteira que
 * registra. Lista congelada de propósito: um `.upload(` novo sem entrada aqui
 * reprova o teste, e a correção é decidir o teto/forma da fronteira dele — não
 * somar uma linha em silêncio. É isto que faz a varredura ser de classe.
 */
const SITES: { arquivo: string; fronteira: string; papel?: "gerador" | "validador" }[] = [
  // Storage — a chave do objeto sai daqui e vira objeto lá.
  { arquivo: "workers/lgpd-export-worker.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "workers/media-persist-worker.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "lib/ai/skills/install.ts", fronteira: "storage.chave-de-objeto" },
  // Herança de arquivos do pacote no save textual (#2047): a chave é montada
  // com os MESMOS pedaços do install — org (uuid do JWT), name (vem da
  // skill_version já instalada, não do payload) e versionId (uuid do INSERT) —
  // e o sufixo é o path que o .zip passou pela validação de alfabeto do
  // package.ts. Nada de texto digitado pelo operador entra na chave.
  { arquivo: "lib/ai/skills/package-files.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/products/[id]/fotos/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/cron/contact-avatars/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/channels/partner/templates/media/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/settings/sons/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/marca/logo/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/conversations/[id]/media/route.ts", fronteira: "storage.chave-de-objeto" },
  // O anexo da nota interna (#1863, F3): MESMO molde de chave da rota irmã
  // (`{org}/{conversa}/note-{uuid}.{ext}`), bucket próprio `internal-media`.
  { arquivo: "app/api/v1/conversations/[id]/notes/media/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/ai/knowledge/sources/upload/route.ts", fronteira: "storage.chave-de-objeto" },
  { arquivo: "app/api/v1/ai/knowledge/sources/route.ts", fronteira: "storage.chave-de-objeto" },
  // O PDF da proposta comercial (#1832): `<org>/<proposta>.pdf`, dois uuids.
  { arquivo: "lib/propostas/storage.ts", fronteira: "storage.chave-de-objeto" },
  // Chave de idempotência: os geradores (manda UUID) e os validadores (exige UUID).
  { arquivo: "app/onboarding/connect-whatsapp/_client.tsx", fronteira: "api.idempotency-key", papel: "gerador" },
  { arquivo: "components/extensions/ExtensionsManager.tsx", fronteira: "api.idempotency-key", papel: "gerador" },
  { arquivo: "components/modulos/ModulosManager.tsx", fronteira: "api.idempotency-key", papel: "gerador" },
  { arquivo: "hooks/ai/useSkills.ts", fronteira: "api.idempotency-key", papel: "gerador" },
  { arquivo: "hooks/contacts/useImportContacts.ts", fronteira: "api.idempotency-key", papel: "gerador" },
  { arquivo: "lib/api/client.ts", fronteira: "api.idempotency-key", papel: "gerador" },
  { arquivo: "lib/api/idempotency.ts", fronteira: "api.idempotency-key", papel: "validador" },
  { arquivo: "lib/extensions/http.ts", fronteira: "api.idempotency-key", papel: "validador" },
  { arquivo: "app/api/v1/admin/tenants/route.ts", fronteira: "api.idempotency-key", papel: "validador" },
  { arquivo: "app/api/v1/channel-sessions/route.ts", fronteira: "api.idempotency-key", papel: "validador" },
  { arquivo: "app/api/v1/lgpd/requests/[id]/approve/route.ts", fronteira: "api.idempotency-key", papel: "validador" },
  { arquivo: "app/api/v1/onboarding/whatsapp/session/route.ts", fronteira: "api.idempotency-key", papel: "validador" },
];

describe("todo identificador que cruza fronteira cabe no que o terceiro aceita", () => {
  for (const f of FRONTEIRAS) {
    it(`${f.id} — ${f.terceiro}`, () => {
      const valores = f.medir();
      if (f.teto === null && f.forma === null) {
        // Lacuna pura: sem número nem forma do outro lado. O que se exige é que
        // ela esteja declarada e que haja o que medir quando o número chegar.
        expect(f.lacuna, `${f.id}: lacuna sem motivo escrito`).toBeTruthy();
        expect((f.lacuna ?? "").length, `${f.id}: motivo curto demais`).toBeGreaterThan(60);
        expect(f.fonte).toBeTruthy();
        return;
      }
      expect(valores.length, `${f.id}: nada medido`).toBeGreaterThan(0);
      for (const v of valores) {
        if (f.teto !== null) {
          expect(v.length, `${f.id}: ${JSON.stringify(v)} tem ${v.length}, teto ${f.teto}`).toBeLessThanOrEqual(f.teto);
        }
        if (f.forma) {
          expect(v, `${f.id}: ${JSON.stringify(v)} fora da forma que o terceiro aceita`).toMatch(f.forma as RegExp);
        }
      }
    });
  }

  it("o teto do WAHA é a MESMA constante que o código usa, e vale 54", () => {
    // O número mora no código (TETO_NOME_DE_SESSAO_WAHA); o teste o fixa aqui.
    // Mudar só de um lado reprova: comentário não é teto.
    expect(TETO_NOME_DE_SESSAO_WAHA).toBe(54);
    expect(nomeDaSessaoNovo(ORG, VERSAO)).toHaveLength(45);
    expect(nomeCurtoDaSessao(ORG)).toHaveLength(12);
  });

  it("o teste de banco e o teste de tela conferem a forma, pela mesma fonte", () => {
    // #686: o invariante media estabilidade; o e2e inseria `prego_` à mão e
    // passava ao lado do gerador. Os dois agora citam a validação.
    const invariante = readFileSync(join(RAIZ, "tests", "invariants", "pre-go-live-reservation.test.ts"), "utf8");
    expect(invariante).toContain("TETO_NOME_DE_SESSAO_WAHA");
    expect(invariante).toMatch(/waha_session_name\.length\)\.toBeLessThanOrEqual/);
    const e2e = readFileSync(join(RAIZ, "tests", "e2e", "pre-go-live-whatsapp.spec.ts"), "utf8");
    expect(e2e).toContain("nomeDaSessaoCabeNoWaha");
  });

  it("a forma do Storage vem da página do terceiro, não de um slug nosso", () => {
    const fonte = readFileSync(join(RAIZ, "lib", "ai", "skills", "package.ts"), "utf8");
    expect(fonte).toContain("https://supabase.com/docs/guides/storage/uploads/file-limits");
    // O alfabeto de lá tem espaço, ponto e acentuação NÃO — e isso é o que
    // distingue de um slug nosso (`[^a-z0-9-]`).
    expect(ALFABETO_DO_NOME_NO_STORAGE.test("minha skill v2")).toBe(true);
    expect(ALFABETO_DO_NOME_NO_STORAGE.test("skill/fora")).toBe(false);
    // O alfabeto é ASCII de propósito: `skill sem acento` passa, o mesmo texto
    // com ç/á não — e é exatamente isso que a recusa do #1346 faz na leitura.
    expect(ALFABETO_DO_NOME_NO_STORAGE.test("skill sem acento")).toBe(true);
    expect(ALFABETO_DO_NOME_NO_STORAGE.test("skill acentuada çã")).toBe(false);
  });

  it("a chave de idempotência que geramos é a forma que validamos", () => {
    expect(randomId()).toMatch(UUID_V4);
    const fonte = readFileSync(join(RAIZ, "lib", "extensions", "http.ts"), "utf8");
    expect(fonte).toContain("z.string().uuid()");
  });

  it("os cabeçalhos que saem no webhook de saída são token de HTTP", () => {
    const nomes = nomesDeCabecalho();
    expect(nomes.length).toBeGreaterThanOrEqual(5);
    expect(nomes.filter((n) => !TOKEN_DE_CABECALHO.test(n))).toEqual([]);
    // O id da entrega (X-Webhook-Delivery) é uuid v5 de um namespace fixo:
    // trocar o namespace muda o id de entrega de evento já entregue.
    expect(FONTE_DO_WEBHOOK).toMatch(/const entrega = idDaEntrega\(/);
    expect(FONTE_DO_WEBHOOK).toContain('const NAMESPACE_DA_ENTREGA = "ce410f0a-ca5e-4a06-89a0-bfe57222d74f"');
    expect("ce410f0a-ca5e-4a06-89a0-bfe57222d74f").toHaveLength(36);
  });

  it("não truncamos o identificador que o terceiro nos manda", () => {
    const sql = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    const colunas = [...sql.matchAll(/"external_id"\s+"([^"]+)"/g)].map((m) => m[1] as string);
    expect(colunas.length, "nenhuma coluna external_id no baseline?").toBeGreaterThanOrEqual(5);
    // `text` sem teto: se alguém puser varchar(n), o id do WAHA corta no meio
    // e o vínculo mensagem↔status quebra — aí sim seria teto NO LUGAR ERRADO.
    expect(colunas.filter((t) => t !== "text")).toEqual([]);
  });
});

describe("nenhum identificador sem destino declarado", () => {
  it("toda entrada tem teto+fonte OU lacuna+fonte — nunca as duas, nunca nenhuma", () => {
    for (const f of FRONTEIRAS) {
      const motivo = f.lacuna ?? "";
      expect(f.fonte, `${f.id}: sem fonte`).toBeTruthy();
      if (f.teto !== null) {
        expect(motivo, `${f.id}: tem teto e lacuna ao mesmo tempo`).toBe("");
        expect(typeof f.teto, `${f.id}: teto não é número`).toBe("number");
      } else {
        expect(motivo.length, `${f.id}: lacuna sem motivo`).toBeGreaterThan(60);
      }
    }
  });

  it("os quatro candidatos que a #686 nomeia estão registrados", () => {
    expect([...IDS]).toEqual(
      expect.arrayContaining([
        "waha.nome-da-sessao",
        "storage.chave-de-objeto",
        "api.idempotency-key",
        "mensagens.external_id",
        "webhook.cabecalhos-de-saida",
      ]),
    );
  });
});

describe("a varredura é de classe: site novo de fronteira reprova", () => {
  it("todo `.upload(` do código de produção está registrado, e na fronteira certa", () => {
    const achados = caminhosCom(/\.upload\(/);
    const registrados = SITES.filter((s) => s.fronteira === "storage.chave-de-objeto").map((s) => s.arquivo);
    expect(achados.sort()).toEqual([...registrados].sort());
  });

  it("todo ponto que manda ou lê a chave de idempotência está registrado", () => {
    // Só o cabeçalho como tal (`'Idempotency-Key'`/`"Idempotency-Key"`), não a
    // prosa dos comentários: o que cruza fronteira é o cabeçalho.
    const achados = caminhosCom(/['"]Idempotency-Key['"]/);
    const registrados = SITES.filter((s) => s.fronteira === "api.idempotency-key").map((s) => s.arquivo);
    expect(achados.sort()).toEqual([...registrados].sort());
  });

  it("quem gera a chave gera um UUID — literal não deduplica nada, apaga tudo", () => {
    const geradores = SITES.filter((s) => s.papel === "gerador");
    expect(geradores.length).toBeGreaterThanOrEqual(5);
    for (const { arquivo } of geradores) {
      const fonte = readFileSync(join(RAIZ, arquivo), "utf8");
      expect(fonte, `${arquivo}: gerador sem fonte de uuid`).toMatch(/random(Id|UUID)\(/);
      for (const [, expr] of fonte.matchAll(/['"]Idempotency-Key['"]:\s*([^,\n}]+)/g)) {
        const v = (expr as string).trim();
        const ehUuid = /random(Id|UUID)\(/.test(v);
        const ehVariavel = /^[A-Za-z_$][\w$.]*(\s*\?\?=.*)?$/.test(v);
        expect(ehUuid || ehVariavel, `${arquivo}: chave literal ou forma desconhecida → ${JSON.stringify(v)}`).toBe(
          true,
        );
      }
    }
  });

  it("todo site registrado aponta para uma fronteira que existe", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(15);
    expect(SITES.filter((s) => !IDS.has(s.fronteira))).toEqual([]);
  });
});

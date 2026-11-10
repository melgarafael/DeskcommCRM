// @vitest-environment node
/**
 * O PACOTE DO TITULAR, MEDIDO PONTA A PONTA — e a paridade entre o PDF e o
 * `data.json` que ele recebe (issue #2341).
 *
 * ─── O defeito que a issue descreve, e o que sobrou dele ────────────────────
 *
 * O PDF dizia "Informado na conversa (valor no arquivo de dados)" enquanto o
 * `data.json` subia para o Storage sem link no e-mail: o documento apontava
 * para um arquivo que quem o lê não tinha. Duas metades foram consertadas em
 * PRs separados — o PDF passou a imprimir o CPF mascarado (#2355) e o e-mail
 * passou a levar a ligação do arquivo (#2427, doc 103 A). O que faltava é o que
 * esta prova entrega: **ninguém media o pacote**.
 *
 * As provas que existiam mediam metades: `lgpd-texto-segue-o-pais` e
 * `art-15-entregue-no-pdf` chamam `sendExportEmail` com as duas URLs escritas à
 * mão — elas provam que o e-mail sabe desenhar um link que recebeu, não que o
 * worker o entrega; `lgpd-arquivo-do-titular-dourado` prova os bytes do arquivo
 * a partir de um payload construído no próprio teste; `lgpd-pdf-meet` prova o
 * texto do PDF sem arquivo nenhum ao lado. Nenhuma delas ficaria vermelha se o
 * worker trocasse as duas URLs, assinasse só o PDF, ou subisse um arquivo
 * diferente do que o link aponta — que é exatamente a família "a prova passa
 * sem provar".
 *
 * Aqui roda o `processLgpdExport` de VERDADE, com `renderLgpdPdf`,
 * `partesDoArquivoDoTitular` e `sendExportEmail` REAIS (só o banco, o Storage e
 * o transporte de e-mail são dublês). O que se mede:
 *
 *  1. os dois artefatos sobem, e o e-mail leva DUAS ligações distintas — cada
 *     uma para o caminho do seu artefato;
 *  2. o arquivo que a ligação aponta é o arquivo que subiu, e ele PARSEIA;
 *  3. **paridade**: tudo o que o PDF imprime do titular aparece no arquivo, com
 *     o mesmo texto — os dois lados da lista são conferidos contra os dois
 *     artefatos, então a lista não pode envelhecer calada;
 *  4. o CPF é a única assimetria, e é de propósito: o PDF imprime a máscara, o
 *     arquivo leva o valor bruto (é o arquivo que o titular recebe, não o
 *     contrário);
 *  5. controle: payload vazio continua gerando um `data.json` válido e o mesmo
 *     pacote — "vazio" não é "sem arquivo".
 *
 * ─── Por que Portugal entra ─────────────────────────────────────────────────
 *
 * O PDF de Portugal imprime a linha do art. 15.º, n.º 3 — "no ficheiro
 * data.json que acompanha este relatório". É a promessa EXPLÍCITA dentro do
 * documento; o caso mede que o e-mail que acompanha aquele PDF carrega a
 * ligação do arquivo. Sem isso, o n.º 3 volta a ser promessa solta.
 */
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type * as PerfilDoPais from "@/lib/legal/perfil-do-pais";
import type * as Saida from "@/lib/branding/saida";
import type { ExportPayload } from "@/lib/lgpd/export-collector";

const ORG = "11111111-1111-4111-8111-111111111111";
const PEDIDO = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const TITULAR = "ana@exemplo.invalid";
const BUCKET = "lgpd-exports";

/**
 * O que o worker resolve fora do banco: país da organização, marca de quem
 * processou e o piso de encarregado da instalação. O resto — PDF, arquivo,
 * e-mail — é o código de produção.
 */
const d = vi.hoisted(() => ({
  admin: { valor: null as unknown },
  collectExportData: vi.fn(),
  perfil: vi.fn(),
  marca: vi.fn(),
  instalacao: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => d.admin.valor }));
vi.mock("@/lib/lgpd/export-collector", () => ({ collectExportData: d.collectExportData }));
vi.mock("@/lib/lgpd/pades-signer", () => ({
  isPadesConfigured: () => false,
  signPdfPades: async (bytes: Buffer) => ({
    signed: bytes,
    sha256: "sha256-do-teste",
    signed_pades: false,
    warning: null,
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: d.instalacao }));
vi.mock("@/lib/branding/saida", async (importOriginal) => {
  const real = await importOriginal<typeof Saida>();
  return { ...real, marcaDaSaida: d.marca };
});
vi.mock("@/lib/legal/perfil-do-pais", async (importOriginal) => {
  const real = await importOriginal<typeof PerfilDoPais>();
  return { ...real, perfilDaOrganizacao: d.perfil };
});

/** O transporte de e-mail: é o que o titular recebe de fato. */
const enviados = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text: string }>);
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: async (msg: { to: string; subject: string; html: string; text: string }) => {
    enviados.push(msg);
    return { ok: true, id: "msg-do-teste" };
  },
}));

import { perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { processLgpdExport } from "@/workers/lgpd-export-worker";

// ---------------------------------------------------------------------------
// Banco e Storage falsos — o mínimo que o worker toca
// ---------------------------------------------------------------------------

type Pedido = Record<string, unknown>;

interface Subida {
  path: string;
  bytes: Buffer;
}

/**
 * `lgpd_requests` com a semântica dos filtros do PostgREST que o worker usa
 * (`eq`, `neq`, `or(...is.null / lt...)`); o UPDATE só toca as linhas que casam
 * todos eles — é a reivindicação que depende disso. O Storage guarda os BYTES
 * de cada subida (consumindo o `Readable`, que é como o worker entrega o
 * `data.json`) e assina cada caminho com uma URL que CARREGA o caminho: é
 * assim que o teste confere para onde cada ligação do e-mail aponta.
 */
function criarAdmin() {
  const pedidos: Pedido[] = [
    {
      id: PEDIDO,
      organization_id: ORG,
      request_type: "data_request",
      status: "received",
      attempts: 0,
      export_claimed_at: null,
      result: null,
      contact_id: "contato-1",
      external_customer_id: null,
      request_payload: { delivery: { method: "email", address: TITULAR } },
    },
  ];
  const efeitos = { subidas: [] as Subida[], assinaturas: [] as Array<{ path: string; expires: number }>, rpcs: [] as string[] };

  const avaliarTermo = (p: Pedido, termo: string): boolean => {
    const [col = "", op = "", ...resto] = termo.split(".");
    const valor = resto.join(".");
    if (op === "is" && valor === "null") return p[col] === null || p[col] === undefined;
    if (op === "lt") return p[col] != null && String(p[col]) < valor;
    throw new Error(`filtro não suportado no banco falso: ${termo}`);
  };

  type Pred = (p: Pedido) => boolean;

  class Cadeia {
    ops: Pred[] = [];
    patch: Pedido | null = null;

    eq(col: string, val: unknown) {
      this.ops.push((p) => p[col] === val);
      return this;
    }
    neq(col: string, val: unknown) {
      this.ops.push((p) => p[col] !== val);
      return this;
    }
    or(expr: string) {
      const termos = expr.split(",");
      this.ops.push((p) => termos.some((t) => avaliarTermo(p, t.trim())));
      return this;
    }
    select(_colunas: string) {
      return this;
    }
    private executar() {
      const casadas = pedidos.filter((p) => this.ops.every((f) => f(p)));
      if (this.patch) for (const p of casadas) Object.assign(p, this.patch);
      return casadas;
    }
    maybeSingle() {
      const [primeira] = this.executar();
      return Promise.resolve({ data: primeira ?? null, error: null });
    }
    then(onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      const casadas = this.executar().map((p) => ({ id: p.id }));
      return Promise.resolve({ data: casadas, error: null }).then(onF, onR);
    }
  }

  const admin = {
    from(tabela: string) {
      if (tabela !== "lgpd_requests") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: (_colunas: string) => new Cadeia(),
        update: (patch: Pedido) => {
          const c = new Cadeia();
          c.patch = patch;
          return c;
        },
      };
    },
    rpc: async (nome: string) => {
      efeitos.rpcs.push(nome);
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: unknown) => {
          const pedacos: Buffer[] = [];
          if (body && typeof (body as AsyncIterable<Buffer>)[Symbol.asyncIterator] === "function") {
            for await (const pedaco of body as AsyncIterable<Buffer>) pedacos.push(Buffer.from(pedaco));
          } else {
            pedacos.push(Buffer.from(body as Buffer));
          }
          efeitos.subidas.push({ path, bytes: Buffer.concat(pedacos) });
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path: string, expires: number) => {
          efeitos.assinaturas.push({ path, expires });
          return { data: { signedUrl: `https://storage.test/${bucket}/${path}?token=1` }, error: null };
        },
      }),
    },
  };

  return { admin, efeitos, pedido: () => pedidos[0]! };
}

/** O evento da aprovação — o único que exporta (doc 134). */
function evento(): EventRow {
  return {
    id: "evt-1",
    organization_id: ORG,
    event_type: "lgpd.data_request_received",
    entity_kind: "lgpd_request",
    entity_id: PEDIDO,
    payload: {
      request_id: PEDIDO,
      manually_approved: true,
      approved_by: ADMIN,
      approved_reason: "conferido com o titular",
    },
    metadata: { manually_approved: true },
    consumed_by: [],
    attempts: 0,
  };
}

// ---------------------------------------------------------------------------
// Corpus: o titular com dado em toda seção que o PDF imprime
// ---------------------------------------------------------------------------

/**
 * As strings que o PDF imprime sobre o titular. Cada uma é conferida nos DOIS
 * artefatos: se o PDF parar de imprimir, a primeira asserção cai e a lista é
 * corrigida; se o arquivo parar de levar, a segunda cai. É o par que faz a
 * "paridade" significar alguma coisa — uma lista que só olhasse o arquivo
 * passaria com um PDF que fala de outra pessoa.
 */
const PARIDADE = [
  "Ana Souza", // contact.name
  TITULAR, // contact.email
  "+55 11 98888-7777", // contact.phone_number
  "Campinas", // campo personalizado, impresso em "Respostas e campos personalizados"
  "Quero remarcar a consulta de terça", // messages_recent[0].body
  "whatsapp", // conversations[0].channel
  "NV-4411", // orders[0].external_id
  "Revisão do plano", // proposals[0].titulo
  "Trocar para manhã", // appointments[0].notes
  "marketing", // consents[0].scope
  "Ação do suporte", // leads[0].title
];

function payloadRico(): ExportPayload {
  return {
    request_id: PEDIDO,
    organization_id: ORG,
    organization_legal_name: "Clínica Bem Viver LTDA",
    organization_display_name: "Bem Viver",
    dpo_email: "dpo@bv.test",
    lei_citada: "LGPD Art. 18, II (Lei nº 13.709/2018)",
    documento_rotulo: "CPF",
    generated_at: "2030-01-02T13:05:00.000Z",
    fuso: "America/Sao_Paulo",
    no_local_footprint: false,
    secoes_no_limite: [],
    contact: {
      id: "contato-1",
      organization_id: ORG,
      name: "Ana Souza",
      email: TITULAR,
      phone_number: "+55 11 98888-7777",
      cpf_present: false,
      cpf_informado_na_conversa: true,
      custom_fields: { cpf: "123.456.789-01" },
      campos_legiveis: [{ rotulo: "Cidade", valor: "Campinas" }],
      source: "whatsapp",
      created_at: "2029-12-01T10:00:00.000Z",
      is_anonymized: false,
    },
    consents: [{ scope: "marketing", granted: true, granted_at: "2029-12-01T10:00:00.000Z" }],
    conversations: [
      {
        id: "conversa-1",
        channel: "whatsapp",
        status: "open",
        created_at: "2029-12-01T10:00:00.000Z",
        last_message_at: "2030-01-02T12:00:00.000Z",
      },
    ],
    messages_count_total: 7,
    messages_recent: [
      {
        id: "mensagem-1",
        conversation_id: "conversa-1",
        direction: "inbound",
        type: "text",
        status: "delivered",
        body: "Quero remarcar a consulta de terça",
        has_media: false,
        media_derived_text: null,
        created_at: "2030-01-02T12:00:00.000Z",
      },
    ],
    messages_completas: [
      {
        id: "mensagem-1",
        conversation_id: "conversa-1",
        direction: "inbound",
        type: "text",
        status: "delivered",
        body: "Quero remarcar a consulta de terça",
        created_at: "2030-01-02T12:00:00.000Z",
      },
    ],
    leads: [
      {
        id: "lead-1",
        title: "Ação do suporte",
        status: "open",
        value_cents: 150000,
        currency: "BRL",
        created_at: "2029-12-02T10:00:00.000Z",
      },
    ],
    lead_field_proposals: [],
    honorarios_contratos: [],
    honorarios_parcelas: [],
    orders: [
      {
        id: "pedido-1",
        external_provider: "nuvemshop",
        external_id: "NV-4411",
        status: "paid",
        total_cents: 24990,
        currency: "BRL",
        ordered_at: "2029-12-03T10:00:00.000Z",
      },
    ],
    activities: [],
    appointments: [
      {
        id: "compromisso-1",
        notes: "Trocar para manhã",
        starts_at: "2030-01-05T13:00:00.000Z",
        status: "confirmed",
        created_at: "2030-01-02T11:00:00.000Z",
      },
    ],
    sales: [],
    proposals: [
      {
        id: "proposta-1",
        numero: 12,
        ano: 2030,
        titulo: "Revisão do plano",
        status: "enviada",
        total_cents: 99000,
        moeda: "BRL",
        created_at: "2030-01-01T10:00:00.000Z",
        sent_at: null,
        tem_pdf: false,
      },
    ],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    reply_drafts: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    prospecting_candidates: [],
    cases: [],
    case_events: [],
    case_chat_messages: [],
    checkpoints: [],
    passagens: [],
    avisos_de_caso: [],
    demandas: [],
    campaign_recipients: [],
    campaign_suppressions: [],
    channel_session_groups: [],
    group_messages_authored: [],
    conversation_drafts: [],
    conversation_notes: [],
    contact_field_proposals: [],
    lead_attachments: [],
    lead_notes: [],
    ai_agent_runs: [],
    lead_state: [],
  } as unknown as ExportPayload;
}

/** O payload do "nada a declarar": todas as seções vazias, sem contato. */
function payloadVazio(): ExportPayload {
  const base = payloadRico() as unknown as Record<string, unknown>;
  const vazio: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(base)) {
    vazio[chave] = Array.isArray(valor) ? [] : valor;
  }
  vazio.contact = null;
  vazio.no_local_footprint = true;
  vazio.messages_count_total = 0;
  return vazio as unknown as ExportPayload;
}

/** Portugal: o bloco do art. 15.º é o que o PDF imprime e o arquivo leva. */
function payloadDePortugal(): ExportPayload {
  const base = payloadRico() as unknown as ExportPayload;
  return {
    ...base,
    lei_citada: "RGPD (Regulamento (UE) 2016/679)",
    documento_rotulo: "NIF",
    fuso: "Europe/Lisbon",
    art15: {
      finalidades: "Atendimento ao cliente e gestão de marcações.",
      destinatarios: "Prestadores de alojamento e de e-mail, dentro da UE.",
      prazo_conservacao: "5 anos depois do último contacto.",
      autoridade: { nome: "CNPD", site: "https://www.cnpd.pt" },
      decisoes_automatizadas: "A IA responde sozinha às mensagens recebidas.",
    },
  } as unknown as ExportPayload;
}

// ---------------------------------------------------------------------------
// O PDF como o titular o lê
// ---------------------------------------------------------------------------

async function textoDoPdf(bytes: Buffer): Promise<string> {
  const fontes =
    join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + sep;
  const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fontes }).promise;
  const paginas: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const conteudo = await (await doc.getPage(n)).getTextContent();
    paginas.push(conteudo.items.map((i) => ("str" in i ? i.str : "")).join(" "));
  }
  return paginas.join("\n").replace(/\s+/g, " ");
}

let banco: ReturnType<typeof criarAdmin>;

beforeEach(() => {
  vi.clearAllMocks();
  enviados.length = 0;
  banco = criarAdmin();
  d.admin.valor = banco.admin;
  d.collectExportData.mockImplementation(async () => payloadRico());
  d.perfil.mockImplementation(async () => perfilDoPais("BR"));
  d.marca.mockImplementation(async () => ({
    nome: "Bem Viver",
    logoUrl: null,
    accent: "#0a7ea4",
    accentFg: "#ffffff",
    origens: { nome: "org", cor: "org" },
  }));
  d.instalacao.mockImplementation(async () => ({ valor: null }));
});

// ---------------------------------------------------------------------------
// Os casos
// ---------------------------------------------------------------------------

describe("o pacote do titular leva o data.json que o PDF resume (#2341)", () => {
  it("⭐ o e-mail do titular leva DUAS ligações distintas, cada uma para o seu artefato", async () => {
    const result = await processLgpdExport(evento());

    expect(result.status, `o worker não concluiu: ${result.detail ?? ""}`).toBe("ok");
    expect(banco.pedido().status).toBe("completed");

    const caminhos = banco.efeitos.subidas.map((s) => s.path).sort();
    expect(caminhos).toEqual([`${ORG}/${PEDIDO}/data.json`, `${ORG}/${PEDIDO}/report.pdf`]);

    // As DUAS assinaturas, no MESMO prazo: o arquivo não pode vencer antes do
    // relatório a que acompanha.
    const assinaturas = banco.efeitos.assinaturas;
    expect(assinaturas.map((a) => a.path).sort()).toEqual(caminhos);
    expect(new Set(assinaturas.map((a) => a.expires)).size, "prazos diferentes nos dois links").toBe(1);

    expect(enviados).toHaveLength(1);
    const [email] = enviados;
    expect(email!.to).toBe(TITULAR);
    const urlPdf = `https://storage.test/${BUCKET}/${ORG}/${PEDIDO}/report.pdf?token=1`;
    const urlDados = `https://storage.test/${BUCKET}/${ORG}/${PEDIDO}/data.json?token=1`;
    expect(email!.text).toContain(urlPdf);
    expect(email!.text, "o titular recebe o PDF e não recebe o arquivo").toContain(urlDados);
    expect(email!.html).toContain(urlDados);
    // O que fica registrado no pedido é o caminho do arquivo que a ligação
    // aponta — não um caminho vizinho.
    const resultado = banco.pedido().result as Record<string, unknown>;
    expect(resultado.json_path).toBe(`${ORG}/${PEDIDO}/data.json`);
    expect(resultado.pdf_path).toBe(`${ORG}/${PEDIDO}/report.pdf`);
  });

  it("⭐ o arquivo que a ligação aponta é o que subiu, e ele parseia", async () => {
    await processLgpdExport(evento());

    const subida = banco.efeitos.subidas.find((s) => s.path.endsWith("/data.json"));
    expect(subida, "nada subiu como data.json").toBeDefined();
    const arquivo = JSON.parse(subida!.bytes.toString("utf-8")) as Record<string, unknown>;
    expect(arquivo.request_id).toBe(PEDIDO);
    expect(arquivo.organization_id).toBe(ORG);
    expect(arquivo.messages_count_total).toBe(7);
    expect((arquivo.contact as Record<string, unknown>).name).toBe("Ana Souza");
    // O valor BRUTO do CPF vive só aqui: é a cópia do titular, não o resumo.
    expect(JSON.stringify(arquivo)).toContain("123.456.789-01");
  });

  it("⭐ paridade: o que o PDF imprime do titular está no arquivo, com o mesmo texto", async () => {
    await processLgpdExport(evento());

    const pdfBytes = banco.efeitos.subidas.find((s) => s.path.endsWith("/report.pdf"))!.bytes;
    const texto = await textoDoPdf(pdfBytes);
    const arquivo = banco.efeitos.subidas.find((s) => s.path.endsWith("/data.json"))!.bytes.toString("utf-8");

    for (const valor of PARIDADE) {
      expect(texto, `o PDF deixou de imprimir "${valor}" — a lista desta prova envelheceu`).toContain(valor);
      expect(arquivo, `o PDF imprime "${valor}" e o arquivo que o titular recebe não tem`).toContain(valor);
    }

    // O CPF é a assimetria declarada: máscara no PDF, bruto no arquivo
    // (issue #2341, saída B). Se um dia o PDF voltar a imprimir o bruto, isto
    // cai — é o guarda da decisão.
    expect(texto).toContain("***.***.*89-01");
    expect(texto, "o PDF voltou a imprimir o CPF inteiro").not.toContain("123.456.789-01");
    // E o ponteiro para o arquivo não voltou: o valor sai no documento.
    expect(texto).not.toContain("valor no arquivo de dados");
  });

  it("Portugal: o PDF promete o art. 15.º, n.º 3 e o e-mail entrega a ligação", async () => {
    d.collectExportData.mockImplementation(async () => payloadDePortugal());
    d.perfil.mockImplementation(async () => perfilDoPais("PT"));

    const result = await processLgpdExport(evento());
    expect(result.status).toBe("ok");

    const pdfBytes = banco.efeitos.subidas.find((s) => s.path.endsWith("/report.pdf"))!.bytes;
    const texto = await textoDoPdf(pdfBytes);
    expect(
      texto,
      "o relatório deixou de citar a cópia do art. 15.º, n.º 3 — ou o texto mudou de país",
    ).toContain("no ficheiro data.json que acompanha este relatório");

    const [email] = enviados;
    expect(email!.text, "o PDF promete a cópia e o e-mail não leva a ligação").toContain(
      `https://storage.test/${BUCKET}/${ORG}/${PEDIDO}/data.json?token=1`,
    );
    // pt-PT, sem LGPD: o mesmo pacote de um titular português.
    expect(email!.text).toContain("A cópia dos seus dados pessoais (data.json) está em:");
    expect(email!.text).not.toContain("LGPD");
  });

  it("controle: payload VAZIO continua gerando um data.json válido, no mesmo pacote", async () => {
    d.collectExportData.mockImplementation(async () => payloadVazio());

    const result = await processLgpdExport(evento());
    expect(result.status).toBe("ok");

    const subida = banco.efeitos.subidas.find((s) => s.path.endsWith("/data.json"));
    expect(subida, "sem dado, o arquivo deixou de existir — 'vazio' virou 'sem cópia'").toBeDefined();
    const arquivo = JSON.parse(subida!.bytes.toString("utf-8")) as Record<string, unknown>;
    expect(arquivo.contact).toBeNull();
    expect(arquivo.messages_recent).toEqual([]);
    // O envelope continua inteiro: o arquivo vazio não é um arquivo truncado.
    for (const chave of ["request_id", "organization_id", "generated_at", "contact", "messages_recent", "consents"]) {
      expect(arquivo, `o envelope perdeu "${chave}" no caminho vazio`).toHaveProperty([chave]);
    }

    const [email] = enviados;
    expect(email!.text).toContain(`https://storage.test/${BUCKET}/${ORG}/${PEDIDO}/data.json?token=1`);

    const pdfBytes = banco.efeitos.subidas.find((s) => s.path.endsWith("/report.pdf"))!.bytes;
    const texto = await textoDoPdf(pdfBytes);
    expect(texto).toContain("Nenhum consentimento registrado");
  });
});

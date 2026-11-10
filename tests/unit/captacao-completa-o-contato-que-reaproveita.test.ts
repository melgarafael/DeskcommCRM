// @vitest-environment node
//
// A CAPTAÇÃO COMPLETA O CONTATO QUE REAPROVEITA (#3719) ──────────────────────
//
// Dois defeitos, uma raiz: o bloco de contato da rota só existia DENTRO de
// `if (mapped.phone)`, e só sabia preencher contato na hora de CRIÁ-LO.
//
//   1. formulário que coleta nome e e-mail (isca, newsletter, e-book) criava o
//      card com `contact_id = null` — a pessoa não virava contato;
//   2. quando o telefone chegava DEPOIS, no segundo envio da mesma pessoa com o
//      MESMO e-mail, o vencedor vinha pelo índice de e-mail e o telefone do
//      envio era DESCARTADO: o card novo caía num contato sem número e tudo o
//      que depende de WhatsApp parava para esse lead.
//
// ─── Como o teste mede ───────────────────────────────────────────────────────
//
// Entra pela ROTA de verdade (`app/api/v1/webhooks/in/[token]/route.ts`), e o
// Supabase é um dublê que guarda os contatos em memória e APLICA os dois índices
// únicos parciais de `supabase/baseline.sql` (`uniq_contacts_org_phone` e
// `uniq_contacts_org_email`, ambos ativos só onde `is_merged_into is null`). É o
// que permite medir o terceiro caso — telefone duplicado — pelo desfecho do
// banco, e não por um `if` do teste.
//
// O que este arquivo NÃO mede, declarado:
//   - a regra de qual GRAFIA do telefone vence (`escolherContatoCanonico`): o
//     dublê de `encontrarContatoPorTelefoneComNome` compara o número exato. Essa
//     regra tem teste próprio (`qual-grafia-do-telefone-vence.test.ts`);
//   - o SQL do `emit_event` e do trigger do `contact.phone_added`: a RPC é
//     dublê. O que se mede é o que a rota MANDA (tipo, entidade e payload);
//   - a concorrência de verdade: o escritor concorrente do caso 3b entra num
//     gancho entre a leitura e a gravação, que é exatamente a janela em que ele
//     pode entrar.
//
// Sabotagem medida: com a rota de `origin/main` (o bloco de contato inteiro
// dentro de `if (mapped.phone)`), 7 dos 9 casos ficam VERMELHOS. Os dois verdes
// são os CONTROLES — contato que já tem número não muda, e contato novo nasce
// com telefone e e-mail —, que é justamente o que o conserto não devia tocar.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "token-da-fonte-0001";
const EMAIL = "maria.teste@example.com";
const TELEFONE = "+5511988887777";
const OUTRO_TELEFONE = "+5511900001111";

type Linha = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** `contacts` de mentira — a tabela que este teste mede. */
  contatos: [] as Array<Record<string, unknown>>,
  /** Toda RPC, com os argumentos: é como o evento emitido é lido de fora. */
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** O que a rota pediu para criar no funil. */
  leads: [] as Array<Record<string, unknown>>,
  /** O que foi escrito no log — o desfecho que NÃO pode ser engolido. */
  logados: [] as Array<{ msg: string; ctx?: Record<string, unknown> }>,
  /**
   * Escritor concorrente: roda ENTRE a leitura e a gravação do contato. É a
   * janela em que outro POST pode tomar o telefone, e o único jeito honesto de
   * exercitar o `23505` da gravação sem depender de dois processos.
   */
  aoGravar: null as null | ((valores: Record<string, unknown>) => void),
}));

const FONTE = {
  id: "fonte-1",
  name: "Formulário do site",
  organization_id: ORG,
  secret_encrypted: null,
  default_pipeline_id: FUNIL,
  default_stage_id: ETAPA,
  field_map: {},
  form_fields: [],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  update_existing_lead_on_capture: false,
  reuse_open_lead_on_capture: false,
};

/** `email_normalized` é coluna GERADA (`lower(trim(email))`) no banco. */
function normalizado(email: unknown): string | null {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

/** Os dois índices únicos parciais de `contacts`, na mesma régua do banco. */
function conflito(linha: Linha): { code: string; message: string } | null {
  for (const outra of h.contatos) {
    if (outra.id === linha.id) continue;
    if (outra.is_merged_into) continue;
    if (outra.organization_id !== linha.organization_id) continue;
    if (linha.phone_number && outra.phone_number === linha.phone_number) {
      return {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uniq_contacts_org_phone"',
      };
    }
    if (normalizado(linha.email) && normalizado(outra.email) === normalizado(linha.email)) {
      return {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uniq_contacts_org_email"',
      };
    }
  }
  return null;
}

/** Uma resposta por tabela, no formato do PostgREST. */
function resposta(
  tabela: string,
  tipo: "select" | "insert" | "update",
  valores: Linha,
  filtros: Array<(l: Linha) => boolean>,
  unico: boolean,
) {
  if (tabela === "webhook_sources") return { data: FONTE, error: null };
  if (tabela !== "contacts") return { data: unico ? null : [], error: null };

  if (tipo === "select") {
    const linhas = h.contatos.filter((l) => filtros.every((f) => f(l)));
    return { data: unico ? (linhas[0] ?? null) : linhas, error: null };
  }

  if (tipo === "insert") {
    const linha: Linha = {
      id: `contato-${h.contatos.length + 1}`,
      organization_id: null,
      name: null,
      email: null,
      phone_number: null,
      is_merged_into: null,
      is_personal: false,
      is_anonymized: false,
      ...valores,
    };
    linha.email_normalized = normalizado(linha.email);
    const erro = conflito(linha);
    if (erro) return { data: null, error: erro };
    h.contatos.push(linha);
    return { data: { id: linha.id }, error: null };
  }

  // UPDATE: a guarda `is(coluna, null)` do WHERE é o que impede trocar valor
  // existente — se nenhuma linha casa, o PostgREST devolve `null` e a rota não
  // emite evento nenhum.
  if (h.aoGravar) {
    const concorrente = h.aoGravar;
    h.aoGravar = null;
    concorrente(valores);
  }
  const alvo = h.contatos.filter((l) => filtros.every((f) => f(l)));
  const anterior = alvo[0];
  if (!anterior) return { data: null, error: null };
  const candidata: Linha = {
    ...anterior,
    ...valores,
    email_normalized: normalizado(valores.email ?? anterior.email),
  };
  const erro = conflito(candidata);
  if (erro) return { data: null, error: erro };
  Object.assign(anterior, candidata);
  return { data: { id: anterior.id }, error: null };
}

/**
 * A cadeia do PostgREST: todo método devolve a MESMA cadeia e o valor sai no
 * `await` (ou no `maybeSingle`), como no cliente de verdade.
 */
function tabela(nome: string): unknown {
  const filtros: Array<(l: Linha) => boolean> = [];
  let tipo: "select" | "insert" | "update" = "select";
  let valores: Linha = {};

  const api: Record<string, unknown> = {};
  const mesmo = () => api;
  api.select = mesmo;
  api.order = mesmo;
  api.limit = mesmo;
  api.insert = (v: Linha) => {
    tipo = "insert";
    valores = v;
    return api;
  };
  api.update = (v: Linha) => {
    tipo = "update";
    valores = v;
    return api;
  };
  api.eq = (col: string, val: unknown) => {
    filtros.push((l) => l[col] === val);
    return api;
  };
  api.neq = (col: string, val: unknown) => {
    filtros.push((l) => l[col] !== val);
    return api;
  };
  api.is = (col: string, val: unknown) => {
    filtros.push((l) => (l[col] ?? null) === val);
    return api;
  };
  api.in = (col: string, vals: unknown[]) => {
    filtros.push((l) => vals.includes(l[col]));
    return api;
  };
  api.maybeSingle = async () => resposta(nome, tipo, valores, filtros, true);
  api.single = api.maybeSingle;
  api.then = (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
    Promise.resolve(resposta(nome, tipo, valores, filtros, false)).then(ok, falha);

  return api;
}

/** Cria um contato já existente na base (tela, importação, envio anterior). */
function contato(dados: Linha): Linha {
  const linha: Linha = {
    id: `contato-${h.contatos.length + 1}`,
    organization_id: ORG,
    name: null,
    email: null,
    email_normalized: null,
    phone_number: null,
    is_merged_into: null,
    is_personal: false,
    is_anonymized: false,
    source: "tela",
    ...dados,
  };
  linha.email_normalized = normalizado(linha.email);
  h.contatos.push(linha);
  return linha;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpc.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: (msg: string, ctx?: Record<string, unknown>) => {
      h.logados.push({ msg, ctx });
    },
  },
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));

// A busca por telefone é dublê da BASE deste teste (número exato): a regra de
// qual grafia vence tem arquivo próprio, e aqui ela só atrapalharia a leitura.
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: async (_admin: unknown, org: string, phone: string) => {
    const achado = h.contatos.find(
      (l) => l.organization_id === org && l.phone_number === phone && !l.is_merged_into,
    );
    return achado ? { id: achado.id, phone_number: achado.phone_number, name: achado.name } : null;
  },
}));

vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: vi.fn(async () => undefined),
}));

// O funil não é o assunto deste arquivo: o handler é dublê e guarda o que a
// rota pediu para criar — é de onde sai o `contact_id` do card.
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: async (_sb: unknown, _ctx: unknown, input: Record<string, unknown>) => {
    h.leads.push(input);
    return { id: "lead-1", ...input };
  },
  updateLeadHandler: vi.fn(async () => ({ id: "lead-1" })),
  moveLeadHandler: vi.fn(async () => ({ id: "lead-1" })),
}));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

/** O POST cru na rota, como a ferramenta de fora faz. */
function enviar(corpo: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

const eventosDeTelefone = () =>
  h.rpc.filter((c) => c.fn === "emit_event" && c.args.p_event_type === "contact.phone_added");

const erroDeGravacaoLogado = () =>
  h.logados.filter((l) => l.ctx?.errorCode === "23505" && l.ctx?.column !== undefined);

beforeEach(() => {
  h.contatos.length = 0;
  h.rpc.length = 0;
  h.leads.length = 0;
  h.logados.length = 0;
  h.aoGravar = null;
});

describe("envio só com nome e e-mail", () => {
  it("⭐ cria o contato e liga o card a ele — o card NÃO nasce sem contato", async () => {
    // Sem o conserto, `contact_id` é `undefined` (o bloco inteiro de contato
    // estava dentro de `if (mapped.phone)`) e a pessoa não aparece em Contatos.
    const r = await enviar({ nome: "Maria Teste", email: EMAIL });

    expect(r.status).toBe(200);
    expect(h.contatos, "nenhum contato foi criado").toHaveLength(1);
    expect(h.contatos[0]).toMatchObject({
      name: "Maria Teste",
      email: EMAIL,
      phone_number: null,
      source: "webhook",
    });
    expect(h.leads, "o card não foi criado").toHaveLength(1);
    expect(h.leads[0]!.contact_id, "o card nasceu sem contato").toBe(h.contatos[0]!.id);
    expect(eventosDeTelefone(), "sem telefone não há transição a anunciar").toHaveLength(0);
  });

  it("o segundo envio com o mesmo e-mail (caixa e espaço diferentes) reusa o contato", async () => {
    await enviar({ nome: "Maria Teste", email: EMAIL });
    const r = await enviar({ nome: "Maria Teste", email: "  MARIA.TESTE@Example.com " });

    expect(r.status).toBe(200);
    expect(h.contatos, "o e-mail normalizado não segurou a duplicata").toHaveLength(1);
    expect(h.leads.map((l) => l.contact_id)).toEqual([h.contatos[0]!.id, h.contatos[0]!.id]);
  });

  it("sem nome, e-mail é o título do card — e o nome do contato também", async () => {
    const r = await enviar({ email: EMAIL });

    expect(r.status).toBe(200);
    expect(h.contatos[0]!.name).toBe(EMAIL);
    expect(h.leads[0]!.title).toBe(EMAIL);
  });
});

describe("o telefone que chega DEPOIS, com o mesmo e-mail", () => {
  it("⭐ completa o contato achado pelo e-mail e anuncia `contact.phone_added` uma vez", async () => {
    // Era AQUI o defeito mais caro: o INSERT colidia em `uniq_contacts_org_email`,
    // o vencedor era achado pelo e-mail e o telefone do envio era descartado.
    const daTela = contato({ name: "Maria Teste", email: EMAIL });

    const r = await enviar({ nome: "Maria Teste", email: EMAIL, telefone: "+55 11 98888-7777" });

    expect(r.status).toBe(200);
    expect(
      h.contatos,
      "o envio criou um segundo contato em vez de completar o existente",
    ).toHaveLength(1);
    expect(h.contatos[0]!.id).toBe(daTela.id);
    expect(h.contatos[0]!.phone_number, "o telefone do envio foi descartado").toBe(TELEFONE);
    expect(h.leads[0]!.contact_id).toBe(daTela.id);

    const eventos = eventosDeTelefone();
    expect(eventos, `a transição saiu ${eventos.length} vez(es) em vez de uma`).toHaveLength(1);
    expect(eventos[0]!.args).toMatchObject({
      p_entity_kind: "contact",
      p_entity_id: daTela.id,
      p_payload: { phone_number: TELEFONE },
      p_organization_id: ORG,
    });
  });

  it("contato que já TEM número nunca é sobrescrito, e nenhum evento sai", async () => {
    const comNumero = contato({ name: "Maria Teste", email: EMAIL, phone_number: OUTRO_TELEFONE });

    const r = await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(r.status).toBe(200);
    expect(comNumero.phone_number, "trocou o número que a tela já tinha").toBe(OUTRO_TELEFONE);
    expect(h.leads[0]!.contact_id).toBe(comNumero.id);
    expect(eventosDeTelefone(), "não houve transição: o contato já tinha número").toHaveLength(0);
  });

  it("telefone inédito + e-mail de ninguém: contato novo nasce com os dois", async () => {
    const r = await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(r.status).toBe(200);
    expect(h.contatos).toHaveLength(1);
    expect(h.contatos[0]).toMatchObject({ email: EMAIL, phone_number: TELEFONE });
    expect(eventosDeTelefone(), "o contato NASCEU com número: não é transição").toHaveLength(0);
  });
});

describe("telefone que já é de outro contato da organização", () => {
  it("⭐ não sobrescreve ninguém, não emite evento e a captação NÃO morre", async () => {
    // Dois contatos com históricos diferentes, e o envio traz o número de um
    // deles com o e-mail do outro. O telefone é o identificador principal —
    // então ele manda no VÍNCULO do card, e o contato do e-mail fica intacto.
    const doEmail = contato({ name: "Maria Teste", email: EMAIL });
    const doWhats = contato({ name: "Maria (WhatsApp)", phone_number: TELEFONE });

    const r = await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(r.status, "a captação foi derrubada por uma disputa de identidade").toBe(200);
    expect(h.contatos).toHaveLength(2);
    expect(doEmail.phone_number, "o número do outro contato foi copiado").toBeNull();
    expect(doWhats.email, "o e-mail do outro contato foi copiado").toBeNull();
    expect(h.leads[0]!.contact_id, "o card deveria seguir o dono do telefone").toBe(doWhats.id);
    expect(eventosDeTelefone()).toHaveLength(0);
    // O `23505` NÃO é engolido: o preenchimento recusado fica no log com o código.
    const logado = erroDeGravacaoLogado();
    expect(logado.length, "o 23505 da gravação saiu em silêncio").toBeGreaterThan(0);
    expect(String(logado[0]!.ctx?.errorMessage)).toContain("uniq_contacts_org_email");
  });

  it("⭐ corrida: o número é tomado entre a leitura e a gravação — 23505 tratado, captação segue", async () => {
    // A janela real em que o `UPDATE` pode colidir: outro POST gravou o mesmo
    // número depois de a rota ter lido "telefone livre".
    const doEmail = contato({ name: "Maria Teste", email: EMAIL });
    h.aoGravar = (valores) => {
      if (valores.phone_number === TELEFONE)
        contato({ name: "Outra pessoa", phone_number: TELEFONE });
    };

    const r = await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(r.status, "a captação morreu na disputa pelo telefone").toBe(200);
    expect(h.contatos[0]!.phone_number, "o número foi gravado por cima do concorrente").toBeNull();
    expect(h.leads[0]!.contact_id, "o card perdeu o contato por causa da corrida").toBe(doEmail.id);
    expect(eventosDeTelefone(), "anunciou um telefone que NÃO foi gravado").toHaveLength(0);
    const logado = erroDeGravacaoLogado();
    expect(logado.length, "o 23505 da gravação saiu em silêncio").toBeGreaterThan(0);
    expect(String(logado[0]!.ctx?.errorMessage)).toContain("uniq_contacts_org_phone");
    // O evento de capturação não é derrubado: o lead entrou no funil.
    expect(h.leads).toHaveLength(1);
  });
});

describe("o e-mail que chega depois, com o mesmo telefone", () => {
  it("completa o contato achado pelo telefone quando ele não tem e-mail", async () => {
    const doWhats = contato({ name: "Maria Teste", phone_number: TELEFONE });

    const r = await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(r.status).toBe(200);
    expect(h.contatos).toHaveLength(1);
    expect(h.contatos[0]!.id).toBe(doWhats.id);
    expect(h.contatos[0]!.email).toBe(EMAIL);
    expect(h.leads[0]!.contact_id).toBe(doWhats.id);
  });
});

// Contato marcado como pessoal está FORA da operação: o card dele é recusado
// adiante (`createLeadHandler`), e a captação não pode alterar a ficha antes
// disso. Anonimizado é titular de LGPD: formulário nenhum volta a preenchê-lo.
// Sabotagem medida: sem `.eq("is_personal", false)` / `.eq("is_anonymized",
// false)` no `completarDoEnvio`, os três casos abaixo ficam VERMELHOS.
describe("contato fora da operação não é completado", () => {
  it("contato PESSOAL achado pelo e-mail não ganha o telefone, e nenhum evento sai", async () => {
    const pessoal = contato({ name: "Maria Teste", email: EMAIL, is_personal: true });

    await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(pessoal.phone_number, "a captação alterou um contato pessoal").toBeNull();
    expect(eventosDeTelefone()).toHaveLength(0);
  });

  it("contato PESSOAL achado pelo telefone não ganha o e-mail", async () => {
    const pessoal = contato({ name: "Maria Teste", phone_number: TELEFONE, is_personal: true });

    await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(pessoal.email, "a captação alterou um contato pessoal").toBeNull();
  });

  it("contato ANONIMIZADO não volta a ser preenchido por formulário", async () => {
    const titular = contato({
      name: "Cliente Anonimizado #1",
      phone_number: TELEFONE,
      is_anonymized: true,
    });

    await enviar({ nome: "Maria Teste", email: EMAIL, telefone: TELEFONE });

    expect(titular.email, "a captação preencheu a ficha de um titular anonimizado").toBeNull();
  });
});

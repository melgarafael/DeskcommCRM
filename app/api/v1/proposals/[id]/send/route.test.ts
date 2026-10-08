import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MODELOS_BASE } from "@/lib/propostas/modelos/catalogo-base";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocks: Record<string, any> = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  createAdminClient: vi.fn(),
  adiarAteAJanelaAbrir: vi.fn(),
  checkDailyLimit: vi.fn(),
  espacarEnvio: vi.fn(),
  alocarNumero: vi.fn(),
  decidirVersao: vi.fn(),
  renderDocumentoPdf: vi.fn(),
  salvarPdfDaProposta: vi.fn(),
  marcaDaSaida: vi.fn(),
  marcaDaOrganizacaoParaPdf: vi.fn(),
  emitLeadActivity: vi.fn(),
  sendMessageHandler: vi.fn(),
  agendaRetornoNoCrm: vi.fn(),
  buscarPadroesDaOrganizacao: vi.fn(),
  resolverModelo: vi.fn(),
  resolverAvisoDeRevisaoSeProntaOuEncerrada: vi.fn(),
  audit: vi.fn(),
  traduzir: vi.fn((txt: string) => txt),
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: mocks.adiarAteAJanelaAbrir }));
vi.mock("@/lib/automation/throttle", () => ({ checkDailyLimit: mocks.checkDailyLimit, espacarEnvio: mocks.espacarEnvio }));
vi.mock("@/lib/propostas/numeracao", () => ({ alocarNumero: mocks.alocarNumero }));
vi.mock("@/lib/propostas/versao", () => ({ decidirVersao: mocks.decidirVersao }));
vi.mock("@/lib/propostas/documento/pdf-do-documento", () => ({ renderDocumentoPdf: mocks.renderDocumentoPdf }));
vi.mock("@/lib/propostas/storage", () => ({ salvarPdfDaProposta: mocks.salvarPdfDaProposta }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: mocks.marcaDaSaida }));
vi.mock("@/lib/propostas/marca-da-organizacao-para-pdf", () => ({ marcaDaOrganizacaoParaPdf: mocks.marcaDaOrganizacaoParaPdf }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: mocks.emitLeadActivity }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.sendMessageHandler }));
vi.mock("@/lib/followup/retorno-crm", () => ({ agendaRetornoNoCrm: mocks.agendaRetornoNoCrm }));
vi.mock("@/lib/propostas/padroes-da-organizacao", () => ({ buscarPadroesDaOrganizacao: mocks.buscarPadroesDaOrganizacao }));
vi.mock("@/lib/propostas/modelos/resolver", () => ({ resolverModelo: mocks.resolverModelo }));
vi.mock("@/lib/propostas/aviso-de-revisao", () => ({ resolverAvisoDeRevisaoSeProntaOuEncerrada: mocks.resolverAvisoDeRevisaoSeProntaOuEncerrada }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: mocks.traduzir }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSTA_ID = "44444444-4444-4444-8444-444444444444";
const LEAD_ID = "66666666-6666-4666-8666-666666666666";
const CONTACT_ID = "77777777-7777-4777-8777-777777777777";
const CONVERSA_ID = "88888888-8888-4888-8888-888888888888";
const CHANNEL_SESSION_ID = "99999999-9999-4999-8999-999999999999";

const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

interface MundoOpts {
  papel?: keyof typeof ROLE_RANK;
  foraDaJanela?: boolean;
  limiteDiarioAtingido?: boolean;
  suporteReadOnly?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  propostaOriginal?: Partial<any>;
  /** Desfecho que `sendMessageHandler` devolve — o coração do D3. */
  envioResultado?: { status: string; error_message?: string | null; id?: string };
  /** Força o INSERT de `crm_proposal_items` da v2 a falhar (D3, ponto 5). */
  itensDaV2Falham?: boolean;
  /** A criação da v2 colide com o índice único de rascunho aberto (revisão C3, I1). */
  criacaoDaV2Colide23505?: boolean;
  /** Quando true, o item da proposta vem sem preço (null, "a definir"). */
  itemSemPreco?: boolean;
  /** A conversa gravada em conversation_id pertence a OUTRO contato (revisão C3). */
  conversaDeOutroContato?: boolean;
  /** O item da proposta vem de um produto de catálogo (tem imagem). */
  itemDeCatalogo?: boolean;
  /** Status da proposta v1 (alvo de `substitui_id`) ANTES do envio da v2. */
  statusDaV1?: string;
  /** `retorno_id` já gravado na v1 (achado da revisão final da C3b+E1). */
  retornoIdDaV1?: string;
  /** `imagem_url` gravado no produto de catálogo — default `https://cdn/produto.png`. */
  imagemUrlDoCatalogo?: string;
  /** Dias do knob de follow-up automático (N2). Default: 3. */
  followupDias?: number;
  /** Resultado que `agendaRetornoNoCrm` devolve (N2). Default: sucesso com id "retorno-1". */
  agendamentoDeRetorno?: unknown;
  /** Proposta órfã — o negócio foi apagado (lead_id virou null, D10). */
  leadIdNulo?: boolean;
}

interface Proposta {
  id: string;
  organization_id: string;
  lead_id: string | null;
  contact_id: string;
  conversation_id: string;
  numero: number | null;
  ano: number | null;
  versao: number;
  status: string;
  titulo: string;
  condicoes: string;
  valid_until: string;
  total_cents: number;
  moeda: string;
  [key: string]: unknown;
}

function montarMundoDeEnvio(opts: MundoOpts = {}) {
  const papel = opts.papel ?? "manager";
  const ordemDeChamadas: string[] = [];
  let numeroFoiAlocado = false;
  let pdfFoiGerado = false;
  let mensagemEnviada = false;
  let propostaEnviada: Proposta | null = null;
  let leadValueCentsDepois: number | null = null;
  let propostaDeletadaId: string | null = null;
  const updatesCrmProposals: Array<{ id: string | null; dados: unknown }> = [];
  const atualizacoesDeMensagem: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const propostasNoMock: Record<string, Proposta> = {};

  const proposta: Proposta = {
    id: PROPOSTA_ID,
    organization_id: ORG_ID,
    lead_id: opts.leadIdNulo ? null : LEAD_ID,
    contact_id: CONTACT_ID,
    conversation_id: CONVERSA_ID,
    numero: null,
    ano: null,
    versao: 1,
    status: "rascunho",
    titulo: "Proposta de Teste",
    condicoes: "Condições",
    valid_until: "2026-12-31",
    total_cents: 500000,
    moeda: "BRL",
    created_at: "2026-09-26T00:00:00.000Z",
    // C1 (spec de 27/09): o envio passa a exigir modelo CONFIRMADO, então o
    // mundo padrão é a proposta BOA — modelo escolhido e o briefing que o
    // modelo de teste pede preenchido. Sem isto, todo caso que espera 200
    // passaria a medir a recusa nova em vez do que foi escrito para medir. O
    // caso SEM modelo é explícito (`template_slug: null`).
    template_slug: "site_institucional",
    briefing_json: { project: { name: "Site de Teste" } },
    ...opts.propostaOriginal,
  };
  propostasNoMock[PROPOSTA_ID] = proposta;
  // Quando a proposta enviada tem substitui_id, a v1 alvo existe como linha
  // própria no mundo — status configurável para provar que o envio da v2 só
  // troca a v1 quando ela AINDA está 'enviada' (achado Crítico da revisão C4).
  const v1Id = (opts.propostaOriginal as { substitui_id?: string } | undefined)?.substitui_id;
  if (v1Id) {
    propostasNoMock[v1Id] = {
      ...proposta,
      id: v1Id,
      status: opts.statusDaV1 ?? "enviada",
      substitui_id: undefined,
      retorno_id: opts.retornoIdDaV1 ?? null,
    };
  }

  const lead = { id: LEAD_ID, contact_id: CONTACT_ID, value_cents: 100000 };
  const contato = { id: CONTACT_ID, name: "Cliente", display_name: "Cliente", email: "cli@test.com", phone_number: "5511" };
  const conversa = {
    id: CONVERSA_ID,
    channel_session_id: CHANNEL_SESSION_ID,
    contact_id: opts.conversaDeOutroContato ? "contato-errado-00000000-0000-0000-0000-000000000000" : CONTACT_ID,
  };
  // Outra conversa do mesmo contato, MAIS RECENTE — o fallback "mais recente
  // do contato" a devolveria; a conversa gravada na proposta é a de cima.
  const conversaMaisRecente = { id: "conversa-mais-recente-do-contato", channel_session_id: CHANNEL_SESSION_ID, contact_id: CONTACT_ID };
  const chamadasConversas: Array<[string, unknown]> = [];
  let conversaUsadaNoEnvio: string | null = null;
  const item = {
    id: "item-1",
    organization_id: ORG_ID,
    proposal_id: PROPOSTA_ID,
    product_id: opts.itemDeCatalogo ? "prod-1" : null,
    descricao: opts.itemSemPreco ? "Item sem preço" : "Serviço",
    quantidade: 1,
    preco_unitario_cents: opts.itemSemPreco ? null : 500000,
    desconto_cents: 0,
    position: 1000,
  };

  const rank = ROLE_RANK[papel] ?? 0;
  mocks.requireRole.mockImplementation(async (minRole: keyof typeof ROLE_RANK) => {
    const minRank = ROLE_RANK[minRole] ?? 0;
    return rank < minRank
      ? { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) }
      : { ok: true, user: { id: USER_ID, idioma: "pt-BR" }, org: { orgId: ORG_ID } };
  });

  mocks.requireSupportWrite.mockResolvedValue(opts.suporteReadOnly ? new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) : null);

  mocks.resolverModelo.mockImplementation(async (_db: unknown, _org: string, slug: string) => ({
    slug,
    version: 1,
    sectionOrder: ["resumo"],
    sections: [
      { id: "resumo", title: "Resumo", titleEs: null, body: "Projeto: {{project.name}}", bodyEs: null, required: true, conditional: false },
    ],
    origem: "base",
  }));

  mocks.createAdminClient.mockReturnValue({
    from: (tabela: string) => {
      if (tabela === "crm_proposals") {
        return {
          select: () => ({
            eq: (c: string, v: unknown) => ({
              eq: (c2: string, v2: unknown) => ({
                // Generalizado (achado da revisão C5): resolve qualquer id do
                // mundo, não só PROPOSTA_ID — o fix do retorno herdado lê a
                // v1 por `substitui_id` antes de marcá-la `substituida`.
                maybeSingle: async () => (v === ORG_ID && propostasNoMock[v2 as string] ? { data: propostasNoMock[v2 as string], error: null } : { data: null, error: null }),
              }),
            }),
          }),
          insert: (dados: unknown) => ({
            select: () => ({
              single: async () => {
                if (opts.criacaoDaV2Colide23505) return { data: null, error: { code: "23505", message: "colisao" } };
                const novoId = `proposta-nova-${Date.now()}`;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const novaProposta = { ...(dados as any), id: novoId };
                propostasNoMock[novoId] = novaProposta;
                return { data: novaProposta, error: null };
              },
            }),
          }),
          // Cadeia genérica: aceita `.eq(...)` quantas vezes o chamador
          // encadear (às vezes só `.eq("id", x)`, às vezes `.eq("organization_id", o).eq("id", x)`),
          // e resolve tanto por `await` direto (thenable) quanto via `.select().single()`.
          // O alvo é o primeiro `.eq("id", …)` visto, em qualquer posição da cadeia.
          update: (dados: unknown) => {
            let alvoId: string | null = null;
            let statusFiltro: string | undefined;
            // Mimetiza o WHERE do Postgres: um `.eq("status", X)` só deixa o
            // UPDATE valer se a linha ainda estiver naquele status — 0 linhas
            // afetadas (sem erro) quando não bate, nunca sobrescreve.
            const bateFiltro = (linha: Proposta | undefined) =>
              statusFiltro === undefined || linha?.status === statusFiltro;
            const aplicar = () => {
              const linha = alvoId ? propostasNoMock[alvoId] : undefined;
              if (!bateFiltro(linha)) return;
              updatesCrmProposals.push({ id: alvoId, dados });
              if (linha) {
                Object.assign(linha, dados as object);
                if (alvoId === PROPOSTA_ID) propostaEnviada = { ...linha };
              }
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cadeia: any = {
              eq(campo: string, valor: unknown) {
                if (campo === "id") alvoId = valor as string;
                if (campo === "status") statusFiltro = valor as string;
                return cadeia;
              },
              select() {
                return {
                  single: async () => {
                    aplicar();
                    return { data: alvoId ? (propostasNoMock[alvoId] ?? null) : null, error: null };
                  },
                };
              },
              then(resolve: (r: { error: null }) => void) {
                aplicar();
                resolve({ error: null });
              },
            };
            return cadeia;
          },
          delete: () => {
            let alvoId: string | null = null;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cadeia: any = {
              eq(campo: string, valor: unknown) {
                if (campo === "id") alvoId = valor as string;
                return cadeia;
              },
              then(resolve: (r: { error: null }) => void) {
                if (alvoId) {
                  propostaDeletadaId = alvoId;
                  delete propostasNoMock[alvoId];
                }
                resolve({ error: null });
              },
            };
            return cadeia;
          },
        };
      }
      if (tabela === "crm_proposal_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: [item], error: null }),
              }),
            }),
          }),
          insert: async () =>
            opts.itensDaV2Falham ? { error: { message: "boom" } } : { error: null },
        };
      }
      if (tabela === "conversations") {
        return {
          // Cadeia que aceita os DOIS formatos: busca pela conversa gravada
          // (select→eq→eq→maybeSingle, sem order/limit) e o fallback "mais
          // recente do contato" (select→eq→eq→order→limit→maybeSingle).
          select: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cadeia: any = {
              eq(campo: string, valor: unknown) {
                chamadasConversas.push([campo, valor]);
                return cadeia;
              },
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: conversaMaisRecente, error: null }),
                }),
              }),
              maybeSingle: async () => {
                const porId = chamadasConversas.find(([c]) => c === "id");
                if (porId) {
                  const porContactId = chamadasConversas.find(([c]) => c === "contact_id");
                  if (porId[1] !== conversa.id) return { data: null, error: null };
                  if (porContactId && porContactId[1] !== conversa.contact_id) return { data: null, error: null };
                  return { data: conversa, error: null };
                }
                return { data: conversaMaisRecente, error: null };
              },
            };
            return cadeia;
          },
        };
      }
      if (tabela === "crm_leads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: lead, error: null }),
              }),
            }),
          }),
          update: (dados: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((dados as any).value_cents) leadValueCentsDepois = (dados as any).value_cents;
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      if (tabela === "contacts") {
        return {
          select: () => ({
            eq: (c: string, v: unknown) => ({
              eq: (c2: string, v2: unknown) => ({
                maybeSingle: async () => (v === ORG_ID && v2 === CONTACT_ID ? { data: contato, error: null } : { data: null, error: null }),
              }),
            }),
          }),
        };
      }
      if (tabela === "catalog_products") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: opts.itemDeCatalogo ? [{ id: "prod-1", imagem_url: opts.imagemUrlDoCatalogo ?? "https://cdn/produto.png" }] : [],
                error: null,
              }),
            }),
          }),
        };
      }
      if (tabela === "messages") {
        return {
          update: (patch: Record<string, unknown>) => {
            // Aceita `.eq(...)` quantas vezes a cadeia encadear (a rota agora
            // filtra por `organization_id` E por `id`) e registra por coluna.
            const cadeia: Record<string, unknown> = {};
            cadeia.eq = (campo: string, valor: unknown) => {
              if (campo === "id") atualizacoesDeMensagem.push({ id: valor as string, patch });
              return cadeia;
            };
            cadeia.then = (resolver: (v: unknown) => unknown) => resolver({ error: null });
            return cadeia;
          },
        };
      }
      throw new Error(`Tabela desconhecida: ${tabela}`);
    },
  });

  mocks.adiarAteAJanelaAbrir.mockImplementation(async () => {
    ordemDeChamadas.push("adiarAteAJanelaAbrir");
    return opts.foraDaJanela ? "2026-09-18T22:00:00Z" : null;
  });

  mocks.checkDailyLimit.mockImplementation(async () => {
    ordemDeChamadas.push("checkDailyLimit");
    return { allowed: !opts.limiteDiarioAtingido };
  });

  mocks.espacarEnvio.mockImplementation(async () => {
    ordemDeChamadas.push("espacarEnvio");
  });

  // D9/D3: alocarNumero (o de verdade) grava numero/ano na linha como efeito
  // colateral — só NÃO grava status (quem decide o status é a rota, pelo
  // desfecho da mensagem). O dublê reproduz esse efeito colateral.
  mocks.alocarNumero.mockImplementation(async (_admin: unknown, params: unknown) => {
    numeroFoiAlocado = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const propostaAlvo = propostasNoMock[(params as any).propostaId];
    if (propostaAlvo) Object.assign(propostaAlvo, { numero: 42, ano: 2026 });
    return { numero: 42, ano: 2026 };
  });

  // C4/D4 — espelha o contrato novo de decidirVersao: só `rascunho` passa
  // (patch no mesmo registro); qualquer outro status lança e a rota vira 409.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mocks.decidirVersao.mockImplementation((prop: any) => {
    if (prop.status === "rascunho") return { tipo: "patch_no_mesmo" };
    throw new Error(`status_nao_editavel: ${prop.status}`);
  });

  mocks.renderDocumentoPdf.mockImplementation(async () => {
    pdfFoiGerado = true;
    return Buffer.from("PDF-DOCUMENTO");
  });

  mocks.salvarPdfDaProposta.mockResolvedValue({ path: "/pdf", signedUrl: "https://url" });

  mocks.marcaDaSaida.mockResolvedValue({ nome: "App", accent: "#000", accentFg: "#fff", logoUrl: null });

  mocks.marcaDaOrganizacaoParaPdf.mockResolvedValue({ appName: "Clínica X", accentHex: "#111111", logoUrl: "https://logo" });

  mocks.sendMessageHandler.mockImplementation(async (_admin: unknown, _ctx: unknown, payload: { conversation_id: string }) => {
    ordemDeChamadas.push("sendMessageHandler");
    mensagemEnviada = true;
    conversaUsadaNoEnvio = payload.conversation_id;
    return opts.envioResultado ?? { id: "msg-123", status: "sent", error_message: null };
  });

  mocks.emitLeadActivity.mockImplementation(async () => {
    ordemDeChamadas.push("emitLeadActivity");
  });

  // N2 — follow-up automático ao enviar: padroes com o knob + agendamento
  // controlável por teste (o módulo real bateria no banco via service-role).
  mocks.buscarPadroesDaOrganizacao.mockImplementation(async () => ({
    defaultValidDays: 15,
    defaultConditions: null,
    followupDias: opts.followupDias ?? 3,
  }));
  mocks.agendaRetornoNoCrm.mockImplementation(async () =>
    opts.agendamentoDeRetorno !== undefined
      ? opts.agendamentoDeRetorno
      : { ok: true, retorno: { id: "retorno-1", quando: "2026-09-27T12:00:00Z" } },
  );

  mocks.audit.mockImplementation(() => {
    ordemDeChamadas.push("audit");
  });

  return {
    ordemDeChamadas,
    chamadasConversas,
    get numeroFoiAlocado() { return numeroFoiAlocado; },
    get pdfFoiGerado() { return pdfFoiGerado; },
    get mensagemEnviada() { return mensagemEnviada; },
    get propostaEnviada() { return propostaEnviada; },
    get conversaUsadaNoEnvio() { return conversaUsadaNoEnvio; },
    get leadValueCentsDepois() { return leadValueCentsDepois; },
    get propostaDeletadaId() { return propostaDeletadaId; },
    get updatesCrmProposals() { return updatesCrmProposals; },
    get atualizacoesDeMensagem() { return atualizacoesDeMensagem; },
    obterProposta(id: string) { return propostasNoMock[id]; },
    async POST() {
      const { POST } = await import("./route");
      return POST(new NextRequest(`http://localhost/api/v1/proposals/${PROPOSTA_ID}/send`), { params: Promise.resolve({ id: PROPOSTA_ID }) });
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/v1/proposals/[id]/send", () => {
  it("papel agent: 403, nada é enviado, numero NAO alocado", async () => {
    const mundo = montarMundoDeEnvio({ papel: "agent" });
    const res = await mundo.POST();
    expect(res.status).toBe(403);
    expect(mundo.mensagemEnviada).toBe(false);
    expect(mundo.numeroFoiAlocado).toBe(false);
  });

  // Achado ao investigar "clico no PDF enviado e dá bad_gateway": o envio
  // gravava só `media_url` (a signed URL de 7 dias) e nunca `media_storage_path`
  // — que é o único campo que `GET /api/v1/messages/[id]/media` sabe reler
  // depois. Sem ele, todo clique caía no fallback de mídia de ENTRADA (o canal
  // de mensagens), que não serve para um documento que SAÍMOS enviando.
  it("grava media_storage_path na mensagem depois do envio, para o clique funcionar depois", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.atualizacoesDeMensagem).toContainEqual({ id: "msg-123", patch: { media_storage_path: "/pdf" } });
  });

  it("WhatsApp confirma (sent): vira enviada, ganha sent_at e muda o valor do negocio", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mundo.propostaEnviada?.numero).toBe(42);
    expect(mundo.mensagemEnviada).toBe(true);
    expect(mundo.leadValueCentsDepois).toBe(mundo.propostaEnviada?.total_cents);
  });

  it("ao enviar com sucesso, resolve o aviso de revisão com forcar: true", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mocks.resolverAvisoDeRevisaoSeProntaOuEncerrada).toHaveBeenCalledWith(expect.anything(), ORG_ID, PROPOSTA_ID, { forcar: true });
  });

  it("WhatsApp falha: a proposta volta a rascunho retendo o numero, sem tocar o valor do negocio", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      envioResultado: { id: "msg-1", status: "failed", error_message: "canal desconectado" },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("rascunho");
    expect(mundo.propostaEnviada?.ultima_falha_envio).toBe("canal desconectado");
    expect(mundo.propostaEnviada?.numero).toBe(42); // retido, não devolvido
    expect(mundo.leadValueCentsDepois).toBeNull();
  });

  it("erro ao gerar o PDF (excecao, nao desfecho de mensagem): volta a rascunho na hora, sem esperar o cron", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    mocks.renderDocumentoPdf.mockRejectedValueOnce(new Error("falha ao renderizar"));
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("rascunho");
    expect(mundo.propostaEnviada?.ultima_falha_envio).toBe("falha ao renderizar");
    expect(mundo.propostaEnviada?.numero).toBe(42);
    expect(mundo.mensagemEnviada).toBe(false);
  });

  it("sendMessageHandler lanca (nao devolve desfecho): volta a rascunho, nao fica presa em enviando", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    mocks.sendMessageHandler.mockRejectedValueOnce(new Error("boundary stale"));
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("rascunho");
    expect(mundo.propostaEnviada?.ultima_falha_envio).toBe("boundary stale");
  });

  it("WhatsApp enfileira (sem credencial): a proposta continua enviando", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      envioResultado: { id: "msg-2", status: "queued", error_message: null },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviando");
    expect(mundo.leadValueCentsDepois).toBeNull();
  });

  it("proposta já enviada: 409, NUNCA reenvia nem cria v2 aqui (C4 — isso agora é revisar)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { status: "enviada", numero: 42, ano: 2026, versao: 1 },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(409);
    expect(mundo.mensagemEnviada).toBe(false);
    expect(mundo.numeroFoiAlocado).toBe(false);
  });

  it("reenvio de um rascunho que ja tem numero (falha anterior): reusa o numero, NAO chama o contador de novo", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      // Simula o estado deixado por uma falha anterior: voltou a rascunho
      // RETENDO numero/ano (D3) — reenviar não pode gastar outro número.
      propostaOriginal: { status: "rascunho", numero: 42, ano: 2026, ultima_falha_envio: "canal desconectado" },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.numeroFoiAlocado).toBe(false);
    expect(mundo.propostaEnviada?.numero).toBe(42);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
  });

  it("throttle: adiarAteAJanelaAbrir e checkDailyLimit são chamados ANTES de alocar numero/gerar PDF", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    await mundo.POST();
    expect(mundo.ordemDeChamadas).toContain("adiarAteAJanelaAbrir");
    expect(mundo.ordemDeChamadas).toContain("checkDailyLimit");
    expect(mundo.ordemDeChamadas).toContain("espacarEnvio");
    expect(mundo.ordemDeChamadas).toContain("sendMessageHandler");
  });

  it("fora da janela de envio: 422, nao aloca numero nem gera PDF", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", foraDaJanela: true });
    const res = await mundo.POST();
    expect(res.status).toBe(422);
    expect(mundo.numeroFoiAlocado).toBe(false);
    expect(mundo.pdfFoiGerado).toBe(false);
  });

  it("limite diario atingido: 422, nao aloca numero nem gera PDF", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", limiteDiarioAtingido: true });
    const res = await mundo.POST();
    expect(res.status).toBe(422);
    expect(mundo.numeroFoiAlocado).toBe(false);
  });

  it("recusada/vencida/cancelada: 409, não envia", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", propostaOriginal: { status: "recusada" } });
    const res = await mundo.POST();
    expect(res.status).toBe(409);
  });

  it("respeita recusa de suporte antes de gastar orcamento/enviar", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", suporteReadOnly: true });
    const res = await mundo.POST();
    expect(res.status).toBe(403);
    expect(mundo.mensagemEnviada).toBe(false);
  });

  it("proposta com pricing_status 'missing': envio recusado, lista os itens sem preço (§5.2)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { pricing_status: "missing" },
      itemSemPreco: true,
    });
    const res = await mundo.POST();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.message).toContain("Item sem preço");
    expect(mundo.mensagemEnviada).toBe(false);
  });

  it("proposta com conversation_id gravado: usa ESSA conversa, não a mais recente do contato — E confere que é do MESMO contato (revisão C3)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { conversation_id: CONVERSA_ID },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.chamadasConversas).toContainEqual(["organization_id", ORG_ID]);
    expect(mundo.chamadasConversas).toContainEqual(["id", CONVERSA_ID]);
    expect(mundo.chamadasConversas).toContainEqual(["contact_id", CONTACT_ID]);
    expect(mundo.conversaUsadaNoEnvio).toBe(CONVERSA_ID);
  });

  it("conversation_id gravado aponta para conversa de OUTRO contato: 422, NUNCA envia pro contato errado (revisão C3)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { conversation_id: CONVERSA_ID },
      conversaDeOutroContato: true,
    });
    const res = await mundo.POST();
    expect(res.status).toBe(422);
    expect(mundo.mensagemEnviada).toBe(false);
  });

  it("proposta SEM conversation_id (rascunho manual antigo): cai no fallback de sempre (mais recente do contato)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { conversation_id: null },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.chamadasConversas).toContainEqual(["contact_id", CONTACT_ID]);
    expect(mundo.conversaUsadaNoEnvio).toBe("conversa-mais-recente-do-contato");
  });

  it("monta o PDF com a marca DA ORGANIZAÇÃO (marcaDaOrganizacaoParaPdf), nunca marcaDaSaida", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ marca: { app_name: "Clínica X", accent_hex: "#111111", logoUrl: "https://logo" } }),
    );
  });

  it("item com product_id: PDF recebe a imagem do produto de catálogo", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", itemDeCatalogo: true });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ itens: expect.arrayContaining([expect.objectContaining({ imagemUrl: "https://cdn/produto.png" })]) }),
    );
  });

  it("item manual (sem product_id): imagemUrl null, PDF não quebra", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ itens: expect.arrayContaining([expect.objectContaining({ imagemUrl: null })]) }),
    );
  });

  it.each([
    ["file:///etc/hostname", "file: local"],
    ["http://127.0.0.1/x.png", "loopback"],
    ["http://169.254.169.254/latest/meta-data", "link-local (metadata cloud)"],
    ["http://10.255.255.1/x.png", "faixa privada 10.x"],
    ["não é url nenhuma", "string inválida"],
  ])(
    "imagem_url do catálogo é %s (%s): PDF recebe imagemUrl null, nunca a string bruta (achado Importante da revisão C4 — SSRF/leitura local)",
    async (urlPerigosa) => {
      const mundo = montarMundoDeEnvio({ papel: "manager", itemDeCatalogo: true, imagemUrlDoCatalogo: urlPerigosa });
      const res = await mundo.POST();
      expect(res.status).toBe(200);
      expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
        expect.objectContaining({ itens: expect.arrayContaining([expect.objectContaining({ imagemUrl: null })]) }),
      );
    },
  );

  it("imagem_url do catálogo é https pública normal: PDF recebe a URL normalmente", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", itemDeCatalogo: true, imagemUrlDoCatalogo: "https://cdn.exemplo.com/produto.png" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ itens: expect.arrayContaining([expect.objectContaining({ imagemUrl: "https://cdn.exemplo.com/produto.png" })]) }),
    );
  });

  it("envio de v2 (rascunho com substitui_id): a v1 vira substituida (D4 — só no envio efetivo)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { status: "rascunho", numero: 42, ano: 2026, versao: 2, substitui_id: "v1-id" },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mundo.updatesCrmProposals).toContainEqual({ id: "v1-id", dados: { status: "substituida" } });
  });

  it("v1 já foi decidida (aceita) antes do envio efetivo da v2: NÃO sobrescreve o status da v1 (achado Crítico da revisão C4)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { status: "rascunho", numero: 42, ano: 2026, versao: 2, substitui_id: "v1-id" },
      statusDaV1: "aceita",
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mundo.obterProposta("v1-id")?.status).toBe("aceita");
  });

  it("envio de v1 (sem substitui_id): nenhuma outra proposta é tocada", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager" });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.updatesCrmProposals.some((u) => (u.dados as { status?: string }).status === "substituida")).toBe(false);
  });

  it("proposta enviada com sucesso: agenda o retorno automático em N dias e grava retorno_id (N2)", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", followupDias: 3 });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mocks.agendaRetornoNoCrm).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
      { leadId: LEAD_ID },
      expect.objectContaining({ motivo: expect.stringContaining("Retomar a proposta") }),
    );
    expect(mundo.updatesCrmProposals).toContainEqual(
      expect.objectContaining({ id: PROPOSTA_ID, dados: expect.objectContaining({ retorno_id: "retorno-1" }) }),
    );
  });

  it("agendamento recusado por 'ja_existe_retorno': NÃO é erro — o envio segue normalmente, sem gravar retorno_id", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      agendamentoDeRetorno: { ok: false, codigo: "ja_existe_retorno" },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mundo.updatesCrmProposals.some((u) => "retorno_id" in (u.dados as object))).toBe(false);
  });

  it("v2 herda o retorno_id da v1 quando o agendamento colide com o dela ('ja_existe_retorno'), para o decide poder cancelá-lo depois (achado Importante da revisão final da C3b+E1)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      propostaOriginal: { status: "rascunho", numero: 42, ano: 2026, versao: 2, substitui_id: "v1-id" },
      retornoIdDaV1: "retorno-da-v1",
      agendamentoDeRetorno: { ok: false, codigo: "ja_existe_retorno" },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.updatesCrmProposals).toContainEqual(
      expect.objectContaining({ id: PROPOSTA_ID, dados: expect.objectContaining({ retorno_id: "retorno-da-v1" }) }),
    );
  });

  it("agendamento fora da janela ('instante_fora_da_janela'): envio segue 200 e a timeline registra que não agendou (nunca em silêncio)", async () => {
    const mundo = montarMundoDeEnvio({
      papel: "manager",
      agendamentoDeRetorno: { ok: false, codigo: "instante_fora_da_janela" },
    });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mocks.emitLeadActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "proposal_followup_skipped" }),
    );
  });

  it("proposta órfã (lead_id nulo, D10): não tenta agendar retorno (não há negócio para retomar)", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", leadIdNulo: true });
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mocks.agendaRetornoNoCrm).not.toHaveBeenCalled();
  });

it("proposta COM template_slug: grava template_snapshot e rendered_snapshot no envio efetivo (M5)", async () => {
  const mundo = montarMundoDeEnvio({
    propostaOriginal: {
      template_slug: "site_institucional",
      briefing_json: { project: { name: "Site Catálogo" } },
    },
  });
  const res = await mundo.POST();
  expect(res.status).toBe(200);
  expect(mundo.propostaEnviada?.template_snapshot).toMatchObject({ slug: "site_institucional" });
  expect(mundo.propostaEnviada?.rendered_snapshot).toMatchObject({
    secoes: [{ id: "resumo", body: "Projeto: Site Catálogo" }],
  });
});

it("seção sobrescrita à mão (M3) entra no rendered_snapshot com o texto FINAL, não com [a definir] (Review Focus)", async () => {
  const mundo = montarMundoDeEnvio({
    propostaOriginal: {
      template_slug: "site_institucional",
      briefing_json: {},
      secoes_editadas: { resumo: "Texto escrito à mão pelo gestor." },
    },
  });
  const res = await mundo.POST();
  expect(res.status).toBe(200);
  expect(mundo.propostaEnviada?.rendered_snapshot).toMatchObject({
    secoes: [{ id: "resumo", body: "Texto escrito à mão pelo gestor." }],
  });
});

it("proposta SEM template_slug: o envio é RECUSADO com 422 e nada acontece (C1 da spec de 27/09)", async () => {
  const mundo = montarMundoDeEnvio({ papel: "manager", propostaOriginal: { template_slug: null } });
  const res = await mundo.POST();
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.message).toContain("modelo da proposta");
  expect(mundo.numeroFoiAlocado).toBe(false);
  expect(mundo.mensagemEnviada).toBe(false);
  expect(mundo.pdfFoiGerado).toBe(false);
  expect(mundo.updatesCrmProposals).toEqual([]);
});

it("sem modelo confirmado: a resposta nomeia o que fazer, e o documento NEM é montado", async () => {
  const mundo = montarMundoDeEnvio({ papel: "manager", propostaOriginal: { template_slug: null } });
  await mundo.POST();
  expect(mocks.resolverModelo).not.toHaveBeenCalled();
  expect(mocks.renderDocumentoPdf).not.toHaveBeenCalled();
});

it("WhatsApp falha (branch de retorno a rascunho): o update daquele branch NÃO inclui template_snapshot (Review Focus)", async () => {
  const mundo = montarMundoDeEnvio({
    propostaOriginal: {
      template_slug: "site_institucional",
      briefing_json: { project: { name: "Site Catálogo" } },
    },
    envioResultado: { id: "msg-1", status: "failed", error_message: "canal desconectado" },
  });
  await mundo.POST();
  const updateDeFalha = mundo.updatesCrmProposals.find(
    (u) => u.id === PROPOSTA_ID && (u.dados as Record<string, unknown>).status === "rascunho",
  );
  expect(updateDeFalha?.dados).not.toHaveProperty("template_snapshot");
});

it("recusa enviar proposta com modelo escolhido e campo do documento sem preencher (§7 item 2)", async () => {
  const mundo = montarMundoDeEnvio({
    papel: "manager",
    propostaOriginal: { template_slug: "site_institucional", briefing_json: {} },
  });
  const res = await mundo.POST();
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.message).toContain("documento");
  expect(mundo.mensagemEnviada).toBe(false);
  expect(mundo.numeroFoiAlocado).toBe(false);
});

it("permite enviar quando as seções com pendência foram todas cobertas por secoes_editadas", async () => {
  const mundo = montarMundoDeEnvio({
    papel: "manager",
    propostaOriginal: {
      template_slug: "site_institucional",
      briefing_json: {},
      secoes_editadas: { resumo: "Projeto: Site Catálogo, escopo fechado." },
    },
  });
  const res = await mundo.POST();
  expect(res.status).not.toBe(422);
  expect(res.status).toBe(200);
});

it("não deixa passar por pendência quem não tem modelo escolhido: a recusa é a do MODELO (C1)", async () => {
  const mundo = montarMundoDeEnvio({
    papel: "manager",
    propostaOriginal: { template_slug: null, briefing_json: {} },
  });
  const res = await mundo.POST();
  expect(res.status).toBe(422);
  const body = await res.json();
  // A recusa de pendência NOMEARIA campos do documento; aqui o que falta é o
  // modelo, e a frase tem que dizer isso — senão a pessoa sai caçando campo.
  expect(body.error.message).toContain("modelo da proposta");
  expect(body.error.message).not.toContain("campo(s) do documento");
  expect(mundo.numeroFoiAlocado).toBe(false);
});

describe("P1 — o documento chega ao cliente", () => {
  const BRIEFING_COMPLETO = {
    client: { company: "Imobiliária Exemplo" },
    project: { name: "Site da imobiliária", objective: "gerar contatos de compradores" },
    scope: { pages_list: "Home, Sobre, Contato" },
    included: { list: "Layout, desenvolvimento e publicação" },
    excluded: { list: "Hospedagem e domínio" },
  };

  it("MODELO REAL com tudo preenchido é enviado, e o PDF é o do documento", async () => {
    const mundo = montarMundoDeEnvio({
      propostaOriginal: { template_slug: "site_institucional", prazo_dias_uteis: 30, briefing_json: BRIEFING_COMPLETO },
    });
    mocks.resolverModelo.mockImplementation(async () => ({ ...MODELOS_BASE.site_institucional!, origem: "base" }));
    const res = await mundo.POST();
    expect(res.status).toBe(200);
    expect(mundo.propostaEnviada?.status).toBe("enviada");
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledTimes(1);
    const entrada = mocks.renderDocumentoPdf.mock.calls[0][0];
    expect(entrada.secoes.map((s: { id: string }) => s.id)).toContain("investment");
    expect(entrada.itens).toHaveLength(1);
  });

  // C1: o gerador legado (`lib/propostas/pdf.tsx`) saiu do envio. Ele continua
  // no repositório com o teste dele — o que não pode é a rota de entrega
  // recorrer a ele, porque o arquivo que ele produz não tem as seções do
  // modelo, e a proposta nem podia chegar lá (é recusada antes).
  it("o envio não importa mais o gerador legado de PDF", () => {
    const fonte = readFileSync("app/api/v1/proposals/[id]/send/route.ts", "utf8");
    expect(fonte).not.toMatch(/propostas\/pdf"/);
    expect(fonte).not.toMatch(/renderPropostaPdf\(/);
  });

  // C2: a prévia e o envio montam o PDF pela MESMA função. Duas cópias
  // divergem, e a divergência é invisível na tela.
  it("o PDF do envio sai da função compartilhada com a prévia", () => {
    const fonte = readFileSync("app/api/v1/proposals/[id]/send/route.ts", "utf8");
    expect(fonte).toMatch(/montarPdfDaProposta/);
  });

  it("sem modelo confirmado: o PDF legado não é gerado — o cliente nunca recebe o arquivo sem as seções do modelo (C1)", async () => {
    const mundo = montarMundoDeEnvio({ papel: "manager", propostaOriginal: { template_slug: null } });
    const res = await mundo.POST();
    expect(res.status).toBe(422);
    expect(mocks.renderDocumentoPdf).not.toHaveBeenCalled();
    expect(mundo.mensagemEnviada).toBe(false);
  });

  it("a recusa por pendência NOMEIA o que falta", async () => {
    const mundo = montarMundoDeEnvio({ propostaOriginal: { template_slug: "site_institucional", briefing_json: {} } });
    const res = await mundo.POST();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.message).toContain("Nome do projeto");
  });
});
});

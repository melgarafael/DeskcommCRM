/**
 * A OUVIDORIA PELO WHATSAPP — E A CONFIRMAÇÃO SÓ DEPOIS DA GRAVAÇÃO (#3611, fatia 2).
 *
 * Três garantias, e cada caso existe porque a sua ausência é um defeito que
 * ninguém veria na tela:
 *
 * 1. **⭐ A confirmação vem DEPOIS da gravação.** É a frase literal da issue. O
 *    caso que importa não é "o protocolo sai bonito" — é o que acontece quando a
 *    gravação FALHA: a pessoa não pode receber protocolo nenhum, porque um
 *    número anotado que não existe em lugar nenhum é pior do que a mensagem de
 *    erro. Por isso o dublê de banco recusa o INSERT de propósito, e o teste lê
 *    as respostas enviadas.
 *
 * 2. **A conversa da Ouvidoria não toca no funil.** É o controle central,
 *    herdado da fatia 1: o caso chama a função REAL da ingestão
 *    (`aplicarEfeitosPosEntrada`) e mede que `garantirLeadDaConversa` não foi
 *    chamado e que `ai_agent.dispatch_requested` não foi emitido.
 *
 * 3. **Desligado mantém o comportamento de hoje.** Sem `settings.ouvidoria.ativa`
 *    a mensagem segue o caminho de sempre — sem resposta, com card. É o
 *    controle que prova que este módulo é opt-in e não sequestrou a ingestão.
 *
 * O protocolo devolvido é o da LINHA GRAVADA: o caso lê a linha em
 * `ouvidoria_manifestacoes` e compara com o texto enviado, em vez de confiar no
 * retorno da função.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: vi.fn(async () => ({ lead: {}, jaEstava: false })),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: vi.fn(async () => ({ criado: true, leadId: "lead-1" })),
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: vi.fn(async () => {}),
  drenarEventosDoInbound: vi.fn(async () => {}),
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

/** O envio REAL, dublado: é a porta que a ingestão usa em produção. */
const enviados: Array<{ conversationId: string; body: string; chave: string }> = [];
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(
    async (
      _supabase: unknown,
      _ctx: unknown,
      input: { conversation_id: string; body: string; metadata?: { idempotency_key?: string } },
    ) => {
      enviados.push({
        conversationId: input.conversation_id,
        body: input.body,
        chave: input.metadata?.idempotency_key ?? "",
      });
    },
  ),
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada, type EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import {
  CHAVE_NO_METADATA,
  TETO_DO_RESUMO,
  atenderOuvidoriaNoWhatsApp,
  comRascunho,
  ehCancelamento,
  ehConfirmacao,
  ehFimDoRelato,
  lerRascunho,
  pedeOuvidoria,
  portasDaOuvidoria,
  resumirRelato,
  type EntradaDaOuvidoria,
  type PortasDaOuvidoria,
  type RascunhoDaOuvidoria,
} from "@/lib/ouvidoria/whatsapp";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { TEXTO_MAXIMO } from "@/lib/ouvidoria/registro";
import { ORG_ID, makeDb } from "@/tests/helpers/stages-db-double";

const CONVERSA = "66666666-6666-4666-8666-666666666666";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const SESSAO = "77777777-7777-4777-8777-777777777777";
const LIGADO = { ouvidoria: { ativa: true } };

type Db = ReturnType<typeof makeDb>;

/** Uma conversa de WhatsApp da organização — o ponto de partida do fluxo. */
function conversa(over: Record<string, unknown> = {}) {
  return {
    id: CONVERSA,
    organization_id: ORG_ID,
    channel: "whatsapp",
    metadata: {},
    ...over,
  };
}

function db(over: { ligado?: boolean; metadata?: Record<string, unknown>; channel?: string } = {}) {
  const registro = makeDb({
    organizationSettings: over.ligado === false ? null : LIGADO,
    contacts: [{ id: CONTATO, organization_id: ORG_ID }],
    conversas: [conversa({ channel: over.channel ?? "whatsapp", metadata: over.metadata ?? {} })],
  });
  return registro;
}

function entrada(over: Partial<EntradaDaOuvidoria> = {}): EntradaDaOuvidoria {
  return {
    organizationId: ORG_ID,
    conversationId: CONVERSA,
    contactId: CONTATO,
    messageId: "msg-1",
    texto: null,
    ...over,
  };
}

/** As respostas que o fluxo mandou, na ordem — é o que a pessoa vê. */
function ultimoTextoDe(coletor: Array<{ texto: string; chave: string }>): string {
  return coletor.at(-1)?.texto ?? "";
}

/** O rascunho como ele ficou gravado na conversa. */
function rascunhoGravado(registro: Db): RascunhoDaOuvidoria | null {
  const linha = registro.tabelas.conversations[0] as { metadata?: Record<string, unknown> };
  return lerRascunho(linha?.metadata, new Date("2026-10-28T12:00:00.000Z"));
}

/**
 * Portas com a gravação REAL (fatia 1) contra o dublê de banco: é isso que
 * permite conferir o protocolo na LINHA, não no retorno.
 */
function portas(registro: Db, coletor: Array<{ texto: string; chave: string }>): PortasDaOuvidoria {
  return {
    async responde({ texto, chave }) {
      coletor.push({ texto, chave });
    },
    registra(entradaDoRegistro) {
      // A mesma função de produção, com o mesmo cliente: o caminho medido é o
      // que roda em produção.
      return portasDaOuvidoria(registro.client as unknown as SupabaseClient, entrada()).registra(
        entradaDoRegistro,
      );
    },
    agora: new Date("2026-10-28T12:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enviados.length = 0;
});

// ---------------------------------------------------------------------------
// 1. o que a pessoa escreveu
// ---------------------------------------------------------------------------

describe("reconhecimento do pedido", () => {
  it("a palavra da ouvidoria e os verbos de reclamar abrem o fluxo", () => {
    expect(pedeOuvidoria("Oi, gostaria de fazer uma reclamação sobre o pedido")).toBe(true);
    expect(pedeOuvidoria("OUVIDORIA")).toBe(true);
    expect(pedeOuvidoria("quero registrar uma manifestação")).toBe(true);
    expect(pedeOuvidoria("vou denunciar o que aconteceu na loja")).toBe(true);
  });

  it("conversa comercial NÃO é pedido de ouvidoria", () => {
    expect(pedeOuvidoria("qual o valor do plano?")).toBe(false);
    expect(pedeOuvidoria("bom dia, tudo bem?")).toBe(false);
    expect(pedeOuvidoria(null)).toBe(false);
    expect(pedeOuvidoria("   ")).toBe(false);
  });

  it("PRONTO, CONFIRMAR e CANCELAR valem como palavra sozinha, com acento e pontuação", () => {
    expect(ehFimDoRelato("PRONTO")).toBe(true);
    expect(ehFimDoRelato("pronto!")).toBe(true);
    expect(ehFimDoRelato("terminei")).toBe(true);
    // Frase com a palavra dentro é relato, não comando.
    expect(ehFimDoRelato("pronto, e outra coisa: o boleto veio errado")).toBe(false);

    expect(ehConfirmacao("confirmo")).toBe(true);
    expect(ehConfirmacao("CONFIRMAR.")).toBe(true);
    expect(ehConfirmacao("sim")).toBe(true);
    expect(ehConfirmacao("confirmo, mas o pedido 123 mudou")).toBe(false);

    expect(ehCancelamento("cancelar")).toBe(true);
    expect(ehCancelamento("não")).toBe(true);
    expect(ehCancelamento("desisto")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. o rascunho e o resumo
// ---------------------------------------------------------------------------

describe("rascunho da manifestação", () => {
  it("metadata sem rascunho, ou com lixo, é conversa comum", () => {
    expect(lerRascunho(null)).toBeNull();
    expect(lerRascunho({})).toBeNull();
    expect(lerRascunho({ [CHAVE_NO_METADATA]: "texto" })).toBeNull();
    expect(lerRascunho({ [CHAVE_NO_METADATA]: { estado: "outro" } })).toBeNull();
  });

  it("⭐ rascunho de mais de 24 h EXPIRA: relato abandonado não sequestra a conversa", () => {
    const velho = {
      estado: "coletando",
      partes: ["reclamação antiga"],
      resumo: null,
      atualizadoEm: "2026-10-26T12:00:00.000Z",
      ultimaMensagemId: "msg-1",
    };
    expect(lerRascunho({ [CHAVE_NO_METADATA]: velho }, new Date("2026-10-28T12:00:00.000Z"))).toBeNull();
    expect(lerRascunho({ [CHAVE_NO_METADATA]: velho }, new Date("2026-10-26T13:00:00.000Z"))).not.toBeNull();
  });

  it("gravar o rascunho preserva as outras chaves do metadata", () => {
    const metadata = { outra_tela: { a: 1 } };
    const novo = comRascunho(metadata, {
      estado: "coletando",
      partes: ["x"],
      resumo: null,
      atualizadoEm: "2026-10-28T12:00:00.000Z",
      ultimaMensagemId: "m",
    });
    expect(novo.outra_tela).toEqual({ a: 1 });
    expect((novo[CHAVE_NO_METADATA] as RascunhoDaOuvidoria).partes).toEqual(["x"]);
    expect(comRascunho(metadata, null)[CHAVE_NO_METADATA]).toBeNull();
  });

  it("o resumo junta os pedaços, colapsa espaços e corta no teto", () => {
    expect(resumirRelato(["  o pedido   não chegou ", "e ninguém respondeu"])).toBe(
      "o pedido não chegou e ninguém respondeu",
    );
    const longo = resumirRelato(["a".repeat(TETO_DO_RESUMO + 50)]);
    expect(longo.length).toBeLessThanOrEqual(TETO_DO_RESUMO + 1);
    expect(longo.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. o fluxo da conversa
// ---------------------------------------------------------------------------

describe("conversa da Ouvidoria no WhatsApp", () => {
  it("abre com as boas-vindas e guarda o relato da PRÓPRIA mensagem de abertura", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const relato = "Oi, queria fazer uma reclamação: o pedido não chegou.";

    const atendimento = await atenderOuvidoriaNoWhatsApp(
      registro.client as unknown as SupabaseClient,
      entrada({ texto: relato }),
      portas(registro, registroPortas),
    );

    expect(atendimento).toEqual({ tratado: true, motivo: "iniciar" });
    expect(registroPortas).toHaveLength(1);
    expect(registroPortas[0]!.texto).toContain("PRONTO");
    // A reclamação da abertura NÃO é descartada em nome da cortesia.
    expect(rascunhoGravado(registro)?.partes).toEqual([relato]);
    // E nada é gravado na tabela da fatia 1 antes da confirmação.
    expect(registro.tabelas.ouvidoria_manifestacoes).toHaveLength(0);
  });

  it("acumula as mensagens seguintes em SILÊNCIO (não gasta o número a cada pedaço)", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "quero fazer uma reclamação", messageId: "m1" }),
      regras,
    );
    const antes = registroPortas.length;

    const segundo = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "o pedido atrasou duas semanas", messageId: "m2" }),
      regras,
    );

    expect(segundo).toEqual({ tratado: true, motivo: "acumular" });
    expect(registroPortas).toHaveLength(antes); // silêncio
    expect(rascunhoGravado(registro)?.partes).toEqual([
      "quero fazer uma reclamação",
      "o pedido atrasou duas semanas",
    ]);
  });

  it("PRONTO apresenta o resumo e passa a esperar a confirmação", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: o pedido atrasou duas semanas", messageId: "m1" }),
      regras,
    );
    const resumo = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "pronto", messageId: "m2" }),
      regras,
    );

    expect(resumo).toEqual({ tratado: true, motivo: "resumir" });
    expect(ultimoTextoDe(registroPortas)).toContain("o pedido atrasou duas semanas");
    expect(ultimoTextoDe(registroPortas)).toContain("CONFIRMAR");
    expect(rascunhoGravado(registro)?.estado).toBe("confirmando");
    expect(registro.tabelas.ouvidoria_manifestacoes).toHaveLength(0);
  });

  it("⭐ CONFIRMAR grava a manifestação e devolve o protocolo DA LINHA gravada", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: cobrança indevida na fatura", messageId: "m1" }),
      regras,
    );
    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "pronto", messageId: "m2" }),
      regras,
    );
    const confirma = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "confirmo", messageId: "m3" }),
      regras,
    );

    expect(confirma.tratado).toBe(true);
    expect(confirma.motivo).toBe("registrar");

    // A LINHA existe, com o relato inteiro e o contato da conversa.
    expect(registro.tabelas.ouvidoria_manifestacoes).toHaveLength(1);
    const linha = registro.tabelas.ouvidoria_manifestacoes[0] as Record<string, unknown>;
    expect(linha.texto).toBe("ouvidoria: cobrança indevida na fatura");
    expect(linha.canal).toBe("whatsapp");
    expect(linha.contact_id).toBe(CONTATO);
    expect(linha.organization_id).toBe(ORG_ID);

    // O texto enviado carrega o protocolo DAQUELA linha — não um inventado.
    expect(ultimoTextoDe(registroPortas)).toContain(`Protocolo ${String(linha.protocolo)}`);
    expect(ultimoTextoDe(registroPortas)).toMatch(/Protocolo OUV-\d{8}-[0-9A-F]{8}/);
    expect(confirma.manifestacao?.protocolo).toBe(String(linha.protocolo));

    // E o rascunho é limpo: a conversa não fica presa em "confirmando".
    expect(rascunhoGravado(registro)).toBeNull();
  });

  it("⭐⭐ gravação que FALHA não confirma: nenhum protocolo chega ao cliente", async () => {
    let falhar = true;
    const registro = makeDb({
      organizationSettings: LIGADO,
      contacts: [{ id: CONTATO, organization_id: ORG_ID }],
      conversas: [conversa()],
      // O INSERT da manifestação falha — e é o caso que a issue cobre.
      writeError: (_n, table) => (table === "ouvidoria_manifestacoes" && falhar ? { code: "XX000", message: "boom" } : null),
    });
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: o gerente me tratou mal", messageId: "m1" }),
      regras,
    );
    await atenderOuvidoriaNoWhatsApp(supabase, entrada({ texto: "pronto", messageId: "m2" }), regras);

    const confirma = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "confirmar", messageId: "m3" }),
      regras,
    );

    expect(confirma).toEqual({ tratado: true, motivo: "registro_falhou" });
    // Nada foi gravado…
    expect(registro.tabelas.ouvidoria_manifestacoes).toHaveLength(0);
    // …e a pessoa NÃO recebeu protocolo em texto nenhum.
    const tudo = registroPortas.map((r) => r.texto).join("\n");
    expect(tudo).not.toMatch(/OUV-\d{8}-/);
    expect(tudo).not.toContain("Protocolo");
    expect(ultimoTextoDe(registroPortas)).toContain("nada foi gravado");

    // O rascunho continua de pé: dá para tentar de novo sem reescrever o relato.
    expect(rascunhoGravado(registro)?.estado).toBe("confirmando");

    // …e a tentativa seguinte, com o banco de volta, REGISTRA.
    falhar = false;
    const retry = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "confirmo", messageId: "m4" }),
      regras,
    );
    expect(retry.motivo).toBe("registrar");
    expect(registro.tabelas.ouvidoria_manifestacoes).toHaveLength(1);
    const linha = registro.tabelas.ouvidoria_manifestacoes[0] as Record<string, unknown>;
    expect(ultimoTextoDe(registroPortas)).toContain(`Protocolo ${String(linha.protocolo)}`);
  });

  it("CANCELAR descarta sem gravar e limpa o rascunho", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: quero reclamar", messageId: "m1" }),
      regras,
    );
    await atenderOuvidoriaNoWhatsApp(supabase, entrada({ texto: "pronto", messageId: "m2" }), regras);
    const descarte = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "cancelar", messageId: "m3" }),
      regras,
    );

    expect(descarte).toEqual({ tratado: true, motivo: "descartar" });
    expect(ultimoTextoDe(registroPortas)).toContain("Nada foi registrado");
    expect(rascunhoGravado(registro)).toBeNull();
    expect(registro.tabelas.ouvidoria_manifestacoes).toHaveLength(0);
  });

  it("reentrega do provedor não vira segundo pedaço nem segunda resposta", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: o pedido veio errado", messageId: "m1" }),
      regras,
    );
    const denovo = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: o pedido veio errado", messageId: "m1" }),
      regras,
    );

    expect(denovo).toEqual({ tratado: true, motivo: "reentrega" });
    expect(registroPortas).toHaveLength(1);
    expect(rascunhoGravado(registro)?.partes).toHaveLength(1);
  });

  it("relato acima do teto da tabela pede para fechar, sem gravar a parte que estourou", async () => {
    const registro = db();
    const registroPortas: Array<{ texto: string; chave: string }> = [];
    const supabase = registro.client as unknown as SupabaseClient;
    const regras = portas(registro, registroPortas);

    await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "ouvidoria: relato longo", messageId: "m1" }),
      regras,
    );
    const estouro = await atenderOuvidoriaNoWhatsApp(
      supabase,
      entrada({ texto: "x".repeat(TEXTO_MAXIMO), messageId: "m2" }),
      regras,
    );

    expect(estouro).toEqual({ tratado: true, motivo: "limite" });
    expect(ultimoTextoDe(registroPortas)).toContain("tamanho máximo");
    expect(rascunhoGravado(registro)?.partes).toEqual(["ouvidoria: relato longo"]);
  });

  it("conversa que não é do WhatsApp fica fora do fluxo desta fatia", async () => {
    const registro = db({ channel: "instagram" });
    const registroPortas: Array<{ texto: string; chave: string }> = [];

    const atendimento = await atenderOuvidoriaNoWhatsApp(
      registro.client as unknown as SupabaseClient,
      entrada({ texto: "ouvidoria: quero reclamar" }),
      portas(registro, registroPortas),
    );

    expect(atendimento).toEqual({ tratado: false, motivo: "canal_fora_do_escopo" });
    expect(registroPortas).toHaveLength(0);
  });

  it("⭐ módulo DESLIGADO: tratado falso, nada é respondido e nada é gravado", async () => {
    const registro = db({ ligado: false });
    const registroPortas: Array<{ texto: string; chave: string }> = [];

    const atendimento = await atenderOuvidoriaNoWhatsApp(
      registro.client as unknown as SupabaseClient,
      entrada({ texto: "ouvidoria: quero reclamar" }),
      portas(registro, registroPortas),
    );

    expect(atendimento).toEqual({ tratado: false, motivo: "modulo_desligado" });
    expect(registroPortas).toHaveLength(0);
    expect(registro.escritas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. o desvio na ingestão — o controle central da issue
// ---------------------------------------------------------------------------

function entradaDaIngestao(over: Partial<EntradaDeMensagem> = {}): EntradaDeMensagem {
  return {
    organizationId: ORG_ID,
    contactId: CONTATO,
    conversationId: CONVERSA,
    messageId: "msg-1",
    channelSessionId: SESSAO,
    texto: "ouvidoria: o pedido não chegou e ninguém respondeu",
    nomeDoContato: "Quem reclamou",
    origem: "teste",
    canal: "whatsapp",
    ...over,
  };
}

describe("desvio na ingestão (#3611, fatia 2)", () => {
  it("⭐ conversa da Ouvidoria NÃO cria negócio no funil nem acorda o agente", async () => {
    const registro = db();

    await aplicarEfeitosPosEntrada(
      registro.client as unknown as Parameters<typeof aplicarEfeitosPosEntrada>[0],
      entradaDaIngestao(),
    );

    // O controle central: nenhum card nasce de uma reclamação.
    expect(garantirLeadDaConversa).not.toHaveBeenCalled();
    expect(registro.tabelas.crm_leads).toHaveLength(0);
    // Nem o turno do agente é pedido — não se vende para quem está reclamando.
    expect(registro.rpcs.filter((r) => r.nome === "emit_event")).toHaveLength(0);
    // E o relato foi acolhido pelo canal da Ouvidoria.
    expect(enviados.at(-1)?.body).toContain("Ouvidoria");
  });

  it("⭐ Ouvidoria desligada mantém o comportamento de hoje (card no funil)", async () => {
    const registro = db({ ligado: false });

    await aplicarEfeitosPosEntrada(
      registro.client as unknown as Parameters<typeof aplicarEfeitosPosEntrada>[0],
      entradaDaIngestao(),
    );

    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    // Nenhuma resposta automática sai de uma organização que não ligou o módulo.
    expect(enviados).toHaveLength(0);
  });
});

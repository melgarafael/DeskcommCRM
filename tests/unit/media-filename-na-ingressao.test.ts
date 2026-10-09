import { describe, expect, it, vi } from "vitest";

/**
 * #2613 / PR #2619 — a INGRESSÃO do nome original do arquivo.
 *
 * O PR já LÊ `metadata.media_filename` no cartão do Inbox; o que faltava (e o
 * que o mantenedor pediu no comentário 6069003446) era ALGUÉM GRAVAR a chave na
 * entrada, que é o que este arquivo prova — nos DOIS canais.
 *
 * ─── Por que entra pelo caminho de produção ──────────────────────────────────
 *
 * WAHA: o corpo cru passa pelo estágio 1 + contrato (`lerRoteamentoWaha` +
 * `conferirContratoWaha`, o mesmo par da rota) e só depois vai para
 * `dispatchWahaEvent`. Um caso que chamasse o helper direto provaria o helper e
 * mentiria sobre o schema — que é justamente um dos dois pontos que o mantenedor
 * apontou (`wahaMediaSchema`).
 *
 * Meta: o payload passa por `parseMetaWebhook` (o parser de mídia apontado por
 * ele) e o evento resultante vai para a ingestão.
 *
 * ─── O banco falso ───────────────────────────────────────────────────────────
 *
 * `from()` devolve uma cadeia tolerante para qualquer tabela (a pós-entrada e a
 * pausa da IA escrevem em tabelas que NÃO são o que se mede aqui) e CAPTURA o
 * INSERT em `messages` — que é a única linha cujo `metadata` interessa. As RPCs
 * devolvem os ids que a ingestão exige; sem eles ela desiste antes do insert e o
 * caso passaria por não ter exercitado nada.
 *
 * Os efeitos de negócio (`pos-entrada`) e a auditoria são cortados: não são o
 * que este arquivo mede, e o mesmo corte é o que `meta-ingest-media.test.ts`
 * já faz.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => undefined,
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));

import { nomeOriginalDoDocumento } from "@/components/inbox/media/media-utils";
import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import { parseMetaWebhook, type InboundMessageEvent, type OutboundEchoEvent } from "@/lib/channels/meta/webhook";
import { conferirContratoWaha, lerRoteamentoWaha } from "@/lib/waha/envelope";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

type Linha = Record<string, unknown>;

interface Duplo {
  admin: unknown;
  inseridas: Linha[];
}

/** Cadeia PostgREST que engole qualquer tabela e qualquer encadeamento. */
function cadeia(): Record<string, unknown> {
  const q: Record<string, unknown> = {
    select: () => q,
    update: () => q,
    upsert: () => q,
    delete: () => q,
    eq: () => q,
    neq: () => q,
    in: () => q,
    is: () => q,
    gte: () => q,
    lte: () => q,
    ilike: () => q,
    or: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    // `await` sem terminal: resolve no formato que a ingestão espera ler.
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(ok, ko),
  };
  return q;
}

function adminFalso(): Duplo {
  const inseridas: Linha[] = [];

  const from = (tabela: string) => {
    if (tabela !== "messages") return cadeia();
    return {
      ...cadeia(),
      insert: (linha: Linha) => {
        inseridas.push(linha);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: { id: `msg-${inseridas.length}` }, error: null }),
          }),
        };
      },
    };
  };

  const rpc = async (fn: string, _args: Record<string, unknown>) => {
    if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
    if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
    return { data: null, error: null };
  };

  return { admin: { from, rpc }, inseridas };
}

const SESSAO = { id: "sessao-1", organization_id: "org-1" };

/**
 * O MESMO par de estágios que as duas rotas de webhook do WAHA fazem:
 * roteamento (antes de arquivar) e contrato completo (depois).
 */
function contratarWaha(corp: unknown) {
  const estagio1 = lerRoteamentoWaha(JSON.stringify(corp));
  if (!estagio1.ok) throw new Error(`estágio 1 recusou: ${estagio1.motivo}`);
  const contrato = conferirContratoWaha(estagio1.envelope);
  if (!contrato.ok) {
    throw new Error(`contrato recusou: ${contrato.motivo} (${contrato.campos.join(", ")})`);
  }
  return contrato.envelope;
}

async function ingerirWaha(corp: unknown): Promise<{ linha: Linha; contrato: ReturnType<typeof contratarWaha> }> {
  const contrato = contratarWaha(corp);
  const { admin, inseridas } = adminFalso();
  await dispatchWahaEvent(admin as never, SESSAO as never, contrato, "req-teste");
  expect(inseridas, "nenhuma linha em messages — o caso não mediria a gravação").toHaveLength(1);
  return { linha: inseridas[0]!, contrato };
}

/** Payload WAHA no formato NOWEB (2026.x): mídia em `payload.media.{url,mimetype,filename}`. */
function corpoWaha(media: Record<string, unknown> | null, camposExtras: Record<string, unknown> = {}) {
  return {
    event: "message.any",
    session: "default",
    payload: {
      id: "false_5511999887766@c.us_3A60443E83484256AF03",
      from: "5511999887766@c.us",
      fromMe: false,
      body: "Segue o relatório",
      type: "document",
      hasMedia: true,
      timestamp: 1_760_000_000,
      ...(media ? { media } : {}),
      _data: { pushName: "Cliente", message: { documentMessage: {}, messageContextInfo: {} } },
      ...camposExtras,
    },
  };
}

function envelopeMeta(mensagens: unknown[], campo = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: campo,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511300000000", phone_number_id: "phone-1" },
              contacts: [{ profile: { name: "Cliente" }, wa_id: "553198966398" }],
              ...(campo === "messages" ? { messages: mensagens } : { message_echoes: mensagens }),
            },
          },
        ],
      },
    ],
  };
}

const DOCUMENTO_META = {
  from: "553198966398",
  id: "wamid.HBgMNTUzMTk4OTY2Mzk4FQIAEhgUM0I2MkZBNDk5ODZGQTU1MTI4N0MA",
  timestamp: "1785342036",
  type: "document",
  document: {
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sha256: "3qW+BNhh4gGp+8LFF/lrcbh5rC7lJArnUz40BprvFQg=",
    id: "2135061100747403",
    url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&ext=1785342337",
    filename: "Relatorio Mensal.xlsx",
  },
};

function eventosInbound(mensagem: unknown): InboundMessageEvent {
  const evento = parseMetaWebhook(envelopeMeta([mensagem]) as never).find(
    (e) => e.kind === "inbound_message",
  );
  expect(evento, "o parser não devolveu a mensagem recebida").toBeDefined();
  return evento as InboundMessageEvent;
}

async function ingerirMetaInbound(mensagem: unknown): Promise<Linha> {
  const { admin, inseridas } = adminFalso();
  const outcome = await ingestMetaInbound(admin as never, eventosInbound(mensagem), {
    organizationId: "org-1",
    channelSessionId: "sessao-1",
  });
  expect(outcome.status, `a ingestão não gravou: ${JSON.stringify(outcome)}`).toBe("ingested");
  expect(inseridas).toHaveLength(1);
  return inseridas[0]!;
}

async function ingerirMetaEco(eco: unknown): Promise<Linha> {
  const evento = parseMetaWebhook(envelopeMeta([eco], "smb_message_echoes") as never).find(
    (e) => e.kind === "outbound_echo",
  ) as OutboundEchoEvent;
  expect(evento, "o parser não devolveu o eco").toBeDefined();
  const { admin, inseridas } = adminFalso();
  const outcome = await ingestMetaEcho(admin as never, evento, {
    organizationId: "org-1",
    channelSessionId: "sessao-1",
  });
  expect(outcome.status, `a ingestão do eco não gravou: ${JSON.stringify(outcome)}`).toBe("ingested");
  expect(inseridas).toHaveLength(1);
  return inseridas[0]!;
}

describe("WAHA: a entrada passa o nome pelo schema e grava metadata.media_filename", () => {
  it("documento com nome → o contrato preserva o campo E a linha nasce com a chave", async () => {
    const { linha, contrato } = await ingerirWaha(
      corpoWaha({ url: "http://localhost:3000/api/files/default/ABC.xls", mimetype: "application/vnd.ms-excel", filename: "Relatorio Mensal.xlsx" }),
    );

    // O ponto 1 do mantenedor: o `wahaMediaSchema` tem de deixar o campo passar.
    expect(contrato.payload?.media?.filename).toBe("Relatorio Mensal.xlsx");

    expect(linha.metadata).toMatchObject({ media_filename: "Relatorio Mensal.xlsx" });
    // A MESMA leitura que o cartão do Inbox faz (`nomeOriginalDoDocumento`).
    expect(nomeOriginalDoDocumento(linha.metadata)).toBe("Relatorio Mensal.xlsx");
  });

  it("documento SEM o campo (NOWEB manda filename: null) → a chave não nasce", async () => {
    const { linha } = await ingerirWaha(
      corpoWaha({ url: "http://localhost:3000/api/files/default/ABC.pdf", mimetype: "application/pdf", filename: null }),
    );

    expect(linha.metadata).not.toHaveProperty("media_filename");
  });

  it("nome em branco não vira chave — a gravação é por valor, não por presença", async () => {
    const { linha } = await ingerirWaha(
      corpoWaha({ url: "http://localhost:3000/api/files/default/ABC.pdf", mimetype: "application/pdf", filename: "   " }),
    );

    expect(linha.metadata).not.toHaveProperty("media_filename");
  });
});

describe("Meta: o parser de mídia e a ingestão gravam metadata.media_filename", () => {
  it("documento recebido → evento com o nome e a linha com a chave", async () => {
    const evento = eventosInbound(DOCUMENTO_META);
    expect(evento.media).toMatchObject({ filename: "Relatorio Mensal.xlsx" });

    const linha = await ingerirMetaInbound(DOCUMENTO_META);
    expect(linha.metadata).toMatchObject({
      meta_media_id: "2135061100747403",
      media_filename: "Relatorio Mensal.xlsx",
    });
    expect(nomeOriginalDoDocumento(linha.metadata)).toBe("Relatorio Mensal.xlsx");
  });

  it("imagem sem `filename` na Cloud API → a chave não nasce", async () => {
    const linha = await ingerirMetaInbound({
      from: "553198966398",
      id: "wamid.HBgMNTUzMTk4OTY2Mzk4FQIAEhgUM0I2MkZBNDk5",
      timestamp: "1785342036",
      type: "image",
      image: { mime_type: "image/jpeg", sha256: "abc=", id: "2135061100747499", url: "https://lookaside.fbsbx.com/x?ext=1" },
    });

    expect(linha.metadata).not.toHaveProperty("media_filename");
  });

  it("eco do app com documento → o segundo INSERT da Meta grava também", async () => {
    const eco = {
      to: "553198966398",
      id: "wamid.ECO2619",
      timestamp: "1790000000",
      type: "document",
      document: {
        mime_type: "application/pdf",
        sha256: "abc=",
        id: "2135061100747500",
        url: "https://lookaside.fbsbx.com/y?ext=1",
        filename: "Contrato assinado.pdf",
      },
    };

    const linha = await ingerirMetaEco(eco);
    expect(linha.metadata).toMatchObject({ from_business_app: true, media_filename: "Contrato assinado.pdf" });
    expect(nomeOriginalDoDocumento(linha.metadata)).toBe("Contrato assinado.pdf");
  });
});

describe("o nome é limpo de caracteres invisíveis e limitado em tamanho, na entrada e na leitura", () => {
  // Construídos por código para o arquivo não carregar o caractere cru.
  const DIRECAO = String.fromCharCode(0x202e);
  const ISOLAMENTO = String.fromCharCode(0x2066);
  const MARCA = String.fromCharCode(0x200f);
  const CONTROLE = String.fromCharCode(0x07) + String.fromCharCode(0x0a) + String.fromCharCode(0x7f);

  it("WAHA: direção de texto e controle saem antes de gravar", async () => {
    const { linha } = await ingerirWaha(
      corpoWaha({
        url: "http://localhost:3000/api/files/default/ABC.pdf",
        mimetype: "application/pdf",
        filename: `Relatorio${DIRECAO}${CONTROLE}${ISOLAMENTO} Final${MARCA}.pdf`,
      }),
    );

    expect(linha.metadata).toMatchObject({ media_filename: "Relatorio Final.pdf" });
  });

  it("Meta: direção de texto e controle saem antes de gravar", async () => {
    const linha = await ingerirMetaInbound({
      ...DOCUMENTO_META,
      document: { ...DOCUMENTO_META.document, filename: `${DIRECAO}Planilha${CONTROLE}.xlsx` },
    });

    expect(linha.metadata).toMatchObject({ media_filename: "Planilha.xlsx" });
  });

  it("nome feito só de invisíveis não vira chave", async () => {
    const { linha } = await ingerirWaha(
      corpoWaha({
        url: "http://localhost:3000/api/files/default/ABC.pdf",
        mimetype: "application/pdf",
        filename: `${DIRECAO}${CONTROLE}${MARCA}`,
      }),
    );

    expect(linha.metadata).not.toHaveProperty("media_filename");
  });

  it("nome longo é cortado em 255 caracteres", async () => {
    const { linha } = await ingerirWaha(
      corpoWaha({
        url: "http://localhost:3000/api/files/default/ABC.pdf",
        mimetype: "application/pdf",
        filename: `${"a".repeat(400)}.pdf`,
      }),
    );

    expect(String((linha.metadata as Linha).media_filename)).toHaveLength(255);
  });

  it("a leitura do cartão limpa também o que já estava gravado", () => {
    expect(nomeOriginalDoDocumento({ media_filename: `Nota${DIRECAO}${CONTROLE}.pdf` })).toBe("Nota.pdf");
  });
});

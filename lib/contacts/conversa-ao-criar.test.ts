/**
 * CRIAR CONTATO ABRE CONVERSA? — a regra única, medida (#3718).
 *
 * A pergunta tinha duas respostas em dois arquivos e nenhum comentário: a
 * criação unitária abria a conversa do contato novo (num `try/catch` que nem
 * erro deixava no log), a importação por CSV não abria. O que se mede aqui:
 *
 *   1. a regra é UMA, e é a declarada (`manual` abre, `importacao_csv` não);
 *   2. a porta da importação responde ANTES de qualquer leitura — o custo de
 *      abrir conversa em planilha de 500 linhas é zero consulta por este
 *      caminho, não "meio caro";
 *   3. a porta manual abre no canal que alcança o telefone, e não no social mais
 *      antigo da organização (a pendência que o #3358 deixou marcada);
 *   4. quando a abertura falha, o erro SAI no log — antes ele era engolido por
 *      um `catch {}` vazio e o contato ficava sem conversa em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROVIDERS_DE_MENSAGEM, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { logger } from "@/lib/logger";
import {
  abrirConversaDoContatoNovo,
  abreConversaAoCriar,
  type PortaDaCriacao,
} from "./conversa-ao-criar";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const TELEFONE = "5532999990000";

/**
 * As duas sessões do cenário, nomeadas pela CAPACIDADE e não pelo fornecedor
 * (doutrina de restrição de canal): uma disca o número, a outra só fala com
 * quem já escreveu.
 */
const SESSION_QUE_DISCA = PROVIDERS_DE_TELEFONE[0];
const SESSION_SOCIAL = PROVIDERS_DE_MENSAGEM.find(
  (p) => !(PROVIDERS_DE_TELEFONE as readonly string[]).includes(p),
)!;

type Linha = Record<string, unknown>;

/**
 * `from(...)` encadeável que guarda predicados e só resolve no `await`, como o
 * PostgREST faz. Suporta o que `sessaoProntaParaEnvio` usa: `select`, `eq`,
 * `in`, `is`, `order`, `limit`.
 */
function bancoDeMentira(
  sessoes: Linha[],
  opcoes: { erroDaRpc?: { code?: string; message: string } } = {},
) {
  const leituras: string[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];

  const construir = () => {
    let atual = [...sessoes];
    let teto: number | null = null;
    const cadeia = {
      select: () => cadeia,
      order: (coluna: string) => {
        atual = [...atual].sort((a, b) =>
          String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")),
        );
        return cadeia;
      },
      eq: (c: string, v: unknown) => {
        atual = atual.filter((l) => l[c] === v);
        return cadeia;
      },
      is: (c: string, v: unknown) => {
        atual = atual.filter((l) => (l[c] ?? null) === v);
        return cadeia;
      },
      in: (c: string, vs: unknown[]) => {
        atual = atual.filter((l) => vs.includes(l[c]));
        return cadeia;
      },
      limit: (n: number) => {
        teto = n;
        return cadeia;
      },
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
        ok({ data: teto === null ? atual : atual.slice(0, teto), error: null }),
    };
    return cadeia;
  };
  const from = (tabela: string) => {
    leituras.push(tabela);
    return construir();
  };
  const rpc = async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ nome, args });
    if (opcoes.erroDaRpc) return { data: null, error: opcoes.erroDaRpc };
    return {
      data: {
        organization_id: ORG,
        contact_id: CONTATO,
        conversation_id: CONVERSA,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  };
  return { db: { from, rpc } as unknown as SupabaseClient, leituras, rpcs };
}

const SESSAO_QUE_DISCA: Linha = {
  id: "sessao-que-disca",
  organization_id: ORG,
  provider: SESSION_QUE_DISCA,
  status: "WORKING",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
};
const SESSAO_SOCIAL: Linha = {
  id: "sessao-social",
  organization_id: ORG,
  provider: SESSION_SOCIAL,
  status: "WORKING",
  archived_at: null,
  created_at: "2025-01-01T00:00:00Z", // a MAIS ANTIGA: ganharia o `order` + `limit(1)`
};

function abrir(porta: PortaDaCriacao, banco: ReturnType<typeof bancoDeMentira>, telefone: string | null = TELEFONE) {
  return abrirConversaDoContatoNovo(banco.db, {
    porta,
    organizationId: ORG,
    contactId: CONTATO,
    phoneNumber: telefone,
    requestId: "req-3718",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a regra de \"criar contato abre conversa\" mora num lugar só", () => {
  it("ficha manual abre; planilha importada não", () => {
    expect(abreConversaAoCriar("manual")).toBe(true);
    expect(abreConversaAoCriar("importacao_csv")).toBe(false);
  });
});

describe("porta importacao_csv — não abre, e não custa leitura", () => {
  it("contato com telefone e WhatsApp pronto: desfecho porta_nao_abre, zero consulta ao banco", async () => {
    const banco = bancoDeMentira([SESSAO_QUE_DISCA]);

    const desfecho = await abrir("importacao_csv", banco);

    expect(desfecho).toEqual({ aberta: false, motivo: "porta_nao_abre" });
    // É o que faz a planilha de 500 linhas custar ZERO por este caminho: a
    // regra responde antes do primeiro `from()`.
    expect(banco.leituras).toEqual([]);
    expect(banco.rpcs).toEqual([]);
  });

  it("500 linhas (o teto do arquivo): zero leituras e zero RPC para a planilha inteira", async () => {
    const banco = bancoDeMentira([SESSAO_QUE_DISCA]);

    const desfechos = await Promise.all(
      Array.from({ length: 500 }, () => abrir("importacao_csv", banco)),
    );

    expect(desfechos.every((d) => !d.aberta && d.motivo === "porta_nao_abre")).toBe(true);
    expect(banco.leituras).toEqual([]);
    expect(banco.rpcs).toEqual([]);
  });
});

describe("porta manual — abre, no canal que alcança o telefone", () => {
  it("sem telefone não abre: a conversa não tem por onde começar", async () => {
    const banco = bancoDeMentira([SESSAO_QUE_DISCA]);

    expect(await abrir("manual", banco, null)).toEqual({ aberta: false, motivo: "sem_telefone" });
    expect(banco.leituras).toEqual([]);
  });

  it("organização sem sessão pronta: desfecho sem_sessao, e nada é aberto", async () => {
    const banco = bancoDeMentira([]);

    expect(await abrir("manual", banco)).toEqual({ aberta: false, motivo: "sem_sessao" });
    expect(banco.rpcs).toEqual([]);
  });

  it("controle positivo: com WhatsApp WORKING abre e devolve o id da conversa", async () => {
    const banco = bancoDeMentira([SESSAO_QUE_DISCA]);

    expect(await abrir("manual", banco)).toEqual({ aberta: true, conversationId: CONVERSA });
    expect(banco.rpcs).toEqual([
      {
        nome: "fn_service_begin",
        args: { p_org: ORG, p_contact: CONTATO, p_session: "sessao-que-disca" },
      },
    ]);
  });

  it("Instagram mais antigo não rouba a sessão: o telefone escolhe o WhatsApp (#3358)", async () => {
    const banco = bancoDeMentira([SESSAO_SOCIAL, SESSAO_QUE_DISCA]);

    await abrir("manual", banco);

    // Sem `preferirTelefone` — o que o handler fazia antes deste PR — a sessão
    // escolhida era a social, a mais antiga da organização, e a conversa de um
    // contato COM telefone nascia num canal que não disca número nenhum.
    expect(banco.rpcs[0]?.args.p_session).toBe("sessao-que-disca");
  });
});

describe("falha ao abrir conversa — best-effort, mas nunca silenciosa", () => {
  it("RPC torta: não lança, devolve falhou e ESCREVE o erro no log", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const banco = bancoDeMentira([SESSAO_QUE_DISCA], {
      erroDaRpc: { code: "P0002", message: "service_channel_not_found" },
    });

    // O contato já está gravado: derrubar o cadastro por causa da conversa seria
    // trocar um efeito a menos por um contato a menos.
    await expect(abrir("manual", banco)).resolves.toEqual({ aberta: false, motivo: "falhou" });

    expect(aviso).toHaveBeenCalledTimes(1);
    const [mensagem, contexto] = aviso.mock.calls[0]!;
    expect(String(mensagem)).toContain("conversa não abriu");
    expect(contexto).toMatchObject({
      porta: "manual",
      organization_id: ORG,
      contact_id: CONTATO,
      request_id: "req-3718",
      detail: "service_channel_not_found",
    });
    // LGPD: o log da casa não grava telefone.
    expect(JSON.stringify(contexto)).not.toContain(TELEFONE);
  });
});

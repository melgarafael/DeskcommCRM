/**
 * O DESTINO POR TELEFONE NÃO SAI PELO CANAL SOCIAL (#3358).
 *
 * `sessaoProntaParaEnvio` escolhia, sozinha, a sessão de MENSAGEM `WORKING` mais
 * antiga da organização (`order created_at asc limit 1`, sem preferência de
 * provider). Numa organização que conectou Instagram/Facebook antes de
 * conectar o WhatsApp — caso comum e MEDIDO na issue — a escolhida era a social.
 * O cron do lembrete de tarefa entrega essa sessão a `ensureConversation` e o
 * envio vai para uma conversa de Instagram: o destino é um TELEFONE, e a rede
 * social não tem telefone (o contato de lá é outro endereço). O envio falha com
 * a janela de 24h fechada, ou seja, o lembrete não chega.
 *
 * O que se mede aqui é o DESFECHO — QUAL sessão sai, e de que provider ela é —,
 * não a forma da consulta. O banco de mentira APLICA os filtros (`eq`, `in`,
 * `is`, `order`, `limit`), como o PostgREST faz.
 */
import { describe, expect, it } from "vitest";

import { PROVIDERS_DE_MENSAGEM, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";

import { sessaoProntaParaEnvio } from "./start-conversation";

/**
 * As duas listas vêm da CAPACIDADE (`lib/channels/capabilities.ts`), e não de um
 * nome escrito aqui: o invariante 1 da doutrina de restrição de canal proíbe
 * nomear provider fora de `lib/channels/`, e nomear no teste seria a mesma fuga
 * por outra porta. O que este arquivo mede é o DESFECHO — QUAL sessão sai, e se
 * ela alcança um aparelho —, nunca a grafia do provider.
 */
const PROVIDERS_QUE_ALCANCAM_APARELHO: readonly string[] = PROVIDERS_DE_TELEFONE;

/** Um provider de MENSAGEM que ALCANÇA aparelho: o canal do destino por telefone. */
const PROVIDER_DE_APARELHO = PROVIDERS_DE_TELEFONE[0] as string;

/** Um provider de MENSAGEM que NÃO alcança aparelho: a rede social que a issue mede. */
const PROVIDER_SOCIAL = PROVIDERS_DE_MENSAGEM.find(
  (p) => !PROVIDERS_QUE_ALCANCAM_APARELHO.includes(p),
) as string;

type Linha = {
  id: string;
  organization_id: string;
  provider: string;
  status: string;
  archived_at: string | null;
  created_at: string;
};

/** `from(...)` encadeável que só resolve no `await`, como o PostgREST. */
function bancoDeMentira(linhas: Linha[]) {
  const construir = () => {
    let atual = [...linhas];
    let teto: number | null = null;
    const cadeia = {
      select: () => cadeia,
      eq: (coluna: string, valor: unknown) => {
        atual = atual.filter((l) => (l as Record<string, unknown>)[coluna] === valor);
        return cadeia;
      },
      is: (coluna: string, valor: unknown) => {
        atual = atual.filter((l) => ((l as Record<string, unknown>)[coluna] ?? null) === valor);
        return cadeia;
      },
      in: (coluna: string, valores: readonly unknown[]) => {
        atual = atual.filter((l) => valores.includes((l as Record<string, unknown>)[coluna]));
        return cadeia;
      },
      order: (coluna: string, opcoes?: { ascending?: boolean }) => {
        const sinal = opcoes?.ascending === false ? -1 : 1;
        atual = [...atual].sort(
          (a, b) =>
            sinal *
            String((a as Record<string, unknown>)[coluna] ?? "").localeCompare(
              String((b as Record<string, unknown>)[coluna] ?? ""),
            ),
        );
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
  return { from: () => construir() } as never;
}

/** A sessão do Instagram, conectada ANTES do WhatsApp: a mais antiga da org. */
const SOCIAL: Linha = {
  id: "instagram",
  organization_id: "org-1",
  provider: PROVIDER_SOCIAL,
  status: "WORKING",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

/** O Facebook, ainda mais novo que o Instagram. */
const FACEBOOK: Linha = { ...SOCIAL, id: "facebook", created_at: "2026-02-01T00:00:00Z" };

/** O WhatsApp, conectado depois: perde a corrida do `created_at` de hoje. */
const WHATSAPP: Linha = {
  id: "whatsapp",
  organization_id: "org-1",
  provider: PROVIDER_DE_APARELHO,
  status: "WORKING",
  archived_at: null,
  created_at: "2026-06-01T00:00:00Z",
};

/** O provider da sessão que o chamador entrega a `ensureConversation`. */
function provedorDa(sessaoId: string | null, linhas: Linha[]): string | null {
  return linhas.find((l) => l.id === sessaoId)?.provider ?? null;
}

describe("destino por TELEFONE escolhe o canal que alcança o aparelho (#3358)", () => {
  it("a sessão entregue a `ensureConversation` é a de WhatsApp, mesmo a social sendo mais antiga", async () => {
    const cenario = [SOCIAL, WHATSAPP];
    const sessaoEntregueAoEnsureConversation = await sessaoProntaParaEnvio(
      bancoDeMentira(cenario),
      "org-1",
      { preferirTelefone: true },
    );

    expect(sessaoEntregueAoEnsureConversation).toBe("whatsapp");
    expect(PROVIDERS_QUE_ALCANCAM_APARELHO).toContain(
      provedorDa(sessaoEntregueAoEnsureConversation, cenario),
    );
  });

  it("organização que SÓ tem social: a escolha continua a de hoje — a mais antiga WORKING", async () => {
    // Sem sessão de WhatsApp na organização não há para onde preferir: a regra
    // de sempre (a mais antiga entre as de mensagem) é a resposta, e um lembrete
    // por telefone continua saindo — errado do mesmo jeito que já saía, mas o
    // comportamento não muda por conta desta issue.
    const soSocial = [SOCIAL, FACEBOOK];
    const sessaoEntregueAoEnsureConversation = await sessaoProntaParaEnvio(
      bancoDeMentira(soSocial),
      "org-1",
      { preferirTelefone: true },
    );

    expect(sessaoEntregueAoEnsureConversation).toBe("instagram");
    expect(PROVIDERS_QUE_ALCANCAM_APARELHO).not.toContain(
      provedorDa(sessaoEntregueAoEnsureConversation, soSocial),
    );
  });

  it("WhatsApp fora do ar ainda ganha da social WORKING quando o destino é telefone", async () => {
    // A preferência é do PROVIDER, e não do degrau de vivacidade: um canal
    // social `WORKING` continua sem alcançar telefone nenhum. Preferi-lo aqui
    // não seria escolher o melhor dos dois — seria escolher o único que não
    // pode funcionar, e o dono do número leria "confira a conexão" sem que
    // houvesse conexão alguma a conferir.
    const comWhatsappForaDoAr = [SOCIAL, { ...WHATSAPP, status: "STOPPED" }];
    const sessaoEntregueAoEnsureConversation = await sessaoProntaParaEnvio(
      bancoDeMentira(comWhatsappForaDoAr),
      "org-1",
      { preferirTelefone: true },
    );

    expect(PROVIDERS_QUE_ALCANCAM_APARELHO).toContain(
      provedorDa(sessaoEntregueAoEnsureConversation, comWhatsappForaDoAr),
    );
  });

  it("WhatsApp ARQUIVADO não entra: o produto o considera excluído", async () => {
    // Arquivar é como o canal sai do sistema sem levar o histórico (migration
    // 0106). Ele continua na tabela como âncora das FKs, e não como saída.
    const comWhatsappArquivado = [SOCIAL, { ...WHATSAPP, archived_at: "2026-07-01T00:00:00Z" }];
    const sessaoEntregueAoEnsureConversation = await sessaoProntaParaEnvio(
      bancoDeMentira(comWhatsappArquivado),
      "org-1",
      { preferirTelefone: true },
    );

    expect(sessaoEntregueAoEnsureConversation).toBe("instagram");
  });

  it("quem NÃO pede a preferência continua escolhendo pela ordem de criação", async () => {
    // A porta é a mesma para o create de contato (`contacts/_handler.ts`), o
    // MCP e a conversa compartilhada — e eles ainda não pedem a preferência. Eles
    // seguem recebendo o MESMO resultado de antes desta issue.
    const cenário = [SOCIAL, WHATSAPP];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("instagram");
    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1", {})).toBe("instagram");
  });
});

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

import { escolherSessaoParaEnvio, sessaoProntaParaEnvio } from "./start-conversation";

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
  /** `channel_sessions.metadata` — é nele que mora o `disabled` do operador. */
  metadata?: Record<string, unknown> | null;
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

/**
 * CANAL DESLIGADO NUNCA É ESCOLHIDO (#4092).
 *
 * `metadata.disabled` é a intenção declarada do dono do número (#2318): o canal
 * não entra na inbox, não acorda a IA, não envia. A escolha da sessão não
 * conhecia essa chave — pegava a `WORKING` mais antiga e pronto. Numa
 * organização em que o número velho foi desligado e um novo foi conectado
 * depois, TODA abertura sem canal escolhido (cadastro salvo, ferramenta de IA,
 * lembrete de tarefa) caía no desligado e a abertura era recusada com 409,
 * mesmo havendo outro canal pronto.
 *
 * A régua de "pode enviar" é a do resto do produto, e não uma terceira:
 * `canalDesativado` (`lib/channels/desativado.ts`), leitura estrita de `=== true`.
 */
describe("abrir sem canal escolhido pula os canais DESLIGADOS (#4092)", () => {
  /** O canal que o operador desligou, e que é o MAIS ANTIGO da org. */
  const DESLIGADO: Linha = {
    ...WHATSAPP,
    id: "desligado",
    created_at: "2025-01-01T00:00:00Z",
    metadata: { disabled: true },
  };

  it("o canal desligado mais antigo é PULADO: a sessão entregue é o próximo que pode enviar", async () => {
    // O defeito, medido: antes desta regra a resposta era "desligado" — e quem
    // chama recusa a abertura em cima dela (409 `session_unavailable`).
    const cenário = [DESLIGADO, WHATSAPP];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("whatsapp");
  });

  it("TODOS desligados: nenhuma sessão é entregue (a recusa continua, sem escolher canal morto)", async () => {
    const cenário = [DESLIGADO, { ...SOCIAL, metadata: { disabled: true } }];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBeNull();
  });

  it("`disabled: false` NÃO desliga: a leitura é a estrita (`=== true`), a mesma do produto", async () => {
    // Um `!metadata.disabled` (ou `metadata.disabled == true`) trataria `false`,
    // `"false"` e ausência de formas diferentes. A régua única é
    // `canalDesativado`: só o booleano `true` desliga.
    const explícito = { ...DESLIGADO, metadata: { disabled: false } };
    const cenário = [explícito, WHATSAPP];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("desligado");
  });

  it("canal fora do ar continua perdendo para um WORKING, mesmo sendo mais antigo", async () => {
    // O pulo do desligado não pode virar "pega o primeiro da lista": a ordem
    // dos degraus (WORKING antes de qualquer uma) fica como está.
    const parado = { ...WHATSAPP, id: "parado", status: "STOPPED", created_at: "2025-01-01T00:00:00Z" };
    const cenário = [parado, WHATSAPP];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("whatsapp");
  });

  it("sem nenhum WORKING, a última alternativa continua a não arquivada (degradação intacta)", async () => {
    // Comportamento de antes desta issue, preservado de propósito: travar a
    // abertura por causa da saúde do transporte trocaria um defeito por outro.
    // O que NÃO volta é o desligado — ele sai da lista em todos os degraus.
    const parado = { ...WHATSAPP, id: "parado", status: "STOPPED", created_at: "2025-06-01T00:00:00Z" };
    const cenário = [DESLIGADO, parado];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("parado");
  });

  it("o desempate continua o MAIS ANTIGO entre os que podem enviar (não inverte para o mais novo)", async () => {
    const prontoA = { ...WHATSAPP, id: "pronto-a", created_at: "2026-03-01T00:00:00Z" };
    const prontoB = { ...WHATSAPP, id: "pronto-b", created_at: "2026-04-01T00:00:00Z" };
    const cenário = [DESLIGADO, prontoA, prontoB];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("pronto-a");
  });

  it("canal de OUTRA organização não entra na lista, nem sendo o mais antigo e ligado", async () => {
    const daOutra = { ...WHATSAPP, id: "da-outra", organization_id: "org-2" };
    const cenário = [daOutra, WHATSAPP];

    expect(await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1")).toBe("whatsapp");
  });

  it("destino por TELEFONE: o desligado é pulado e a preferência continua vencendo a social mais nova", async () => {
    // A preferência é do PROVIDER (#3358): o próximo canal que DISCA é o
    // escolhido, mesmo que a social esteja mais nova. O pulo do desligado não
    // pode custar essa ordem.
    const socialNova = { ...SOCIAL, id: "social-nova", created_at: "2026-07-01T00:00:00Z" };
    const cenário = [DESLIGADO, socialNova, WHATSAPP];

    expect(
      await sessaoProntaParaEnvio(bancoDeMentira(cenário), "org-1", { preferirTelefone: true }),
    ).toBe("whatsapp");
  });

  it("a escolha diz POR QUE não há sessão: `todosDesligados` separa 'desligaram todos' de 'não há canal'", async () => {
    // Quem recusa precisa do motivo: com canais desligados a resposta é a de
    // antes (`session_unavailable` → 409, "reative a conexão"); sem canal
    // nenhum continua `session_not_found` (404). Sem essa distinção o
    // conserto trocaria o código da recusa.
    const semNada = await escolherSessaoParaEnvio(bancoDeMentira([]), "org-1");
    expect(semNada).toEqual({ id: null, todosDesligados: false });

    const todosDesligados = await escolherSessaoParaEnvio(
      bancoDeMentira([DESLIGADO, { ...SOCIAL, metadata: { disabled: true } }]),
      "org-1",
    );
    expect(todosDesligados).toEqual({ id: null, todosDesligados: true });

    const comUmPronto = await escolherSessaoParaEnvio(
      bancoDeMentira([DESLIGADO, WHATSAPP]),
      "org-1",
    );
    expect(comUmPronto).toEqual({ id: "whatsapp", todosDesligados: false });
  });
});

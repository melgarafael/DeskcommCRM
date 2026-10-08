/**
 * O CANAL DA CONVERSA NAS DUAS TELAS ONDE ELE TEM DE APARECER (#2383).
 *
 * ─── O que a issue pede ────────────────────────────────────────────────────
 * "Exibir nas conversas do Inbox um identificador visual do canal associado…
 * nome amigável do canal (ex.: Peças); opcionalmente o número… A informação
 * pode aparecer como badge/rótulo na lista de conversas E também no cabeçalho
 * da conversa aberta."
 *
 * A lista já tinha o badge (PR "mostrar por onde a conversa entrou"); o que
 * faltava eram duas coisas, e é isto que este arquivo cobra:
 *
 * 1. O CABEÇALHO não dizia o canal nenhum. O logo ao lado do nome (provider)
 *    é idêntico para "Peças" e para "Vendas" — o atendente só descobria de
 *    qual número era a conversa abrindo a Central de Conexões.
 * 2. O rótulo da lista era `phone_number ?? display_name`, o inverso da tela
 *    de canais. A dona chamava o canal de "Peças" e a lista imprimia
 *    +55 17 9XXXX-XXXX — o número cru, que ela não reconhece como sendo o
 *    dela, no lugar do nome que ela escolheu.
 *
 * ─── Por que a paridade é testada pela FUNÇÃO e não por duas pinturas ──────
 * Porque as duas telas chamam `rotuloDoCanalDaConversa`; se elas renderizassem
 * strings diferentes o defeito estaria no resolvedor, e é lá que este arquivo
 * cobra. Comparar `rotuloDoCanalDaConversa(canal)` com `channelLabel(canal)` —
 * o rótulo que a página `/app/connections` imprime no card — é a mesma pergunta
 * feita uma vez, com a resposta do outro lado da tela como testemunha.
 *
 * A paridade tem um corte DECLARADO: `channelLabel` ainda cai em
 * `waha_session_name` (o `org_2dd5e6ea` que `nomeDoCanal` expulsou de propósito,
 * ver o docstring lá). Aqui esse degrau devolve `null` — expor o identificador
 * do transporte como se fosse o nome do número seria trazer de volta o defeito
 * que a outra função existe para impedir.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";
import { channelLabel } from "@/hooks/channels/useChannelSessions";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

// ── O cabecalho e os hooks que ele puxa. Mesmo conjunto de
// tests/unit/inbox-header-nao-trava.test.tsx: só o badge interessa aqui, e o
// resto (discador, atribuição, arquivamento) pertence àquele arquivo.
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: "manager" } }),
}));

type Canal = { display_name: string | null; phone_number: string | null } | null;

const conversa = (canal: Canal) =>
  ({
    id: "cv-1",
    organization_id: "org-1",
    contact_id: "ct-1",
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: "ai",
    snooze_until: null,
    tags: [],
    contacts: { id: "ct-1", display_name: "João da Silva", name: null, phone_number: "5517999" },
    channel_sessions: canal ? { ...canal, provider: "waha" } : null,
  }) as unknown as ConversationWithContact;

function pintar(canal: Canal) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationHeader conversation={conversa(canal)} />
    </QueryClientProvider>,
  );
}

describe("no CABEÇALHO da conversa aberta", () => {
  it("o badge diz o MESMO rótulo da tela de canais — nome na frente, número cru fora", () => {
    pintar({ display_name: "Peças", phone_number: "+19392301037" });

    const badge = screen.getByTestId("canal-da-conversa");
    expect(badge).toHaveTextContent("Peças");
    // Mesmo `title` da lista: o badge encolhe com nome longo e quem passa o
    // mouse lê o texto inteiro.
    expect(screen.getByTitle("Entrou por Peças")).toBeInTheDocument();
    // PII: com nome amigável o número não é exibido — nem aqui nem na lista.
    expect(badge.textContent).not.toContain("+193****1037");
    // #2383 (critério 5): a fonte é a SESSÃO da conversa, não o contato. O
    // contato aqui é "5517999"; se o rótulo saísse dele o badge diria outra
    // coisa — e o atendente leria o número da pessoa como se fosse o canal.
    expect(badge).not.toHaveTextContent("5517999");
    // Aceite: "layout continua utilizável… com nomes de canal maiores".
    expect(badge.className).toContain("max-w-");
    expect(badge.className).toContain("truncate");
    // O badge ACRESCENTA: o logo do provider continua na linha do nome, e é
    // justamente a insuficiência dele (igual para Peças e Vendas) que o badge
    // existe para cobrir.
    expect(screen.getByRole("img", { name: "WhatsApp" })).toBeInTheDocument();
  });

  it("sem canal, o cabeçalho fica EXATAMENTE como estava", () => {
    // Grupo, conversa sem sessão, canal não-WA: não há o que mostrar, e a
    // promessa é o badge ser acréscimo — nada é substituído nem escondido.
    pintar(null);

    expect(screen.queryByTestId("canal-da-conversa")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "João da Silva" })).toBeInTheDocument();
    // Nenhum título "Entrou por …" no header: sem canal não há o que explicar.
    expect(document.querySelector('[title^="Entrou por"]')).toBeNull();
  });

  it("as DUAS telas calculam o rótulo pela MESMA função — uma só cadeia de regras", () => {
    // As duas chamadas são o elo; sem elas cada tela voltaria a derivar o
    // rótulo por conta própria, que é exatamente como a lista e o cabeçalho
    // começariam a divergir (mesma classe do `comandoDaConversa` unificado).
    for (const arquivo of [
      "components/inbox/ConversationListItem.tsx",
      "components/inbox/ConversationHeader.tsx",
    ]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, `${arquivo} não chama rotuloDoCanalDaConversa`).toMatch(
        /rotuloDoCanalDaConversa\(/,
      );
    }
  });
});

describe("o rótulo É o da página /channels", () => {
  it.each([
    ["nome e número", { display_name: "Peças", phone_number: "+19392301037", waha_session_name: null }],
    ["só o nome", { display_name: "Centro Automotivo", phone_number: null, waha_session_name: null }],
    ["só o número", { display_name: null, phone_number: "+19392301037", waha_session_name: null }],
  ])("%s → igual ao card do canal", (_caso, canal) => {
    expect(rotuloDoCanalDaConversa(canal)).toBe(channelLabel(canal));
  });

  it("dois números do MESMO provider continuam distinguíveis pelo nome/número", () => {
    // #2383 (critério 4): mesmas "Peças"/"Vendas" no mesmo provider. Sem nome
    // amigável o NÚMERO é o que separa uma da outra — e o nome, quando existe,
    // é o que o operador lê primeiro.
    const pecas = { display_name: "Peças", phone_number: "+55179991111" };
    const vendas = { display_name: "Vendas", phone_number: "+55179992222" };
    const semApelido = { display_name: null, phone_number: "+55179993333" };

    expect(rotuloDoCanalDaConversa(pecas)).toBe("Peças");
    expect(rotuloDoCanalDaConversa(pecas)).not.toBe(rotuloDoCanalDaConversa(vendas));
    expect(rotuloDoCanalDaConversa(semApelido)).toBe("+55179993333");
    expect(rotuloDoCanalDaConversa(semApelido)).not.toBe(
      rotuloDoCanalDaConversa({ display_name: null, phone_number: "+55179992222" }),
    );
  });

  it("canal sem nome E sem número não vira badge — nem a frase repetida em toda linha", () => {
    // `channelLabel` cai em "Número sem nome"; o resolvedor das telas de
    // conversa devolve `null`, que é como a lista já se comportava. Sem isso
    // a mesma palavra apareceria em toda linha e no cabeçalho de todo grupo.
    expect(rotuloDoCanalDaConversa({ display_name: null, phone_number: null })).toBeNull();
    expect(rotuloDoCanalDaConversa(null)).toBeNull();
  });

  it("NUNCA entrega o id do transporte (org_…) que /channels só mostra no último degrau", () => {
    const canal = { display_name: null, phone_number: null, waha_session_name: "org_2dd5e6ea" };
    expect(channelLabel(canal)).toBe("org_2dd5e6ea");
    expect(rotuloDoCanalDaConversa(canal)).toBeNull();
  });
});

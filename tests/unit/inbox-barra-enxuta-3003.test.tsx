import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * A BARRA DO CABEÇALHO FICA ENXUTA — E NENHUMA AÇÃO SOME (#3003).
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * A issue pede duas coisas: guias curtas em cada botão (entregue no #3041) e um
 * menu "⋯" para as ações menos usadas. Este arquivo é a régua da segunda.
 *
 * Ele CONTA. A barra que a `main` entregava oferecia **12 controles** de uma vez
 * em qualquer conversa de fila — assumir, liberar, devolver, pausar, transferir,
 * lembrar, fechar, arquivar, marcar pessoal, ver contato, chamar, vídeo —, e a
 * pergunta "o que acontece se eu clicar aqui?" não tinha resposta na tela. A
 * barra enxuta oferece as ações de TODO atendimento (responder, transferir,
 * encerrar) e manda o resto para o menu, **com ícone, nome e a mesma guia de
 * uma linha**.
 *
 * ─── Por que ele reprova de DOIS lados, e não de um ─────────────────────────
 *
 * Um teste que só contasse "o menu tem N itens" passaria com uma ação apagada do
 * componente — a conta fecharia por baixo. Por isso a asserção é de CONJUNTO
 * EXATO, cenário por cenário: a união `barra ∪ menu` tem de ser exatamente o
 * inventário daquele estado. Ação que some do componente encolhe a união e
 * reprova; ação que some da barra sem entrar no menu reprova na mesma linha; e
 * ação que fica nos DOIS lugares (duplicada) também, porque o conjunto é exato.
 *
 * ─── A regra de produto que este arquivo substitui ──────────────────────────
 *
 * `tests/unit/inbox-header-nao-trava.test.tsx` afirma, desde o #1625, que as
 * ações continuam TODAS na barra e que um botão "Mais ações" **não pode
 * existir** — regra escrita depois de o dono recusar um menu "Mais" (#1625,
 * #1627) e de o #2700 ser fechado sem merge por levá-la ao celular. O #3003 é a
 * terceira vez que o pedido volta, agora com o dono da issue descrevendo o custo
 * na operação (atendente novo clicando em "encerrar" querendo "adiar"), e a
 * posse foi sinalizada na issue antes de codar. A catraca daquele arquivo
 * deixou de ser "tudo na barra" e passou a ser "nada fora da vista": a ação pode
 * morar no menu, e o menu é OBRIGATÓRIO. Ver o caso "o menu não é opcional".
 *
 * ─── Dublês ─────────────────────────────────────────────────────────────────
 *
 * Todos são de FRONTEIRA (rede, sessão, configuração da instalação), nenhum é do
 * cabeçalho: `DialButton`, `VideoCallButton` e `ParticipantesDaConversa` rodam
 * DE VERDADE, porque é justamente deles que vêm quatro das ações que mudaram de
 * lugar — dublar o componente provaria só que o mock foi chamado. O que se
 * dubla é o que ele lê de fora: o status da sessão de voz, o servidor de vídeo da
 * instalação e as duas listas da API.
 */

const estado = vi.hoisted(() => ({
  auth: { user: { id: "u1", support: null, is_platform_admin: true } } as Record<string, unknown>,
  automaticoDaOrg: true as boolean | undefined,
  /** `JITSI_SERVER_URL` da instalação: `null` = recurso opt-in desligado. */
  servidorDeVideo: "https://meet.exemplo.com.br" as string | null,
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => estado.auth,
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useSnoozeConversation", () => ({
  useSnoozeConversation: () => ({
    snooze: { mutate: vi.fn(), isPending: false },
    cancel: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: estado.automaticoDaOrg }),
}));
// Voz: a instalação pareou o canal. Sem isto o `DialButton` devolve `null` e
// "Chamar" nem entra em cena — o que é o comportamento certo, e é medido no
// último caso deste arquivo.
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: { configured: true, paired: true } }),
}));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startCall: vi.fn() }),
}));
// Dublê de CONFIGURAÇÃO, não de componente: é o `JITSI_SERVER_URL` da instalação
// que decide se o item de vídeo existe. Os três nomes abaixo são os únicos que
// `VideoCallButton` importa de lá.
vi.mock("@/lib/video/jitsi", () => ({
  servidorDeVideo: () => estado.servidorDeVideo,
  novaSala: () => "sala-de-teste",
  urlDaSala: (servidor: string | null, sala: string) => (servidor ? `${servidor}/${sala}` : null),
}));
// Listas da API (participantes, diretório de pessoas): fronteira de rede.
vi.mock("@/hooks/inbox/useParticipantesDaConversa", () => ({
  useParticipantesDaConversa: () => ({ data: [] }),
  useConvidarParticipante: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoverParticipante: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  chaveDosParticipantes: () => ["participantes"],
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
// Peças que só ocupam lugar: não são ação deste cabeçalho.
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/inbox/FaixaDaCarteira", () => ({ FaixaDaCarteira: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));

/**
 * O INVENTÁRIO — cada ação do cabeçalho, com o `data-testid` que a identifica e
 * o lugar que ela passou a ocupar.
 *
 * Os `data-testid` que já existiam na `main` (`devolver-ao-automatico`,
 * `pausar-o-automatico`, `marcar-pessoal`, `desmarcar-pessoal`,
 * `convidar-participante`, `btn-videochamada`) foram PRESERVADOS: são contrato
 * de e2e (`escalacao-ciclo`, `contato-pessoal-sai-da-operacao`). Os que faltavam
 * foram criados com o prefixo `acao-` — sem eles não há como contar ação nenhuma
 * sem depender de rótulo traduzido.
 */
const ACOES = [
  { id: "buscar-na-conversa", rotulo: "Buscar nesta conversa" },
  { id: "acao-assumir", rotulo: "Assumir" },
  { id: "acao-liberar", rotulo: "Liberar" },
  { id: "devolver-ao-automatico", rotulo: "Devolver ao automático" },
  { id: "acao-transferir", rotulo: "Transferir" },
  { id: "acao-fechar", rotulo: "Fechar" },
  { id: "acao-reabrir", rotulo: "Reabrir" },
  { id: "acao-ver-contato", rotulo: "Ver contato" },
  { id: "acao-chamar", rotulo: "Chamar" },
  { id: "acao-reservar-servico", rotulo: "Reservar serviço" },
  { id: "btn-videochamada", rotulo: "Vídeo" },
  { id: "convidar-participante", rotulo: "Convidar" },
  { id: "pausar-o-automatico", rotulo: "Pausar o automático" },
  { id: "acao-lembrar", rotulo: "Lembrar" },
  { id: "acao-arquivar", rotulo: "Arquivar" },
  { id: "marcar-pessoal", rotulo: "Marcar como pessoal" },
  { id: "desmarcar-pessoal", rotulo: "Desmarcar pessoal" },
] as const;

const CONTATO = {
  id: "contato-1",
  display_name: "Fulana",
  name: null,
  phone_number: "5511999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  is_anonymized: false,
  force_human: false,
};

interface Cenario {
  nome: string;
  conversa?: Record<string, unknown>;
  contato?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  automaticoDaOrg?: boolean | undefined;
  servidorDeVideo?: string | null;
  /** O que fica À VISTA — as ações do dia a dia. */
  visiveis: string[];
  /** O que mora no ⋯ — cada uma com ícone, nome e guia. */
  noMenu: string[];
}

const FILA: Cenario = {
  nome: "fila — conversa aberta e sem dono",
  visiveis: ["buscar-na-conversa", "acao-assumir", "acao-transferir", "acao-fechar"],
  noMenu: [
    "acao-ver-contato",
    "acao-chamar",
    "acao-reservar-servico",
    "btn-videochamada",
    "convidar-participante",
    "acao-lembrar",
    "acao-arquivar",
    "marcar-pessoal",
  ],
};

const MINHA_TRAVADA: Cenario = {
  nome: "minha, com o automático calado — o estado que devolve as duas voltas",
  conversa: {
    assigned_to_user_id: "u1",
    assignee_kind: "user",
    bot_silenced_until: new Date(Date.now() + 10 * 60_000).toISOString(),
  },
  visiveis: [
    "buscar-na-conversa",
    "acao-liberar",
    "devolver-ao-automatico",
    "acao-transferir",
    "acao-fechar",
  ],
  noMenu: [
    "acao-ver-contato",
    "acao-chamar",
    "acao-reservar-servico",
    "btn-videochamada",
    "convidar-participante",
    "acao-lembrar",
    "acao-arquivar",
    "marcar-pessoal",
  ],
};

const ENCERRADA: Cenario = {
  nome: "encerrada — o par Fechar/Reabrir vira Reabrir, e adiar sai de cena",
  conversa: { status: "closed" },
  visiveis: ["buscar-na-conversa", "acao-assumir", "acao-reabrir"],
  noMenu: [
    "acao-ver-contato",
    "acao-chamar",
    "acao-reservar-servico",
    "btn-videochamada",
    "convidar-participante",
    "acao-arquivar",
    "marcar-pessoal",
  ],
};

const COM_DONO_AUTO_DE_PE: Cenario = {
  nome: "com dono e o automático de pé — pausar é gesto PRÓPRIO aqui",
  conversa: { assigned_to_user_id: "u2", assignee_kind: "user" },
  visiveis: ["buscar-na-conversa", "acao-assumir", "acao-transferir", "acao-fechar"],
  noMenu: [
    "acao-ver-contato",
    "acao-chamar",
    "acao-reservar-servico",
    "btn-videochamada",
    "convidar-participante",
    "pausar-o-automatico",
    "acao-lembrar",
    "acao-arquivar",
    "marcar-pessoal",
  ],
};

const PESSOAL: Cenario = {
  nome: "contato marcado como pessoal — o par do menu inverte",
  contato: { is_personal: true },
  visiveis: ["buscar-na-conversa", "acao-assumir", "acao-transferir", "acao-fechar"],
  noMenu: [
    "acao-ver-contato",
    "acao-chamar",
    "acao-reservar-servico",
    "btn-videochamada",
    "convidar-participante",
    "acao-lembrar",
    "acao-arquivar",
    "desmarcar-pessoal",
  ],
};

const CENARIOS = [FILA, MINHA_TRAVADA, COM_DONO_AUTO_DE_PE, ENCERRADA, PESSOAL];

function montar(cenario: Cenario, abrirMenu = true) {
  // `activeOrg` existe porque `ReservarServicoNaConversa` exige papel de
  // atendente — é o mesmo gate da rota, e sem ele o item de agenda nem entra em
  // cena. O dublê devolve o MESMO formato do provider real.
  estado.auth = cenario.auth ?? {
    user: { id: "u1", support: null, is_platform_admin: true },
    activeOrg: { orgId: "org-1", role: "manager" },
  };
  estado.automaticoDaOrg = cenario.automaticoDaOrg ?? true;
  estado.servidorDeVideo = cenario.servidorDeVideo === undefined ? "https://meet.exemplo.com.br" : cenario.servidorDeVideo;

  const conversa = {
    id: "conv-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    status: "open",
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    snooze_until: null,
    service_revision: 3,
    is_group: false,
    last_inbound_at: null,
    tags: [],
    contacts: { ...CONTATO, ...cenario.contato },
    channel_sessions: null,
    ...cenario.conversa,
  } as unknown as ConversationWithContact;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resultado = render(
    <QueryClientProvider client={client}>
      <ConversationHeader conversation={conversa} onBuscar={() => {}} />
    </QueryClientProvider>,
  );

  // Radix DropdownMenuTrigger abre no `pointerdown` (não no `click`) — a mesma
  // receita de `tests/unit/snooze-button.test.tsx`.
  if (abrirMenu) {
    fireEvent.pointerDown(screen.getByTestId("menu-de-acoes"), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
    });
  }
  return resultado;
}

/** O conteúdo do ⋯, uma vez aberto. Ele é PORTAL: mora fora do header. */
async function conteudoDoMenu(): Promise<HTMLElement> {
  return await screen.findByTestId("menu-de-acoes-conteudo");
}

/** Separa o que está à vista do que está no menu, por PERTENCIMENTO ao DOM. */
function separar(header: HTMLElement, menu: HTMLElement) {
  const visiveis: string[] = [];
  const noMenu: string[] = [];
  for (const acao of ACOES) {
    const el = screen.queryByTestId(acao.id);
    if (el === null) continue;
    if (menu.contains(el)) noMenu.push(acao.id);
    else if (header.contains(el)) visiveis.push(acao.id);
  }
  return { visiveis: visiveis.sort(), noMenu: noMenu.sort() };
}

describe("#3003 — a barra enxuta: as ações do dia a dia ficam, o resto vai para o ⋯", () => {
  for (const cenario of CENARIOS) {
    it(`${cenario.nome}: ${cenario.visiveis.length} à vista, ${cenario.noMenu.length} no menu — e nenhuma a menos`, async () => {
      const { container } = montar(cenario);
      const header = container.firstElementChild;
      expect(header, "o cabeçalho não renderizou").toBeTruthy();
      const menu = await conteudoDoMenu();

      const { visiveis, noMenu } = separar(header as HTMLElement, menu);

      // O CONJUNTO EXATO, dos dois lados. Ação apagada do componente encolhe as
      // duas listas; ação que ficou nos dois lugares aparece nas duas.
      expect(visiveis, `as ações à vista do cenário "${cenario.nome}" mudaram`).toEqual(
        [...cenario.visiveis].sort(),
      );
      expect(noMenu, `as ações do menu no cenário "${cenario.nome}" mudaram`).toEqual(
        [...cenario.noMenu].sort(),
      );

      // A conta da issue: no máximo QUATRO ações do dia a dia à vista (a busca é
      // ferramenta de leitura, e é a quarta). A `main` oferecia 12 de uma vez.
      const acoesAVista = visiveis.filter((id) => id !== "buscar-na-conversa");
      expect(
        acoesAVista.length,
        `a barra voltou a encher: ${acoesAVista.length} ações à vista — a issue pede 3 ou 4`,
      ).toBeLessThanOrEqual(4);

      // E o menu não é enfeite: ele carrega o resto, com nome.
      expect(noMenu.length, "o menu ficou vazio — as ações sumiram, não mudaram de lugar").toBeGreaterThan(4);
    });
  }

  it("a união dos cenários cobre o INVENTÁRIO inteiro — é aqui que a ação removida do componente reprova", () => {
    // Sem este caso, apagar `acao-chamar` do componente deixaria os três
    // cenários verdes: cada um só confere o próprio conjunto, e o conjunto
    // esperado de cada um é escrito à mão. A união é conferida contra a LISTA
    // DE AÇÕES, que é a régua independente do código.
    const vistas = new Set<string>();
    for (const cenario of CENARIOS) {
      for (const id of [...cenario.visiveis, ...cenario.noMenu]) vistas.add(id);
    }
    expect(
      [...ACOES].map((a) => a.id).filter((id) => !vistas.has(id)),
      "ação do inventário que nenhum cenário oferece: ela saiu do componente, não do estado",
    ).toEqual([]);
    expect(vistas.size, "a união não pode ser maior que o inventário").toBe(ACOES.length);
  });

  it("o menu ⋯ não é opcional: sem ele, toda ação secundária desaparece da tela", async () => {
    // A catraca do #1625 afirmava o contrário — que um menu não podia existir.
    // Desde o #3003 a regra é a inversa: as ações secundárias SÓ podem estar
    // aqui, então o menu tem de existir em qualquer conversa, inclusive na que
    // não tem contato (onde "Ver contato" some, mas as outras não).
    // SEM abrir o menu: com ele aberto, o Radix é MODAL e marca `aria-hidden`
    // nos irmãos (`hideOthers`), então `getByRole` não acharia o próprio gatilho
    // — e a asserção passaria por ausência, não por acerto.
    const { container } = montar(FILA, false);
    const gatilho = screen.getByTestId("menu-de-acoes");
    expect(gatilho, "o cabeçalho não tem o menu ⋯ — as ações secundárias não têm para onde ir").toBeTruthy();
    // O nome acessível é "Mais", e NUNCA "Mais ações": a catraca
    // `inbox-header-nao-trava` procura este nome e reprova se ele existir.
    expect(gatilho.getAttribute("aria-label")).toBe("Mais");
    expect(container.querySelector('[aria-label="Mais ações"]')).toBeNull();
    // E ele é alcançável por nome, como qualquer outro controle do cabeçalho.
    expect(screen.getByRole("button", { name: "Mais" })).toBeTruthy();
  });
});

describe("#3003 — cada item do menu tem ícone, nome e uma guia que diz o EFEITO", () => {
  for (const cenario of CENARIOS) {
    it(`${cenario.nome}: os ${cenario.noMenu.length} itens do ⋯`, async () => {
      montar(cenario);
      const menu = await conteudoDoMenu();

      for (const id of cenario.noMenu) {
        const item = within(menu).getByTestId(id);
        const nome = (item.getAttribute("aria-label") ?? item.textContent ?? "").trim();
        expect(nome, `item sem nome no menu: ${item.outerHTML}`).not.toBe("");

        // ÍCONE: o `<svg>` do Phosphor. É o que a issue pede ("com ícone e nome")
        // e é o que diferencia a linha de menu de um botão empilhado.
        expect(
          item.querySelector("svg"),
          `"${nome}" está no menu sem ícone — a issue pede ícone e nome`,
        ).not.toBeNull();

        // GUIA: uma linha, no `title`, dizendo a CONSEQUÊNCIA. A régua é a mesma
        // do #3041 na barra, e ela não pode ser o rótulo repetido — um `title`
        // igual ao nome não responde "o que acontece se eu clicar aqui?".
        const guia = (item.getAttribute("title") ?? "").trim();
        expect(guia, `"${nome}" não tem guia curta no menu (#3003)`).not.toBe("");
        expect(guia, `a guia de "${nome}" repete o rótulo em vez de dizer o efeito`).not.toBe(nome.trim());
        expect(guia.length, `a guia de "${nome}" não é de uma linha`).toBeLessThan(160);
      }
    });
  }

  it("o menu não repete a barra: nenhuma ação aparece nos dois lugares", async () => {
    const { container } = montar(FILA);
    const menu = await conteudoDoMenu();
    const { visiveis, noMenu } = separar(container.firstElementChild as HTMLElement, menu);
    expect(
      visiveis.filter((id) => noMenu.includes(id)),
      "ação duplicada: ela está na barra E no menu",
    ).toEqual([]);
  });
});

describe("#3003 — o menu respeita as MESMAS condições da barra", () => {
  it("sem servidor de vídeo na instalação, o item de vídeo não existe (o guarda ficou no componente)", async () => {
    montar({ ...FILA, servidorDeVideo: null });
    const menu = await conteudoDoMenu();
    expect(
      within(menu).queryByTestId("btn-videochamada"),
      "o menu prometeu uma videochamada que a instalação não tem",
    ).toBeNull();
  });

  it("sem telefone no contato, o item de chamada não existe", async () => {
    montar({ ...FILA, contato: { phone_number: null } });
    const menu = await conteudoDoMenu();
    expect(within(menu).queryByTestId("acao-chamar")).toBeNull();
  });

  it("na conversa já arquivada, 'Arquivar' sai do menu — arquivar de novo não é gesto", async () => {
    montar({
      ...FILA,
      conversa: { status: "archived" },
      visiveis: ["buscar-na-conversa", "acao-assumir", "acao-reabrir"],
      noMenu: [
        "acao-ver-contato",
        "acao-chamar",
        "acao-reservar-servico",
        "btn-videochamada",
        "convidar-participante",
        "marcar-pessoal",
      ],
    });
    const menu = await conteudoDoMenu();
    expect(within(menu).queryByTestId("acao-arquivar")).toBeNull();
    expect(within(menu).queryByTestId("marcar-pessoal")).toBeTruthy();
  });
});

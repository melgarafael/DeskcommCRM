import { existsSync, readFileSync } from "node:fs";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser } from "@playwright/test";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A FICHA DO CONTATO ENTRE 768 E 1279px (#4822).
 *
 * ─── O defeito, medido na issue ──────────────────────────────────────────────
 *
 * A terceira coluna do Inbox só nasce no `xl` (1280px) — decisão medida e
 * documentada em `InboxLayout.tsx`, que este arquivo NÃO discute. O problema era
 * a faixa do meio: a gaveta da ficha existia, mas a única porta morava dentro da
 * barra `md:hidden`, ou seja, abaixo de 768px. Quem atendia numa janela de
 * ~1230px ficava sem coluna E sem botão, e a seção de follow-up — que só é
 * montada dentro do painel — não tinha por onde ser alcançada.
 *
 * ─── O que este arquivo prova, e como ───────────────────────────────────────
 *
 * Duas camadas, porque são duas perguntas diferentes:
 *
 * 1. `gaveta` (jsdom, roda sempre, inclusive no CI): a porta da faixa do meio
 *    existe, ABRE a gaveta, e a gaveta é a MESMA — um `dialog` só, com a ficha
 *    do contato e com a seção de follow-up dentro. É a metade "abre e mostra o
 *    que faltava", que não depende de largura.
 *
 * 2. `faixas` (browser real, CSS do repo): a que LARGURA cada porta aparece.
 *    `display: none` por media query não existe em jsdom — lá tudo é visível e o
 *    teste passaria por ausência de motor, o pior verde que existe (a mesma
 *    decisão de `tests/sonda-abas-inbox-1280.test.tsx`). Medir isso por leitura
 *    de `className` também não vale: provaria que a classe foi escrita, não que
 *    o CSS compilado a aplica. Por isso as três faixas são asserções sobre o
 *    `getComputedStyle` de um Chromium com o Tailwind do próprio repo.
 *
 *    Exige Chromium e compila o Tailwind inteiro (~1 min), então o gate é uma
 *    variável de ambiente — o CI unitário não tem browser, e teste que fica
 *    vermelho por falta de browser ensina o time a ignorar o vermelho:
 *
 *      SONDA_FICHA_4822=1 CHROME_BIN=/caminho/chrome \
 *        pnpm exec vitest run tests/sonda-ficha-entre-md-e-xl-4822.test.tsx
 *
 *    Sem a variável o caso aparece como `skipped`, que é a foto honesta de "não
 *    medi" — não confundir com verde.
 */

const get = vi.hoisted(() => vi.fn());
const togglePainelDoContato = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/app/actions/inbox/togglePainelDoContato", () => ({ togglePainelDoContato }));

const ORG = "00000000-0000-4000-8000-0000000005aa";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "cv-1";

const conversa = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: CONTATO,
  channel_session_id: "cs-1",
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  assigned_to_user_name: null,
  assignee_kind: "ai",
  bot_silenced_until: null,
  snooze_until: null,
  service_revision: 1,
  is_group: false,
  current_demanda_id: null,
  last_inbound_at: "2026-09-15T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: { provider: "waha" },
  contacts: {
    id: CONTATO,
    display_name: "Fulana",
    name: null,
    phone_number: "5511999",
    tags: [],
    is_blocked: false,
    is_personal: false,
    is_anonymized: false,
    force_human: false,
  },
};

const resumo = {
  data: {
    leads: [
      {
        id: "l-1",
        title: "Felipe",
        status: "open",
        value_cents: null,
        currency: null,
        updated_at: "2026-09-15T12:00:00Z",
        pipeline_id: "p-1",
        stage_id: "s-1",
        custom_fields: {},
        field_defs: [],
        funil_nome: "Origem",
        etapa_nome: "Novo",
        etapas_do_funil: [{ id: "s-1", name: "Novo", is_won: false, is_lost: false }],
      },
    ],
    orders: [],
    activities: [],
    demandas: [],
    fatos: [],
    historico: [],
  },
};

/**
 * O `get` único do painel cobre três leituras. O follow-up só aparece na tela
 * com enrollment vivo OU com fluxo ativo + `meta.pode_inscrever` — é o próprio
 * contrato do componente (`FollowupDoContato`), e é ele que faz a seção existir
 * na gaveta. Sem essa resposta o teste passaria com a seção auto-oculta e não
 * provaria nada sobre o follow-up.
 */
get.mockImplementation(async (url?: string) => {
  const bruto = url ?? "";
  if (bruto === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (bruto.includes("/api/v1/ai/followups/enrollments")) {
    return { data: [], meta: { pode_inscrever: true } };
  }
  if (bruto.includes("/api/v1/ai/followup-flows")) {
    return {
      data: [{ id: "fl-1", name: "Reativação 7 dias", status: "active", active_version_id: "v-1" }],
    };
  }
  if (bruto.includes("crm-summary")) return resumo;
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({
  useConversationsRealtime: () => ({
    data: { pages: [{ data: [conversa] }] },
    realtimeStatus: "ok",
    seguranca: { divergencias: 0 },
  }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// Irmãs do Inbox: trazem fetch próprio e não são o alvo.
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/inbox/NumeroForaDoAr", () => ({ NumeroForaDoAr: () => null }));
vi.mock("@/components/inbox/PainelIniciarConversa", () => ({ BotaoIniciarConversa: () => null }));
vi.mock("@/components/inbox/TarefasDaDemanda", () => ({ TarefasDaDemanda: () => null }));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));

// O CABEÇALHO É REAL — é ele que desenha a porta nova. Seus dublês são de
// fronteira (rede, sessão, configuração da instalação), nenhum do componente.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", role: "admin", support: null, is_platform_admin: true },
    activeOrg: { orgId: ORG, name: "Org", role: "admin" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
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
vi.mock("@/hooks/inbox/useIaComDono", () => ({ useIaComDono: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useSnoozeConversation", () => ({
  useSnoozeConversation: () => ({
    snooze: { mutate: vi.fn(), isPending: false },
    cancel: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: true }) }));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: { configured: false, paired: false } }),
}));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startCall: vi.fn() }),
}));
vi.mock("@/lib/video/jitsi", () => ({
  servidorDeVideo: () => null,
  novaSala: () => "sala",
  urlDaSala: () => null,
}));
vi.mock("@/hooks/inbox/useParticipantesDaConversa", () => ({
  useParticipantesDaConversa: () => ({ data: [] }),
  useConvidarParticipante: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoverParticipante: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  chaveDosParticipantes: () => ["participantes"],
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
// Peças do painel que trazem fetch/rede própria e não são o alvo.
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

beforeAll(() => {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: 1040,
      left: 0,
      right: 1040,
      top: 0,
      bottom: 800,
      x: 0,
      y: 0,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect;
  };
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONVERSA} painelRecolhidoInicial={false} />
    </QueryClientProvider>,
  );
}

describe("gaveta da ficha — a porta da faixa do meio abre a MESMA ficha (#4822)", () => {
  it("a porta existe no cabeçalho, com nome acessível e a guia da ficha", async () => {
    montar();
    const porta = await screen.findByTestId("acao-abrir-ficha");
    expect(porta, "o cabeçalho da conversa está sem a porta da ficha").toBeTruthy();
    // Nome acessível é o rótulo visível: quem procura "Ficha" acha pelo leitor
    // de tela também. A guia diz de QUE ficha se trata (a do contato).
    expect(porta.textContent?.trim()).toBe("Ficha");
    expect(porta.getAttribute("title")?.trim(), "a porta está sem guia").toBeTruthy();
  });

  it("clicar nela abre a gaveta com a ficha E com o follow-up", async () => {
    montar();
    expect(screen.queryByRole("dialog"), "a gaveta já nasce aberta").toBeNull();
    fireEvent.click(await screen.findByTestId("acao-abrir-ficha"));

    const gaveta = await screen.findByRole("dialog");
    // A ficha (o painel do contato) e, dentro dela, a seção que a issue diz ter
    // ficado inalcançável entre 768 e 1279px.
    await waitFor(() => expect(within(gaveta).getByTestId("inbox-contato")).toBeTruthy());
    await waitFor(() => expect(within(gaveta).getByTestId("inbox-followup")).toBeTruthy());
    expect(within(gaveta).getByText("Follow-up")).toBeTruthy();
  });

  it("a barra do celular abre a MESMA gaveta — um diálogo só, nunca dois", async () => {
    montar();
    fireEvent.click(await screen.findByTestId("ficha-no-celular"));
    const gaveta = await screen.findByRole("dialog");
    expect(
      screen.getAllByRole("dialog").length,
      "há mais de uma gaveta montada — a ficha foi duplicada em vez de reusada",
    ).toBe(1);
    // Uma ficha DENTRO da gaveta. A terceira coluna também tem a sua no DOM (ela
    // é montada e o CSS é quem a esconde fora do `xl`), por isso a conta é aqui
    // dentro; quem separa as portas por largura é a sonda de faixas.
    expect(within(gaveta).getAllByTestId("inbox-contato")).toHaveLength(1);
  });

  it("fechar a gaveta devolve a tela ao estado de antes", async () => {
    montar();
    fireEvent.click(await screen.findByTestId("acao-abrir-ficha"));
    const gaveta = await screen.findByRole("dialog");
    fireEvent.keyDown(gaveta, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // Sem `SheetTrigger`, o Radix não sabe quem abriu a gaveta e o foco cai no
  // `body` ao fechar: quem navega por teclado perde o lugar. Cada porta tem de
  // receber o foco de volta — a do cabeçalho e a da barra do celular.
  it.each(["acao-abrir-ficha", "ficha-no-celular"])(
    "fechar com Esc devolve o foco à porta que abriu (%s)",
    async (testid) => {
      montar();
      const porta = await screen.findByTestId(testid);
      expect(porta.getAttribute("aria-haspopup")).toBe("dialog");
      expect(porta.getAttribute("aria-expanded")).toBe("false");
      porta.focus();
      fireEvent.click(porta);
      const gaveta = await screen.findByRole("dialog");
      expect(porta.getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(gaveta, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(
          (document.activeElement as HTMLElement | null)?.dataset.testid,
          "o foco não voltou à porta que abriu a ficha",
        ).toBe(testid),
      );
      expect(porta.getAttribute("aria-expanded")).toBe("false");
    },
  );
});

/* ─────────────────────────── as três faixas ─────────────────────────────── */

const ESPERADO = [
  // largura, porta do celular, porta do cabeçalho, coluna da ficha
  { largura: 767, celular: true, cabecalho: false, coluna: false },
  { largura: 768, celular: false, cabecalho: true, coluna: false },
  { largura: 1024, celular: false, cabecalho: true, coluna: false },
  { largura: 1100, celular: false, cabecalho: true, coluna: false },
  { largura: 1279, celular: false, cabecalho: true, coluna: false },
  { largura: 1280, celular: false, cabecalho: false, coluna: true },
  { largura: 1440, celular: false, cabecalho: false, coluna: true },
] as const;

function chromeBinario(): string {
  const candidatos = [process.env.CHROME_BIN, process.env.CHROMIUM_BIN].filter(
    (x): x is string => !!x,
  );
  for (const binario of candidatos) if (existsSync(binario)) return binario;
  throw new Error(
    "Sem Chromium. Aponte CHROME_BIN — esta sonda NÃO pula por falta de browser: " +
      "medir media query sem motor é o verde por ausência de motor que ela evita.",
  );
}

async function compilarCssDoProduto(): Promise<string> {
  const origem = "app/globals.css";
  const resultado = await postcss([tailwind()]).process(readFileSync(origem, "utf8"), { from: origem });
  return resultado.css;
}

/** `display` computado 0 é o que "não existe na tela" significa numa media query. */
const VISIVEL = `(el) => {
  if (!el) return false;
  const estilo = getComputedStyle(el);
  if (estilo.display === "none" || estilo.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}`;

const ARMADA = process.env.SONDA_FICHA_4822 === "1";

describe("faixas — quem abre a ficha em cada largura de viewport (#4822)", () => {
  it.skipIf(!ARMADA)(
    "abaixo de 768: barra do celular · 768–1279: botão do cabeçalho · 1280+: coluna, sem botão",
    async () => {
      const css = await compilarCssDoProduto();
      const { container } = montar();
      const html = container.innerHTML;
      expect(html, "o InboxLayout não renderizou nada").toContain("acao-abrir-ficha");

      let browser: Browser | null = null;
      const medidas: Array<Record<string, unknown>> = [];
      try {
        browser = await chromium.launch({ executablePath: chromeBinario() });
        const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
            `<body style="margin:0;--faixas-de-cima:0px;--space-6:24px;--rodape-ocupado:0px">` +
            `<div id="raiz">${html}</div></body></html>`,
        );

        for (const faixa of ESPERADO) {
          await page.setViewportSize({ width: faixa.largura, height: 900 });
          medidas.push(
            await page.evaluate(
              `(() => {
                const visivel = ${VISIVEL};
                const celular = document.querySelector('[data-testid="ficha-no-celular"]');
                const cabecalho = document.querySelector('[data-testid="acao-abrir-ficha"]');
                const coluna = document.querySelector('[data-testid="ficha-em-coluna"]');
                const barra = document.querySelector('[data-testid="menu-de-acoes"]')?.parentElement ?? null;
                return {
                  largura: window.innerWidth,
                  celular: visivel(celular),
                  cabecalho: visivel(cabecalho),
                  coluna: visivel(coluna),
                  // A barra de ações não pode passar a rolar por causa da porta nova.
                  transbordoDaBarra: barra ? barra.scrollWidth - barra.clientWidth : 0,
                };
              })()`,
            ),
          );
        }
      } finally {
        await browser?.close();
      }

      // `info`, e não `log`: o `no-console` do projeto só deixa warn/error/info.
      console.info("\n#4822 — quem abre a ficha, por largura (Chromium + CSS do repo)");
      for (const m of medidas) {
        console.info(
          `viewport=${String(m.largura).padStart(4)}px ` +
            `celular=${m.celular ? "sim" : "não"} ` +
            `cabeçalho=${m.cabecalho ? "sim" : "não"} ` +
            `coluna=${m.coluna ? "sim" : "não"} ` +
            `transbordo=${m.transbordoDaBarra}px`,
        );
      }

      expect(medidas, "nenhuma faixa foi medida").toHaveLength(ESPERADO.length);
      for (const [i, faixa] of ESPERADO.entries()) {
        // `medidas` tem uma linha por faixa (asserção acima); o índice existe.
        const m = medidas[i] as Record<string, unknown>;
        expect(
          { celular: m.celular, cabecalho: m.cabecalho, coluna: m.coluna },
          `em ${faixa.largura}px a porta da ficha não é a esperada`,
        ).toEqual({ celular: faixa.celular, cabecalho: faixa.cabecalho, coluna: faixa.coluna });
      }

      // Nenhuma largura pode mostrar DUAS fichas ao mesmo tempo: é o defeito
      // simétrico (duplicar em vez de faltar) que a saída 1 poderia criar.
      for (const m of medidas) {
        const quantas = [m.celular, m.cabecalho, m.coluna].filter(Boolean).length;
        expect(quantas, `em ${m.largura}px há ${quantas} portas/colunas de ficha à vista`).toBe(1);
      }

      // A faixa do meio é apertada: a porta nova não pode fazer a barra rolar.
      for (const m of medidas.filter((x) => Number(x.largura) >= 768 && Number(x.largura) < 1280)) {
        expect(
          Math.round(Number(m.transbordoDaBarra)),
          `em ${m.largura}px a barra de ações transborda — a porta nova empurrou o cabeçalho`,
        ).toBeLessThanOrEqual(0);
      }
    },
    180_000,
  );
});

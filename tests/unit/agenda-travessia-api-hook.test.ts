/**
 * A TRAVESSIA API → HOOK DA AGENDA — os NOMES dos campos, sob gate.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────────
 *
 * `hooks/agenda/useAgendamentos.ts` declara a forma da resposta À MÃO
 * (`interface AgendamentoListado`, uma cópia) e desembrulha o envelope com
 * `as unknown as`. As duas coisas juntas apagam o compilador da travessia: se
 * `lib/agenda/consulta.ts` renomear `contatoNome`, **nada fica vermelho** — nem
 * `pnpm typecheck`, nem runtime. O hook devolve `undefined` naquele campo, a
 * grade desenha o bloco sem dizer de quem é o compromisso, e ninguém é avisado.
 *
 * Não é hipótese: `quemSeraAtendido` JÁ se perdeu uma vez nesta entrega — o
 * `contact_id` vinha no select do servidor e morria no `.map`, e como
 * `dados-de-mentira.ts` preenche o campo nos 11 cards, a tela pareceu pronta o
 * tempo todo (ver o comentário longo em `app/app/agenda/page.tsx`).
 *
 * ─── Como a cerca prende, em duas camadas ────────────────────────────────────
 *
 * (a) COMPILAÇÃO: o fixture é anotado com o `AgendamentoListado` que
 *     `lib/agenda/consulta.ts` EXPORTA — o tipo do produtor, não a cópia do
 *     consumidor. Renomear um campo lá deixa o fixture com propriedade a mais e
 *     propriedade faltando, e `pnpm typecheck` reprova. É o alarme que hoje não
 *     existe.
 * (b) RUNTIME: o mesmo fixture atravessa o `ok()` REAL (o envelope que a rota
 *     devolve) e o hook REAL. Quem "consertar" o fixture para calar o tsc sem
 *     mexer no `.map` do hook cai aqui: o campo chega `undefined`.
 *
 * Escolhi (a) em vez de varrer os dois arquivos por texto porque as duas pontas
 * importam sem subir banco — a consulta entra como `import type` (não carrega
 * `@supabase/supabase-js`) e o hook só depende de `apiClient`. Varredura de
 * texto compara nomes; isto compara TIPOS, e ainda exercita o `.map` de verdade.
 *
 * ─── Medir ───────────────────────────────────────────────────────────────────
 *
 *   cd /Users/rafaelmelgaco/wt/cal-integra
 *   npx vitest run tests/unit/agenda-travessia-api-hook.test.ts && pnpm typecheck
 *
 * Para ver a camada (a) morder, renomeie `contatoNome` em
 * `lib/agenda/consulta.ts` e rode `pnpm typecheck`. Para ver a (b), apague a
 * linha `quemSeraAtendido:` do `.map` do hook e rode o vitest.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Agendamento } from "@/components/agenda/tipos";
import type { AgendamentoListado } from "@/lib/agenda/consulta";
import { ok } from "@/lib/api/wrappers";

const getSpy = vi.fn(async (_url: string): Promise<unknown> => ({ data: [] }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => getSpy(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAgendamentos } from "@/hooks/agenda/useAgendamentos";

const RECORTE = { de: "2026-09-01T03:00:00.000Z", ate: "2026-09-08T03:00:00.000Z" };

/**
 * O compromisso como a CONSULTA o produz.
 *
 * A anotação é a camada (a) da cerca — não é enfeite de tipagem. Trocar por
 * `satisfies`, por um literal solto ou por `as AgendamentoListado` desliga o
 * alarme de compilação e deixa só metade da cerca em pé.
 */
const MARIA: AgendamentoListado = {
  id: "ag-1",
  titulo: "Consulta",
  iniciaEm: "2026-09-02T13:00:00.000Z",
  terminaEm: "2026-09-02T13:30:00.000Z",
  fuso: "America/Sao_Paulo",
  situacao: "confirmed",
  donoId: "u-ana",
  contatoId: "c-maria",
  contatoNome: "Maria Ferraz",
  convidadosDaEquipe: ["u-bia"],
};

/** O corpo EXATO do wire: `ok()` é o mesmo wrapper que a rota chama no `return`. */
async function corpoDaRota(agendamentos: AgendamentoListado[]): Promise<unknown> {
  return (await ok(agendamentos).json()) as unknown;
}

function novoWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/**
 * O único compromisso da resposta.
 *
 * `const [bloco] = lista` deixaria `bloco` possivelmente `undefined` e o tsc
 * (com `noUncheckedIndexedAccess`) cobraria um `!` em cada asserção — o `!` que
 * transformaria "a grade não recebeu nada" em erro de linha, não em falha
 * legível. Aqui a ausência falha PRIMEIRO, com a frase certa.
 */
function unico(lista: Agendamento[]): Agendamento {
  expect(
    lista.length,
    "a rota devolveu um compromisso e a grade recebeu outra coisa — sem este " +
      "corte, toda asserção abaixo mediria `undefined` e diria a consequência errada",
  ).toBe(1);
  return lista[0] as Agendamento;
}

/** O que a GRADE recebe quando a rota responde `corpo`. */
async function oQueAGradeRecebe(corpo: unknown): Promise<Agendamento[]> {
  getSpy.mockResolvedValueOnce(corpo);
  const { result } = renderHook(() => useAgendamentos(RECORTE), { wrapper: novoWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o compromisso atravessa a rota até a grade", () => {
  it("todo campo que a consulta PRODUZ e a grade desenha chega com valor", async () => {
    // O escopo é o que atravessa: os campos que existem nas DUAS pontas.
    // `Agendamento.origem` fica FORA de propósito, e não porque foi esquecido —
    // `AgendamentoListado` não o carrega, então o hook o crava `"ui"`. Não é
    // travessia perdida, é campo que nunca partiu: `calendar_appointments.source`
    // existe no banco (migration 0177) e não entra no select da consulta. Uma
    // asserção aqui só congelaria o `"ui"` cravado — o conserto é a consulta
    // devolver `source`, e aí este caso ganha a linha que hoje seria mentira.
    const bloco = unico(await oQueAGradeRecebe(await corpoDaRota([MARIA])));

    expect(bloco.id, "sem id a grade não sabe qual bloco foi clicado, e abrir um abre outro").toBe(
      "ag-1",
    );
    expect(bloco.titulo, "bloco sem título na grade é um retângulo mudo").toBe("Consulta");
    expect(
      bloco.responsavelId,
      "é o responsável que decide a COR e a coluna do bloco — sem ele todos " +
        "os compromissos do dia caem na mesma trilha e a agenda da equipe vira uma pilha",
    ).toBe("u-ana");
    expect(
      bloco.convidadosDaEquipe,
      "sem a lista, 'ver só a agenda de' esconde o compromisso de quem foi convidado",
    ).toEqual(["u-bia"]);
    expect(
      bloco.comeca,
      "sem início o bloco não tem onde pousar na grade e o horário some da tela",
    ).toBe("2026-09-02T13:00:00.000Z");
    expect(
      bloco.termina,
      "sem fim a altura do bloco não existe: o horário parece livre e alguém marca por cima",
    ).toBe("2026-09-02T13:30:00.000Z");
    expect(
      bloco.situacao,
      "sem situação o cancelado é desenhado igual ao confirmado, e o paciente " +
        "cancelado continua ocupando o horário aos olhos de quem atende",
    ).toBe("confirmed");
  });

  it("quemSeraAtendido ← contatoNome: a grade diz DE QUEM é o compromisso", async () => {
    const bloco = unico(await oQueAGradeRecebe(await corpoDaRota([MARIA])));

    expect(
      bloco.quemSeraAtendido,
      'este é o campo que já se perdeu uma vez: sem ele o card diz "Consulta" e ' +
        "não diz com quem — quem atende abre a tela e não sabe quem vai chegar",
    ).toBe("Maria Ferraz");
  });

  it("...e o PAR: sem contato, o campo fica AUSENTE — nunca 'null' escrito na tela", async () => {
    // O outro lado. Sem ele, um `quemSeraAtendido` cravado passaria no caso
    // acima e a cerca não valeria nada.
    const bloco = unico(
      await oQueAGradeRecebe(await corpoDaRota([{ ...MARIA, contatoId: null, contatoNome: null }])),
    );

    expect(
      bloco.quemSeraAtendido,
      'compromisso sem contato (bloqueio, reunião interna) precisa chegar ausente: ' +
        'a string "null" viraria o nome do paciente na grade',
    ).toBeUndefined();
  });
});

describe("controle de vacuidade — a sonda enxerga a divergência", () => {
  it("nome de campo divergente: o valor SOME e ninguém é avisado", async () => {
    // Este caso É o instrumento se auto-medindo: ele encena exatamente o defeito
    // que o cabeçalho descreve — a rota renomeia `contatoNome` — e mostra que o
    // desfecho é silêncio. Se ele ficasse verde com o nome preservado, os casos
    // acima estariam passando por outro caminho e não provariam nada.
    const { contatoNome, ...semONome } = MARIA;
    const corpoRenomeado = await corpoDaRota([
      { ...semONome, contato_nome: contatoNome } as unknown as AgendamentoListado,
    ]);

    const bloco = unico(await oQueAGradeRecebe(corpoRenomeado));

    expect(bloco.id, "o compromisso continua chegando — é isso que torna a perda invisível").toBe(
      "ag-1",
    );
    expect(
      bloco.quemSeraAtendido,
      "com o campo renomeado o nome evapora na travessia: é ESTE o desfecho que a " +
        "cerca existe para transformar em vermelho antes do merge",
    ).toBeUndefined();
    expect(
      vi.mocked(showApiError),
      "e não há toast, não há erro, não há log: a tela mostra a agenda inteira " +
        "com um campo a menos e ninguém tem como perceber",
    ).not.toHaveBeenCalled();
  });

  it("o corpo que os casos usam tem CONTEÚDO — não estou medindo lista vazia", async () => {
    // O controle do controle: se `ok()` mudasse de envelope, os casos acima
    // falhariam em `unico()` — vermelho certo, motivo errado, e alguém iria
    // procurar o defeito no hook. Esta asserção é sobre o INSTRUMENTO, não
    // sobre o produto, e é ela que separa os dois diagnósticos.
    const corpo = (await corpoDaRota([MARIA])) as { data?: unknown[] };
    expect(Array.isArray(corpo.data), "o wrapper `ok()` embrulha em `data` — é o que o hook lê").toBe(
      true,
    );
    expect(corpo.data?.length).toBe(1);
  });
});

describe("envelope quebrado falha ALTO, nunca vira 'nada marcado'", () => {
  it("resposta sem `data` derruba a query em vez de devolver lista vazia", async () => {
    // Guarda o `as unknown as` do hook contra o "conserto" que parece defensivo:
    // trocar o desembrulho por um `?? []` calaria o erro e a grade diria "nada
    // marcado" para uma agenda cheia — a pessoa concluiria que o dia está livre.
    getSpy.mockResolvedValueOnce({ resultado: [MARIA] });
    const { result } = renderHook(() => useAgendamentos(RECORTE), { wrapper: novoWrapper() });

    // Esperar ASSENTAR e só então perguntar pelo erro — não `waitFor(isError)`.
    // Medido: com o desembrulho trocado por `?? []`, a versão anterior morria
    // no timeout do `waitFor` com "expected false to be true" depois de 1012ms,
    // e as duas frases abaixo — as que dizem a CONSEQUÊNCIA — nunca eram
    // impressas. Quem quebrasse o envelope leria um vermelho mudo.
    await waitFor(() =>
      expect(
        result.current.isPending,
        "a query nunca assentou: nem sucesso nem erro — o hook ficou pendurado",
      ).toBe(false),
    );

    expect(
      result.current.isError,
      "envelope que o hook não entende tem de DERRUBAR a leitura: engolir com " +
        "lista vazia desenha agenda cheia como dia livre, e alguém marca por " +
        "cima de uma consulta que existe",
    ).toBe(true);
    expect(
      result.current.data,
      "lista vazia aqui seria a pior resposta possível: agenda cheia desenhada " +
        "como dia livre, e alguém marca por cima de uma consulta que existe",
    ).toBeUndefined();
    expect(
      vi.mocked(showApiError),
      "quem abriu a tela precisa ver que a leitura falhou — falha fechada na " +
        "ação, aberta na informação",
    ).toHaveBeenCalled();
  });
});

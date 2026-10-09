import { readFileSync } from "node:fs";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * O atalho do quadro para o inbox, com prévia da última mensagem.
 *
 * ─── Por que atalho e não um composer no card ───────────────────────────────
 *
 * Responder de dentro do quadro exigiria uma segunda cópia do composer —
 * anexos, templates, notas, áudio. Duas cópias divergem: a correção entra numa
 * e não na outra, e o atendente aprende que "no Kanban não funciona igual".
 *
 * ─── O que os casos vigiam ──────────────────────────────────────────────────
 *
 * Metade prova que o slot SOME quando não há conversa — lead criado à mão não
 * tem contato, e um "sem mensagens" cinza em metade dos cards ocuparia a linha
 * para não dizer nada. Lead com CONTATO mas sem conversa é outro caso, e virou
 * a ação "Abrir conversa" da #1993: ele tem contrato próprio, em
 * `components/kanban/ConversaSlot.test.tsx`.
 *
 * O resto vigia o gesto: o card inteiro é arrastável e abre o dossiê ao clicar,
 * então o atalho precisa parar a propagação — senão um clique tem dois
 * destinos.
 */
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ConversaSlot } from "@/components/kanban/ConversaSlot";
import type { Lead } from "@/lib/types/leads";

const conversa = (over: Partial<NonNullable<Lead["conversa"]>> = {}) =>
  ({
    id: "conv-1",
    preview: "Quiero saber el precio",
    last_message_at: new Date().toISOString(),
    unread: 0,
    ...over,
  }) as NonNullable<Lead["conversa"]>;

describe("mostra a última mensagem", () => {
  it("pinta a prévia — sem ela o atalho é uma aposta", () => {
    render(<ConversaSlot conversa={conversa()} />);
    expect(screen.getByText("Quiero saber el precio")).toBeInTheDocument();
  });

  it("aponta para o inbox NESTA conversa", () => {
    render(<ConversaSlot conversa={conversa()} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/inbox?id=conv-1");
  });

  it("mostra o NÚMERO de não lidas, não um ponto", () => {
    // "3 sem ler" e "12 sem ler" pedem urgências diferentes; um ponto colapsa
    // as duas.
    render(<ConversaSlot conversa={conversa({ unread: 12 })} />);
    expect(screen.getByLabelText("12 sem ler")).toHaveTextContent("12");
  });

  it("sem não lidas não pinta contador", () => {
    render(<ConversaSlot conversa={conversa({ unread: 0 })} />);
    expect(screen.queryByLabelText(/sem ler/)).not.toBeInTheDocument();
  });

  it("conversa existente mas vazia diz isso, em vez de linha em branco", () => {
    render(<ConversaSlot conversa={conversa({ preview: null })} />);
    expect(screen.getByText("conversa sem mensagens")).toBeInTheDocument();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });
});

describe("some quando não há conversa", () => {
  it("lead sem conversa E sem contato não renderiza NADA", () => {
    // Criado à mão, sem contato: um "sem mensagens" cinza em metade dos cards
    // ocuparia a linha para não dizer nada — e sem alvo não há ação a oferecer.
    const { container } = render(<ConversaSlot conversa={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("conversa indefinida (ainda não carregou) também não renderiza", () => {
    const { container } = render(<ConversaSlot conversa={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("o gesto não colide com o card", () => {
  it("o clique NÃO sobe para o card — senão abriria o dossiê junto", () => {
    const noCard = vi.fn();
    render(
      <div onClick={noCard}>
        <ConversaSlot conversa={conversa()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("link"));
    expect(noCard).not.toHaveBeenCalled();
  });

  it("o pointerdown também não sobe — o card é arrastável", () => {
    const noCard = vi.fn();
    render(
      <div onPointerDown={noCard}>
        <ConversaSlot conversa={conversa()} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole("link"));
    expect(noCard).not.toHaveBeenCalled();
  });
});

describe("o elo que some sem barulho", () => {
  it("a rota do quadro anexa a conversa — sem isso o slot nunca tem o que mostrar", () => {
    // O componente pode estar perfeito e nunca aparecer, porque o dado não
    // chega. Mesma classe do filtro por `tag`: o defeito mora no arquivo que
    // ninguém testou.
    const fonte = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");
    expect(fonte, "falta withConversas").toContain("withConversas");
    expect(fonte, "withConversas não foi chamada").toMatch(
      /leadsComConversa\s*=\s*await withConversas/,
    );
    // Chamar e não USAR o resultado é o defeito de verdade: a função roda, o
    // custo se paga, e a resposta sai sem a conversa. A primeira versão deste
    // caso só olhava a chamada e o sabote passou.
    //
    // A resposta não sai mais direto de `withConversas`: a cadeia é
    // withConversas → withMarcadoresDoContato → resposta. Exigir o texto
    // `leads: leadsComConversa.leads` reprovava quem acrescentava uma etapa
    // CERTA depois dela; o que importa é o resultado dela alimentar a próxima,
    // e a resposta sair da última.
    expect(
      fonte,
      "o resultado de withConversas não alimenta withMarcadoresDoContato (cadeia: withConversas → withMarcadoresDoContato → resposta)",
    ).toMatch(/withMarcadoresDoContato\(\s*supabase,[\s\S]*?leadsComConversa\.leads/);
    expect(
      fonte,
      "a resposta não sai da última etapa (cadeia: withConversas → withMarcadoresDoContato → resposta)",
    ).toMatch(/leads:\s*leadsComMarcadores\.leads/);
  });

  it("contato SEM conversa sai como `null`, não ausente — senão \"Abrir conversa\" nunca aparece (#1993)", () => {
    // O slot e o dossiê só pintam a ação com `conversa === null`; `undefined` é
    // "ainda não carregou" e fica mudo. A primeira versão do #2207 testava o
    // componente com `conversa={null}` direto, um valor que a rota não produzia:
    // ela fazia `...(conversa ? { conversa } : {})` e o campo saía AUSENTE. O
    // componente estava certo e o botão nunca aparecia no quadro de verdade.
    const fonte = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");
    const corpo = fonte.slice(fonte.indexOf("async function withConversas"));
    const daFuncao = corpo.slice(0, corpo.indexOf("\n}\n"));
    // Lead sem contato continua sem o campo: ele sai antes, e é ausência legítima.
    expect(daFuncao).toMatch(/if \(!lead\.contact_id\) return lead;/);
    expect(daFuncao, "contato sem conversa precisa virar `conversa: null`").toMatch(
      /conversa:\s*conversa\s*\?\?\s*null/,
    );
    expect(daFuncao, "espalhar condicional deixa o campo ausente (undefined)").not.toMatch(
      /\.\.\.\(conversa\s*\?/,
    );
  });

  it("a mais RECENTE por contato — não a primeira que o banco devolver", () => {
    const fonte = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");
    expect(fonte).toMatch(/order\("last_message_at",\s*\{\s*ascending:\s*false/);
  });

  it("o card renderiza o slot", () => {
    const fonte = readFileSync("components/kanban/KanbanCard.tsx", "utf8");
    // A prévia E a ação "Abrir conversa" (#1993) saem do mesmo slot: o card
    // passa os dois dados do contato para ele decidir qual dos dois pintar.
    expect(fonte).toMatch(/<ConversaSlot\s+conversa=\{lead\.conversa\}/);
    expect(fonte).toContain("contactId={lead.contact_id}");
    expect(fonte).toContain("phone={lead.contact_phone}");
  });
});

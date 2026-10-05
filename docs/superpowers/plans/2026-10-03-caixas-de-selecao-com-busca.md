# Caixas de seleção com busca — Plano de implementação

> **Para agentes que forem executar:** SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** as caixas de seleção do CRM cuja lista cresce com o uso (modelos de IA, credenciais, atendentes, etapas, agentes) ganham uma barra de busca: a pessoa digita "sonnet" e acha o modelo, em vez de rolar a lista procurando no olho.

**Arquitetura:** um componente novo, `SearchableSelect` (`components/ui/searchable-select.tsx`), feito com o `Popover` do Radix que já está instalado e uma lista `role="listbox"` escrita à mão — o mesmo padrão de acessibilidade de `components/agenda/VinculoDaMarcacao.tsx`. A filtragem é uma função pura (`lib/ui/filtrar-opcoes.ts`) que reaproveita `normalizar` de `lib/catalogo/busca.ts` (ignora acento, caixa e pontuação). A busca só aparece quando a lista tem `MINIMO_PARA_BUSCA` (8) opções ou mais, então migrar lista curta não piora nada. O gatilho mantém `role="combobox"` e as opções `role="option"`, como o `Select` do Radix — os testes e specs e2e que já procuram por esses papéis continuam valendo. Por último, uma cerca com lista que **só encolhe** impede caixa nova de lista dinâmica sem busca e mostra o que ainda falta migrar.

**Stack:** Next.js 16 App Router, React 19, TypeScript estrito, Tailwind 4, Radix Popover (`@radix-ui/react-popover`), ícones Phosphor via `@/lib/ui/icons`, Vitest + Testing Library + user-event.

## Por que não pôr a busca dentro do `Select` do Radix

O jeito óbvio seria enfiar um `<input>` dentro do `SelectContent` de `components/ui/select.tsx` e todas as 69 telas ganhariam busca de uma vez. Não funciona direito:

- O `Select` do Radix tem *typeahead* no próprio menu: cada tecla digitada no input sobe até o conteúdo e pula o foco para o item que começa com aquela letra.
- Passar o mouse sobre um item dá `focus()` nele, então o input perde o foco no meio da digitação.
- Para esconder um item filtrado, o `SelectItem` precisaria desmontar. Se ele for o item escolhido, o texto do gatilho some enquanto a pessoa digita.

Cada um desses tem gambiarra, e as três juntas dependem de detalhe interno do Radix que muda sem aviso. Um componente próprio, com `options` em array, é menor e dá para testar.

## Restrições globais

- Repositório: `repo/` (o git de verdade). Branch nova `feat/caixas-de-selecao-com-busca` a partir de `escale/main`. Nunca `reset --hard` nem force.
- **Nenhum commit, push ou PR sem OK explícito do usuário.** Os passos "Commit" abaixo só rodam depois do OK.
- Gerenciador: **pnpm** (nunca npm/yarn).
- Nenhuma dependência nova: nada de `cmdk`. Popover e ícones já estão no projeto.
- Ícones só de `@/lib/ui/icons` (Phosphor) — doutrina em `docs/design-system/05-iconography-phosphor.md`. Não importar `lucide-react` no componente novo.
- Todo texto que aparece na tela passa por `t()` de `@/hooks/i18n/useT`, e toda chave nova ganha uma linha em espanhol em `lib/i18n/dicionario.ts`. Quem cobra é `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
- Comentários em português e explicando o PORQUÊ. Sem `console.log`. Imports com `@/`.
- Não mexer em banco, rota de API nem `components/ui/select.tsx`. A mudança é só de interface.
- `pnpm test:unit` roda **sem caminho** (pega os testes espalhados por `lib/`, `app/` e `components/` também). Não corte a saída com `| tail`.
- Destino (DoD 18): **núcleo**.

## Arquivos

| Arquivo | Ação | O que muda |
|---|---|---|
| `lib/ui/filtrar-opcoes.ts` | Criar | Tipo `OpcaoDeSelecao` + função pura `filtrarOpcoes` |
| `tests/unit/filtrar-opcoes.test.ts` | Criar | Testes da função pura |
| `components/ui/searchable-select.tsx` | Criar | Componente `SearchableSelect` + constante `MINIMO_PARA_BUSCA` |
| `tests/unit/selecao-com-busca.test.tsx` | Criar | Testes do componente |
| `lib/i18n/dicionario.ts` | Modificar | 2 chaves novas (espanhol) |
| `app/app/ai/agents/[id]/_components/ModelPicker.tsx` | Modificar | Usa `SearchableSelect` (o exemplo do pedido) |
| `tests/unit/model-picker-tem-busca.test.tsx` | Criar | Busca de modelo no agente |
| `app/app/ai/providers/_components/PainelDeProvedores.tsx` | Modificar | 2 seletores de modelo + 1 de chave |
| `app/app/ai/routers/[id]/_client.tsx` | Modificar | Modelo do classificador |
| `app/app/ai/agents/[id]/_components/CredentialPicker.tsx` | Modificar | Chave de acesso do agente |
| `components/inbox/ReassignDialog.tsx` | Modificar | "Transferir para" (atendentes) |
| `components/inbox/CRMSidePanel.tsx` | Modificar | "Etapa do funil" |
| `components/ai/UsageFilters.tsx` | Modificar | Filtro "Agente" |
| `tests/unit/selecao-longa-tem-busca.test.ts` | Criar | Cerca com lista que só encolhe |
| `docs/design-system/06-components.md` | Modificar | Documenta o componente |
| `.changes/caixas-de-selecao-com-busca.md` | Criar | Fragmento de release |

---

### Tarefa 0: Branch

- [ ] **Passo 1: Criar a branch**

```bash
cd "C:/Documentos/projetos claude/Deskcom CRM/repo"
git status --short | head -20   # confira que não há mudança sua pendente
git switch escale/main
git switch -c feat/caixas-de-selecao-com-busca
```

Esperado: `Switched to a new branch 'feat/caixas-de-selecao-com-busca'`.

---

### Tarefa 1: Função pura de filtragem

**Arquivos:**
- Criar: `lib/ui/filtrar-opcoes.ts`
- Teste: `tests/unit/filtrar-opcoes.test.ts`

**Interfaces:**
- Consome: `normalizar(texto: string): string` de `lib/catalogo/busca.ts` (módulo puro, sem import nenhum — seguro no cliente).
- Produz:
  ```ts
  export interface OpcaoDeSelecao {
    value: string;
    label: string;
    keywords?: readonly string[];
    disabled?: boolean;
  }
  export function filtrarOpcoes<T extends OpcaoDeSelecao>(opcoes: readonly T[], busca: string): T[];
  ```

- [ ] **Passo 1: Escrever o teste que falha**

Criar `tests/unit/filtrar-opcoes.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { filtrarOpcoes, type OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";

const OPCOES: OpcaoDeSelecao[] = [
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", keywords: ["anthropic/claude-sonnet-4-6"] },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", keywords: ["anthropic/claude-haiku-4-5"] },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", keywords: ["google/gemini-2.5-pro"] },
  { value: "e1", label: "São Paulo — Negociação" },
  { value: "3f9a0c2e-1111-4a4a-8888-aaaaaaaaaaaa", label: "Chave principal" },
];

const rotulos = (lista: OpcaoDeSelecao[]) => lista.map((o) => o.label);

describe("filtrarOpcoes", () => {
  it("busca vazia devolve tudo, numa lista nova", () => {
    const resultado = filtrarOpcoes(OPCOES, "   ");
    expect(resultado).toEqual(OPCOES);
    expect(resultado).not.toBe(OPCOES);
  });

  it("ignora maiúscula e acento", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "sao paulo"))).toEqual(["São Paulo — Negociação"]);
    expect(rotulos(filtrarOpcoes(OPCOES, "NEGOCIACAO"))).toEqual(["São Paulo — Negociação"]);
  });

  it("cada palavra precisa aparecer, em qualquer ordem", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "4 sonnet"))).toEqual(["Claude Sonnet 4.6"]);
    expect(rotulos(filtrarOpcoes(OPCOES, "claude"))).toEqual(["Claude Sonnet 4.6", "Claude Haiku 4.5"]);
  });

  it("acha pelo identificador técnico quando ele vem em keywords", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "anthropic/claude-haiku"))).toEqual(["Claude Haiku 4.5"]);
  });

  it("pontuação na busca não atrapalha", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "gemini-2.5"))).toEqual(["Gemini 2.5 Pro"]);
  });

  it("NÃO procura no value: um uuid casaria com quase toda letra digitada", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "aaaa"))).toEqual([]);
  });

  it("nada casa → lista vazia", () => {
    expect(filtrarOpcoes(OPCOES, "xyz")).toEqual([]);
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/filtrar-opcoes.test.ts`
Esperado: FAIL — `Failed to resolve import "@/lib/ui/filtrar-opcoes"`.

- [ ] **Passo 3: Implementar**

Criar `lib/ui/filtrar-opcoes.ts`:

```ts
import { normalizar } from "@/lib/catalogo/busca";

/**
 * Uma opção de caixa de seleção com busca.
 *
 * `label` é o que a pessoa lê e o que a busca procura. `keywords` existe para o
 * que a pessoa DIGITA mas não lê — o identificador técnico do modelo
 * (`anthropic/claude-haiku-4-5`), por exemplo. O `value` fica de fora da busca
 * de propósito: quando é um uuid, qualquer letra de `a` a `f` casaria com quase
 * todas as opções.
 */
export interface OpcaoDeSelecao {
  value: string;
  label: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

/**
 * Filtra por palavras: cada palavra da busca precisa aparecer no rótulo ou nas
 * keywords, em qualquer ordem — "4 sonnet" acha "Claude Sonnet 4.6". Acento,
 * caixa e pontuação são ignorados pelo mesmo `normalizar` da busca do catálogo,
 * para "sao paulo" achar "São Paulo".
 */
export function filtrarOpcoes<T extends OpcaoDeSelecao>(opcoes: readonly T[], busca: string): T[] {
  const termos = normalizar(busca).split(" ").filter(Boolean);
  if (termos.length === 0) return [...opcoes];
  return opcoes.filter((opcao) => {
    const alvo = normalizar([opcao.label, ...(opcao.keywords ?? [])].join(" "));
    return termos.every((termo) => alvo.includes(termo));
  });
}
```

- [ ] **Passo 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/filtrar-opcoes.test.ts`
Esperado: PASS, 7 testes.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add lib/ui/filtrar-opcoes.ts tests/unit/filtrar-opcoes.test.ts
git commit -m "feat(ui): filtro de opções que ignora acento e aceita palavras em qualquer ordem

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 2: Componente `SearchableSelect`

**Arquivos:**
- Criar: `components/ui/searchable-select.tsx`
- Teste: `tests/unit/selecao-com-busca.test.tsx` (fica em `tests/unit/` e não ao lado do componente porque usa textos de exemplo em português que a cerca de i18n cobraria se o arquivo estivesse em `components/`)

**Interfaces:**
- Consome: `OpcaoDeSelecao`, `filtrarOpcoes` (Tarefa 1); `Popover`, `PopoverTrigger`, `PopoverContent` de `@/components/ui/popover`; `Check`, `CaretDown`, `MagnifyingGlass` de `@/lib/ui/icons`; `useT`; `cn`.
- Produz:
  ```ts
  export const MINIMO_PARA_BUSCA = 8;
  export interface SearchableSelectProps {
    options: readonly OpcaoDeSelecao[];
    value: string | undefined;
    onValueChange: (value: string) => void;
    placeholder?: string;
    searchPlaceholder?: string;   // padrão: t("Buscar…")
    emptyMessage?: string;        // padrão: t("Nenhum resultado")
    disabled?: boolean;
    id?: string;                  // vai no gatilho — é o alvo do <Label htmlFor>
    className?: string;           // vai no gatilho
    "aria-label"?: string;
    "data-testid"?: string;       // vai no gatilho
    minOptionsForSearch?: number; // padrão: MINIMO_PARA_BUSCA
  }
  export function SearchableSelect(props: SearchableSelectProps): JSX.Element;
  ```
  Papéis ARIA: gatilho `role="combobox"` (nome vem do `<Label htmlFor={id}>`), lista `role="listbox"`, itens `role="option"` com `aria-selected`, busca é `textbox` com nome igual ao `searchPlaceholder`.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `tests/unit/selecao-com-busca.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SearchableSelect } from "@/components/ui/searchable-select";
import type { OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";

const modelo = (value: string, label: string): OpcaoDeSelecao => ({ value, label, keywords: [value] });

const MODELOS: OpcaoDeSelecao[] = [
  modelo("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
  modelo("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
  modelo("anthropic/claude-opus-4-7", "Claude Opus 4.7"),
  modelo("openai/gpt-5", "GPT-5"),
  modelo("openai/gpt-5-mini", "GPT-5 mini"),
  modelo("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
  modelo("google/gemini-2.5-flash", "Gemini 2.5 Flash"),
  modelo("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B"),
  modelo("mistralai/mistral-large", "Mistral Large"),
  modelo("deepseek/deepseek-chat", "DeepSeek V3"),
];

const CURTA: OpcaoDeSelecao[] = [
  { value: "a", label: "Primeira" },
  { value: "b", label: "Segunda" },
  { value: "c", label: "Terceira" },
];

function Controlado({
  options = MODELOS,
  inicial = "",
  onChange = () => {},
}: {
  options?: OpcaoDeSelecao[];
  inicial?: string;
  onChange?: (v: string) => void;
}) {
  const [valor, setValor] = useState(inicial);
  return (
    <>
      <label htmlFor="modelo">Modelo</label>
      <SearchableSelect
        id="modelo"
        options={options}
        value={valor}
        placeholder="Selecione um modelo"
        onValueChange={(v) => {
          setValor(v);
          onChange(v);
        }}
      />
    </>
  );
}

const gatilho = () => screen.getByRole("combobox", { name: "Modelo" });
const rotulosVisiveis = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("SearchableSelect — caixa de seleção com busca", () => {
  it("lista longa abre com a busca focada e filtra pelo que se digita", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    await user.click(gatilho());
    const busca = await screen.findByRole("textbox", { name: "Buscar…" });
    expect(busca).toHaveFocus();
    expect(rotulosVisiveis()).toHaveLength(10);

    await user.type(busca, "sonnet");
    expect(rotulosVisiveis()).toEqual(["Claude Sonnet 4.6"]);
  });

  it("acha pelo identificador técnico que vem em keywords", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    await user.click(gatilho());
    await user.type(await screen.findByRole("textbox", { name: "Buscar…" }), "anthropic/claude-haiku");
    expect(rotulosVisiveis()).toEqual(["Claude Haiku 4.5"]);
  });

  it("escolhe pelo teclado: seta para baixo e Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlado onChange={onChange} />);

    await user.click(gatilho());
    await user.type(await screen.findByRole("textbox", { name: "Buscar…" }), "gemini");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("google/gemini-2.5-flash");
    expect(gatilho()).toHaveTextContent("Gemini 2.5 Flash");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("escolhe pelo clique e marca a opção escolhida", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlado onChange={onChange} />);

    await user.click(gatilho());
    await user.click(await screen.findByRole("option", { name: "GPT-5 mini" }));
    expect(onChange).toHaveBeenCalledWith("openai/gpt-5-mini");

    await user.click(gatilho());
    expect(await screen.findByRole("option", { name: "GPT-5 mini" })).toHaveAttribute("aria-selected", "true");
  });

  it("nada casa → mostra a mensagem de vazio e nenhuma opção", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    await user.click(gatilho());
    await user.type(await screen.findByRole("textbox", { name: "Buscar…" }), "xyz");
    expect(screen.getByText("Nenhum resultado")).toBeInTheDocument();
    expect(rotulosVisiveis()).toEqual([]);
  });

  it("lista curta não mostra busca, mas abre e escolhe igual", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlado options={CURTA} onChange={onChange} />);

    await user.click(gatilho());
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("option", { name: "Segunda" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("sem valor mostra o placeholder; valor fora da lista aparece cru em vez de sumir", () => {
    const { unmount } = render(<Controlado />);
    expect(gatilho()).toHaveTextContent("Selecione um modelo");
    unmount();

    render(<Controlado inicial="openrouter/modelo-sob-medida" />);
    expect(gatilho()).toHaveTextContent("openrouter/modelo-sob-medida");
  });

  it("digitar com o gatilho focado abre já buscando aquela letra", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    gatilho().focus();
    await user.keyboard("l");
    expect(await screen.findByRole("textbox", { name: "Buscar…" })).toHaveValue("l");
  });

  it("opção desabilitada não é escolhida", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlado
        options={[...CURTA, { value: "x", label: "Indisponível", disabled: true }]}
        onChange={onChange}
      />,
    );

    await user.click(gatilho());
    await user.click(await screen.findByRole("option", { name: "Indisponível" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/selecao-com-busca.test.tsx`
Esperado: FAIL — `Failed to resolve import "@/components/ui/searchable-select"`.

- [ ] **Passo 3: Implementar**

Criar `components/ui/searchable-select.tsx`:

```tsx
"use client";

import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import { CaretDown, Check, MagnifyingGlass } from "@/lib/ui/icons";
import { filtrarOpcoes, type OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";
import { cn } from "@/lib/utils";

/**
 * A partir de quantas opções a caixa de busca aparece.
 *
 * Com três ou quatro opções o olho acha mais rápido do que a mão digita, e a
 * busca vira ruído. A reclamação que originou este componente foi a lista de
 * modelos de IA — o OpenRouter devolve centenas — onde procurar no olho não
 * funciona.
 */
export const MINIMO_PARA_BUSCA = 8;

export interface SearchableSelectProps {
  options: readonly OpcaoDeSelecao[];
  value: string | undefined;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  minOptionsForSearch?: number;
}

/** Índice do valor atual, se der para escolhê-lo; senão, a primeira opção habilitada. */
function primeiroDestaque(lista: readonly OpcaoDeSelecao[], valor?: string): number {
  const doValor = valor ? lista.findIndex((o) => o.value === valor && !o.disabled) : -1;
  return doValor >= 0 ? doValor : lista.findIndex((o) => !o.disabled);
}

/** Próxima opção habilitada na direção `passo`; parada na borda em vez de dar a volta. */
function proximoHabilitado(lista: readonly OpcaoDeSelecao[], de: number, passo: 1 | -1): number {
  for (let i = de + passo; i >= 0 && i < lista.length; i += passo) {
    if (!lista[i]?.disabled) return i;
  }
  return de;
}

/**
 * Caixa de seleção com busca. Por que não é o `Select` do Radix com um input
 * dentro: o typeahead do Radix rouba as teclas digitadas e o hover rouba o
 * foco — ver `docs/superpowers/plans/2026-10-03-caixas-de-selecao-com-busca.md`.
 *
 * Os papéis ARIA são os mesmos do `Select` (gatilho `combobox`, itens
 * `option`), então quem testava a tela pelos papéis continua achando tudo.
 */
export function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
  minOptionsForSearch = MINIMO_PARA_BUSCA,
}: SearchableSelectProps) {
  const t = useT();
  const listaId = React.useId();
  const buscaRef = React.useRef<HTMLInputElement>(null);
  const listaRef = React.useRef<HTMLUListElement>(null);
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const [destacado, setDestacado] = React.useState(-1);

  const comBusca = options.length >= minOptionsForSearch;
  const visiveis = React.useMemo(() => filtrarOpcoes(options, busca), [options, busca]);
  // Valor fora da lista (modelo digitado à mão, item que saiu do catálogo)
  // aparece cru. Gatilho em branco faria parecer que nada foi escolhido.
  const rotulo = options.find((o) => o.value === value)?.label ?? (value || "");
  const textoDaBusca = searchPlaceholder ?? t("Buscar…");
  const idDoDestacado = destacado >= 0 ? `${listaId}-${destacado}` : undefined;

  React.useEffect(() => {
    if (!aberto || !idDoDestacado) return;
    // `?.` na chamada: o jsdom não implementa scrollIntoView.
    document.getElementById(idDoDestacado)?.scrollIntoView?.({ block: "nearest" });
  }, [aberto, idDoDestacado]);

  function abrir(buscaInicial = "") {
    setBusca(buscaInicial);
    setDestacado(primeiroDestaque(filtrarOpcoes(options, buscaInicial), buscaInicial ? undefined : value));
    setAberto(true);
  }

  function escolher(opcao: OpcaoDeSelecao) {
    if (opcao.disabled) return;
    onValueChange(opcao.value);
    setAberto(false);
  }

  function aoDigitar(texto: string) {
    setBusca(texto);
    setDestacado(primeiroDestaque(filtrarOpcoes(options, texto)));
  }

  function aoTeclarNaLista(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDestacado((i) => proximoHabilitado(visiveis, i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestacado((i) => proximoHabilitado(visiveis, i, -1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setDestacado(proximoHabilitado(visiveis, -1, 1));
    } else if (e.key === "End") {
      e.preventDefault();
      setDestacado(proximoHabilitado(visiveis, visiveis.length, -1));
    } else if (e.key === "Enter") {
      // preventDefault também impede o Enter de enviar um formulário em volta.
      e.preventDefault();
      const alvo = visiveis[destacado];
      if (alvo) escolher(alvo);
    }
  }

  function aoTeclarNoGatilho(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (aberto || disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      abrir();
    } else if (comBusca && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // O Select do Radix tinha typeahead no gatilho fechado; aqui a letra
      // digitada abre a caixa e já vira o começo da busca.
      e.preventDefault();
      abrir(e.key);
    }
  }

  return (
    // `modal`: dentro de um Dialog, o bloqueio de rolagem do Dialog impediria
    // rolar a lista com a roda do mouse (o conteúdo vai num portal fora dele).
    <Popover modal open={aberto} onOpenChange={(abrindo) => (abrindo ? abrir() : setAberto(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={aberto}
          aria-controls={listaId}
          aria-label={ariaLabel}
          data-testid={testId}
          data-placeholder={rotulo ? undefined : ""}
          disabled={disabled}
          onKeyDown={aoTeclarNoGatilho}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background data-[placeholder]:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="line-clamp-1 text-left">{rotulo || placeholder}</span>
          <CaretDown size={16} className="shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-[12rem] p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (comBusca ? buscaRef.current : listaRef.current)?.focus();
        }}
        onKeyDown={aoTeclarNaLista}
      >
        {comBusca ? (
          <div className="flex items-center gap-2 border-b px-3">
            <MagnifyingGlass size={16} className="shrink-0 opacity-50" aria-hidden />
            <input
              ref={buscaRef}
              value={busca}
              onChange={(e) => aoDigitar(e.target.value)}
              placeholder={textoDaBusca}
              aria-label={textoDaBusca}
              aria-controls={listaId}
              aria-activedescendant={idDoDestacado}
              autoComplete="off"
              className="h-9 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
            />
          </div>
        ) : null}
        {visiveis.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyMessage ?? t("Nenhum resultado")}
          </p>
        ) : (
          <ul
            ref={listaRef}
            id={listaId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={comBusca ? undefined : idDoDestacado}
            className="max-h-72 overflow-y-auto p-1 outline-hidden"
          >
            {visiveis.map((opcao, i) => (
              <li
                key={opcao.value}
                id={`${listaId}-${i}`}
                role="option"
                aria-selected={opcao.value === value}
                aria-disabled={opcao.disabled || undefined}
                className={cn(
                  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm",
                  i === destacado && "bg-accent text-accent-foreground",
                  opcao.disabled && "pointer-events-none opacity-50",
                )}
                onMouseMove={() => {
                  if (!opcao.disabled && i !== destacado) setDestacado(i);
                }}
                onClick={() => escolher(opcao)}
              >
                {opcao.label}
                {opcao.value === value ? (
                  <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                    <Check size={16} aria-hidden />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Passo 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/selecao-com-busca.test.tsx`
Esperado: PASS, 9 testes.

Se "digitar com o gatilho focado" falhar porque o input abre vazio: confira que `aoTeclarNoGatilho` chama `e.preventDefault()` antes de `abrir(e.key)`. Sem isso a tecla também chega ao input focado e o valor fica duplicado (`"ll"`).

- [ ] **Passo 5: i18n e tipos**

Run: `pnpm vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Esperado: PASS e sem erro de tipo. As duas chaves usadas no componente (`"Buscar…"` e `"Nenhum resultado"`) já existem no dicionário.

- [ ] **Passo 6: Commit (só com OK do usuário)**

```bash
git add components/ui/searchable-select.tsx tests/unit/selecao-com-busca.test.tsx
git commit -m "feat(ui): caixa de seleção com busca (SearchableSelect)

A busca aparece a partir de 8 opções. Mantém os papéis combobox/option do
Select do Radix, então quem testava pelos papéis continua funcionando.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 3: Seletor de modelo do agente (o exemplo do pedido)

**Arquivos:**
- Modificar: `app/app/ai/agents/[id]/_components/ModelPicker.tsx` (substituir o arquivo inteiro)
- Modificar: `lib/i18n/dicionario.ts` (logo depois da linha `export const DICIONARIO: Traducoes = {`)
- Teste: `tests/unit/model-picker-tem-busca.test.tsx`
- Testes que precisam continuar passando: `tests/unit/model-picker-aceita-identificador-manual.test.tsx`, `tests/unit/painel-do-operador.test.tsx`

**Interfaces:**
- Consome: `SearchableSelect` (Tarefa 2), `OpcaoDeSelecao` (Tarefa 1).
- Produz: nada novo. As props de `ModelPicker` e `useModelMeta` continuam iguais — `AgentForm.tsx` e `PainelDoOperador.tsx` não mudam.

- [ ] **Passo 1: Escrever o teste que falha**

Criar `tests/unit/model-picker-tem-busca.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelPicker } from "@/app/app/ai/agents/[id]/_components/ModelPicker";

const modelo = (model_id: string, display_name: string, context_window = 200_000) => ({
  provider: "openrouter",
  model_id,
  display_name,
  context_window,
  is_default_for_provider: false,
});

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        models: [
          modelo("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
          modelo("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
          modelo("anthropic/claude-opus-4-7", "Claude Opus 4.7"),
          modelo("openai/gpt-5", "GPT-5", 400_000),
          modelo("openai/gpt-5-mini", "GPT-5 mini", 400_000),
          modelo("google/gemini-2.5-pro", "Gemini 2.5 Pro", 1_000_000),
          modelo("google/gemini-2.5-flash", "Gemini 2.5 Flash", 1_000_000),
          modelo("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B", 128_000),
          modelo("mistralai/mistral-large", "Mistral Large", 128_000),
        ],
      },
    })),
  },
}));

describe("seletor de modelo do agente — busca", () => {
  it("acha o modelo digitando, sem rolar a lista", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function SeletorControlado() {
      const [model, setModel] = useState("");
      return (
        <ModelPicker
          id="model"
          provider="openrouter"
          value={model}
          onChange={(modelId, contexto) => {
            setModel(modelId);
            onChange(modelId, contexto);
          }}
        />
      );
    }

    render(
      <QueryClientProvider client={client}>
        <SeletorControlado />
      </QueryClientProvider>,
    );

    const gatilho = await screen.findByRole("combobox", { name: "Modelo" });
    await screen.findByText("Selecione um modelo");
    await user.click(gatilho);
    await user.type(await screen.findByRole("textbox", { name: "Buscar modelo…" }), "haiku");

    const opcoes = screen.getAllByRole("option");
    expect(opcoes.map((o) => o.textContent)).toEqual(["Claude Haiku 4.5"]);

    await user.click(opcoes[0]!);
    expect(onChange).toHaveBeenLastCalledWith("anthropic/claude-haiku-4-5", { contextWindow: 200_000 });
    expect(gatilho).toHaveTextContent("Claude Haiku 4.5");
  });
});
```

- [ ] **Passo 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/model-picker-tem-busca.test.tsx`
Esperado: FAIL — não acha o `textbox` "Buscar modelo…" (o `Select` do Radix não tem busca).

- [ ] **Passo 3: Chaves novas no dicionário**

Em `lib/i18n/dicionario.ts`, logo depois da linha `export const DICIONARIO: Traducoes = {`, inserir:

```ts
  // ─── CAIXAS DE SELEÇÃO COM BUSCA ───
  "Buscar modelo…": { es: "Buscar modelo…" },
  "Nenhum modelo encontrado": { es: "No se encontró ningún modelo" },
```

- [ ] **Passo 4: Trocar o `Select` pelo `SearchableSelect`**

Substituir **o arquivo inteiro** `app/app/ai/agents/[id]/_components/ModelPicker.tsx` por:

```tsx
"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { useT } from "@/hooks/i18n/useT";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` — a mesma lista única da tela de
 * Credenciais e da rota. Como literal aqui, o seletor de modelo do agente não
 * conseguia representar um agente publicado em OpenRouter.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

export interface ModelOption {
  provider: Provider;
  model_id: string;
  display_name: string;
  context_window: number | null;
  is_default_for_provider: boolean;
}

interface Props {
  provider: Provider;
  value: string;
  onChange: (modelId: string, ctx?: { contextWindow: number | null }) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Texto do estado "nada escolhido". Existe porque nem todo uso deste seletor
   * trata vazio como erro: no papel Operador, vazio SIGNIFICA "usa o mesmo
   * modelo que conversa", e chamar isso de "Selecione um modelo" mentiria.
   */
  placeholder?: string;
}

interface ApiResponse {
  data: { models: ModelOption[] };
}

export function ModelPicker({ provider, value, onChange, disabled, id, placeholder }: Props) {
  const t = useT();
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });

  const models = React.useMemo(() => query.data ?? [], [query.data]);
  // O catálogo de um provedor pode ter centenas de modelos (o OpenRouter tem),
  // e procurar no olho era a reclamação. O identificador técnico vai em
  // `keywords` porque é ele que quem já conhece o modelo digita.
  const opcoes = React.useMemo<OpcaoDeSelecao[]>(
    () =>
      models.map((m) => ({
        value: m.model_id,
        label: m.is_default_for_provider ? `${m.display_name} · ${t("default")}` : m.display_name,
        keywords: [m.model_id],
      })),
    [models, t],
  );

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {models.length === 0 && !query.isLoading ? (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value, { contextWindow: null })}
          placeholder={t("Digite o identificador do modelo")}
          disabled={disabled}
        />
      ) : (
        <SearchableSelect
          id={id}
          options={opcoes}
          value={value || undefined}
          onValueChange={(v) => {
            const m = models.find((m) => m.model_id === v);
            onChange(v, { contextWindow: m?.context_window ?? null });
          }}
          disabled={disabled || query.isLoading}
          placeholder={query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))}
          searchPlaceholder={t("Buscar modelo…")}
          emptyMessage={t("Nenhum modelo encontrado")}
        />
      )}
    </div>
  );
}

export function useModelMeta(provider: Provider, modelId: string): ModelOption | null {
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });
  return (query.data ?? []).find((m) => m.model_id === modelId) ?? null;
}
```

- [ ] **Passo 5: Rodar o teste novo e os antigos do seletor**

Run: `pnpm vitest run tests/unit/model-picker-tem-busca.test.tsx tests/unit/model-picker-aceita-identificador-manual.test.tsx tests/unit/painel-do-operador.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Esperado: PASS em todos.

Se `painel-do-operador.test.tsx` falhar procurando o seletor: abra o teste e veja como ele o encontra. Se for por `combobox`/`option`, o componente já atende. Se for por algo exclusivo do Radix (ex.: `data-radix-*`), troque a busca no teste pelo papel `combobox` com o nome do rótulo. Isso é corrigir o teste para o novo instrumento, não mudar o que ele prova.

- [ ] **Passo 6: Commit (só com OK do usuário)**

```bash
git add "app/app/ai/agents/[id]/_components/ModelPicker.tsx" lib/i18n/dicionario.ts tests/unit/model-picker-tem-busca.test.tsx
git commit -m "feat(agentes): busca no seletor de modelo do agente

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 4: Os outros seletores de modelo de IA

**Arquivos:**
- Modificar: `app/app/ai/providers/_components/PainelDeProvedores.tsx` (modelo padrão ~linha 366; modelo do ponto ~linha 615; chave do ponto ~linha 633)
- Modificar: `app/app/ai/routers/[id]/_client.tsx` (modelo do classificador ~linha 318)
- Testes que precisam continuar passando: `app/app/ai/providers/_components/PainelDeProvedores.test.tsx`, `tests/unit/i18n-provedores-e-pontos.test.ts`

**Interfaces:**
- Consome: `SearchableSelect` (Tarefa 2); chaves `"Buscar modelo…"` e `"Nenhum modelo encontrado"` (Tarefa 3).
- Produz: nada novo.

- [ ] **Passo 1: Import em `PainelDeProvedores.tsx`**

Junto dos outros imports de `@/components/ui/*`, adicionar:

```tsx
import { SearchableSelect } from "@/components/ui/searchable-select";
```

O import de `@/components/ui/select` **continua**: os seletores de provedor (`dados.provedores`, ~linhas 329 e 578) são listas curtas e ficam como estão.

- [ ] **Passo 2: Modelo padrão (~linha 366)**

Trocar este bloco:

```tsx
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger data-testid="padrao-modelo">
                <SelectValue placeholder={t("escolha")} />
              </SelectTrigger>
              <SelectContent>
                {modelosDoProvedor.map((m) => (
                  <SelectItem key={m.model_id} value={m.model_id}>
                    {m.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
```

por:

```tsx
            <SearchableSelect
              data-testid="padrao-modelo"
              options={modelosDoProvedor.map((m) => ({
                value: m.model_id,
                label: m.display_name,
                keywords: [m.model_id],
              }))}
              value={modelId}
              onValueChange={setModelId}
              placeholder={t("escolha")}
              searchPlaceholder={t("Buscar modelo…")}
              emptyMessage={t("Nenhum modelo encontrado")}
            />
```

- [ ] **Passo 3: Modelo do ponto (~linha 615)**

Trocar:

```tsx
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger data-testid={`modelo-${ponto.id}`}>
                  <SelectValue placeholder={t("escolha")} />
                </SelectTrigger>
                <SelectContent>
                  {modelosDoProvider.map((m) => (
                    <SelectItem key={m.model_id} value={m.model_id}>
                      {m.display_name}
                      {ponto.exige.tools && !m.supports_tools ? ` — ${t("sem ferramentas")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
```

por:

```tsx
              <SearchableSelect
                data-testid={`modelo-${ponto.id}`}
                options={modelosDoProvider.map((m) => ({
                  value: m.model_id,
                  label:
                    m.display_name +
                    (ponto.exige.tools && !m.supports_tools ? ` — ${t("sem ferramentas")}` : ""),
                  keywords: [m.model_id],
                }))}
                value={modelId}
                onValueChange={setModelId}
                placeholder={t("escolha")}
                searchPlaceholder={t("Buscar modelo…")}
                emptyMessage={t("Nenhum modelo encontrado")}
              />
```

- [ ] **Passo 4: Chave do ponto (~linha 633)**

Trocar:

```tsx
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger data-testid={`chave-${ponto.id}`}>
                <SelectValue placeholder={t("da instalação")} />
              </SelectTrigger>
              <SelectContent>
                {credsDoProvider.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label} ••{c.api_key_last4 ?? "??"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
```

por:

```tsx
            <SearchableSelect
              data-testid={`chave-${ponto.id}`}
              options={credsDoProvider.map((c) => ({
                value: c.id,
                label: `${c.label} ••${c.api_key_last4 ?? "??"}`,
              }))}
              value={credentialId}
              onValueChange={setCredentialId}
              placeholder={t("da instalação")}
            />
```

- [ ] **Passo 5: Modelo do classificador em `routers/[id]/_client.tsx` (~linha 318)**

Adicionar o import `import { SearchableSelect } from "@/components/ui/searchable-select";` junto dos outros de `@/components/ui/*` (o de `select` continua: os seletores de agente e fluxo do mesmo arquivo ficam para depois).

Trocar:

```tsx
              <Select
                value={classifier}
                onValueChange={setClassifier}
                disabled={!canManage || classifierModels.length === 0}
              >
                <SelectTrigger id="router-classifier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>{t("Automático — usa o provedor da organização")}</SelectItem>
                  {classifierModels.map((m) => (
                    <SelectItem key={`${m.provider}::${m.model_id}`} value={`${m.provider}::${m.model_id}`}>
                      {m.display_name} · {m.provider}
                      {m.origem === "plataforma" ? ` (${t("chave desta instalação")})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
```

por:

```tsx
              <SearchableSelect
                id="router-classifier"
                options={[
                  { value: AUTO, label: t("Automático — usa o provedor da organização") },
                  ...classifierModels.map((m) => ({
                    value: `${m.provider}::${m.model_id}`,
                    label:
                      `${m.display_name} · ${m.provider}` +
                      (m.origem === "plataforma" ? ` (${t("chave desta instalação")})` : ""),
                    keywords: [m.model_id],
                  })),
                ]}
                value={classifier}
                onValueChange={setClassifier}
                disabled={!canManage || classifierModels.length === 0}
                searchPlaceholder={t("Buscar modelo…")}
                emptyMessage={t("Nenhum modelo encontrado")}
              />
```

- [ ] **Passo 6: Rodar os testes das telas, tipos e lint**

Run: `pnpm vitest run app/app/ai/providers/_components/PainelDeProvedores.test.tsx tests/unit/i18n-provedores-e-pontos.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck && pnpm lint`
Esperado: tudo PASS. O lint acusa import sem uso se algum `SelectX` ficou sobrando — remova só o nome que ele apontar.

- [ ] **Passo 7: Commit (só com OK do usuário)**

```bash
git add app/app/ai/providers/_components/PainelDeProvedores.tsx "app/app/ai/routers/[id]/_client.tsx"
git commit -m "feat(ia): busca nos seletores de modelo dos provedores e do roteador

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 5: Listas que crescem com o uso (credenciais, atendentes, etapas, agentes)

**Arquivos:**
- Modificar: `app/app/ai/agents/[id]/_components/CredentialPicker.tsx` (~linhas 65–94)
- Modificar: `components/inbox/ReassignDialog.tsx` (~linhas 172–186)
- Modificar: `components/inbox/CRMSidePanel.tsx` (~linhas 445–456)
- Modificar: `components/ai/UsageFilters.tsx` (~linhas 83–96)
- Testes que precisam continuar passando: `tests/unit/etapa-pela-conversa.test.tsx` (usa `combobox` "Etapa do funil" + `option`), `components/inbox/ConversationHeader.test.tsx`, e os demais testes de inbox listados no Passo 6.

**Interfaces:**
- Consome: `SearchableSelect` (Tarefa 2), `OpcaoDeSelecao` (Tarefa 1).
- Produz: nada novo.

- [ ] **Passo 1: `CredentialPicker.tsx`**

Trocar o import do select:

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

por:

```tsx
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";
```

Dentro de `CredentialPicker`, logo depois de `const semOpcao = ...;`, adicionar:

```tsx
  const opcoes: OpcaoDeSelecao[] = [
    // A chave do `.env` é o caso MAIS COMUM do produto — quem instala pelo
    // kit cola a chave no terminal e nunca abre a tela de Credenciais. O
    // runtime sempre soube usá-la; só esta tela não deixava escolhê-la, e o
    // resultado era um editor onde o dono não conseguia salvar nada.
    ...(instalacaoTemChave
      ? [{ value: CHAVE_DA_INSTALACAO, label: `${t("A chave desta instalação")} (${provider})` }]
      : []),
    ...filtered.map((c) => ({
      value: c.id,
      label: `${c.label} · …${c.api_key_last4 ?? "????"} · ${t(STATUS_LABEL[credentialStatus(c)])}`,
    })),
    ...(semOpcao
      ? [{ value: "__none__", label: `${t("Nenhuma credencial")} ${provider} ${t("cadastrada")}`, disabled: true }]
      : []),
  ];
```

E trocar todo o bloco `<Select value={value || undefined} ...> ... </Select>` (do `<Select` até o `</Select>` que vem antes de `{semOpcao ? (<p ...`) por:

```tsx
      <SearchableSelect
        id={id}
        options={opcoes}
        value={value || undefined}
        onValueChange={onChange}
        disabled={disabled}
        placeholder={t("Escolha uma chave")}
      />
```

O comentário JSX sobre a chave do `.env` que ficava dentro do `SelectContent` some junto (ele foi para cima do array).

- [ ] **Passo 2: `ReassignDialog.tsx` — "Transferir para"**

Adicionar `import { SearchableSelect } from "@/components/ui/searchable-select";`. O import de `select` continua (o seletor de número, ~linha 145, é lista curta).

Trocar:

```tsx
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger id="reassign-target" className="w-full">
                <SelectValue
                  placeholder={members.isLoading ? t("Carregando atendentes…") : t("Escolha o atendente")}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? `${t("Atendente")} ${m.user_id.slice(0, 8)}`}
                    <span className="ml-1 text-muted-foreground">
                      · {t(ROLE_LABEL[m.role] ?? m.role)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
```

por:

```tsx
            <SearchableSelect
              id="reassign-target"
              className="w-full"
              options={options.map((m) => ({
                value: m.user_id,
                label: `${m.full_name ?? `${t("Atendente")} ${m.user_id.slice(0, 8)}`} · ${t(ROLE_LABEL[m.role] ?? m.role)}`,
              }))}
              value={toUserId}
              onValueChange={setToUserId}
              placeholder={members.isLoading ? t("Carregando atendentes…") : t("Escolha o atendente")}
            />
```

Mudança visual aceita: o papel do atendente deixa de ser cinza e fica no mesmo tom do nome, porque `label` é texto puro (é ele que a busca procura).

- [ ] **Passo 3: `CRMSidePanel.tsx` — "Etapa do funil"**

Adicionar `import { SearchableSelect } from "@/components/ui/searchable-select";`.

Trocar:

```tsx
      <Select value={lead.stage_id} onValueChange={(v) => void escolher(v)} disabled={mover.isPending}>
        <SelectTrigger id={`etapa-${lead.id}`} className="h-8 w-full text-xs" data-testid="inbox-etapa-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {etapas.map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-xs">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
```

por:

```tsx
      <SearchableSelect
        id={`etapa-${lead.id}`}
        className="h-8 w-full text-xs"
        data-testid="inbox-etapa-select"
        options={etapas.map((e) => ({ value: e.id, label: e.name }))}
        value={lead.stage_id}
        onValueChange={(v) => void escolher(v)}
        disabled={mover.isPending}
      />
```

Depois rode `grep -n "<Select" components/inbox/CRMSidePanel.tsx`. Se não sobrar nenhum, apague o import de `@/components/ui/select`.

- [ ] **Passo 4: `UsageFilters.tsx` — filtro "Agente"**

Adicionar `import { SearchableSelect } from "@/components/ui/searchable-select";` (o import de `select` continua para o filtro de tipo, `KIND_OPTIONS`).

Trocar:

```tsx
        <Label className="text-xs text-muted-foreground">{t("Agente")}</Label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS}>{t("Todos")}</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
```

por:

```tsx
        <Label htmlFor="uso-filtro-agente" className="text-xs text-muted-foreground">
          {t("Agente")}
        </Label>
        <SearchableSelect
          id="uso-filtro-agente"
          options={[
            { value: ALL_AGENTS, label: t("Todos") },
            ...agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
          value={agentId}
          onValueChange={setAgentId}
        />
```

O `htmlFor` é novo de propósito: antes o rótulo não estava ligado ao campo, e leitor de tela anunciava a caixa sem nome.

- [ ] **Passo 5: Tipos e lint**

Run: `pnpm typecheck && pnpm lint`
Esperado: sem erro. Se `setAgentId`/`setToUserId` forem `Dispatch<SetStateAction<X>>` com `X` mais estreito que `string`, embrulhe: `onValueChange={(v) => setAgentId(v as typeof agentId)}`.

- [ ] **Passo 6: Rodar os testes das telas tocadas**

Run:
```bash
pnpm vitest run tests/unit/etapa-pela-conversa.test.tsx components/inbox/ConversationHeader.test.tsx tests/unit/inbox-campos-lead.test.tsx tests/unit/inbox-demandas-abertas.test.tsx tests/unit/inbox-leads-recentes-com-funil.test.tsx tests/unit/deep-link-nao-espera-a-lista.test.tsx tests/unit/busca-na-conversa-layout.test.tsx tests/unit/rascunho-nao-segue-para-outra-conversa.test.tsx tests/unit/rotulo-tags-do-contato.test.tsx tests/unit/novo-lead-escolhe-contato.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts
```
Esperado: PASS em todos. `etapa-pela-conversa` é o termômetro: ele abre "Etapa do funil" pelo `combobox`, lê as `option` e confere o texto do gatilho depois da escolha — exatamente o contrato que o componente manteve.

- [ ] **Passo 7: Commit (só com OK do usuário)**

```bash
git add "app/app/ai/agents/[id]/_components/CredentialPicker.tsx" components/inbox/ReassignDialog.tsx components/inbox/CRMSidePanel.tsx components/ai/UsageFilters.tsx
git commit -m "feat(ui): busca nas caixas de credencial, atendente, etapa e agente

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 6: Cerca — caixa nova de lista dinâmica nasce com busca

**Arquivos:**
- Criar: `tests/unit/selecao-longa-tem-busca.test.ts`

**Interfaces:**
- Consome: só `node:fs`, `node:path` e `vitest`. Sem import de `@/`, então `vitest.cercas.ts` a classifica como **cerca** (roda em `node`, entra no `pnpm cercas`).
- Produz: nada importável.

**O que ela mede:** um bloco `<SelectContent>…</SelectContent>` ou `<select>…</select>` com `.map(` dentro é uma caixa cuja lista vem de dado e cresce com o uso. A lista `AINDA_SEM_BUSCA` registra quantas dessas ainda existem por arquivo **depois das Tarefas 3–5**. Ela só encolhe: número maior que o registrado reprova (caixa nova sem busca), e número menor também reprova até alguém baixar o registro (catraca).

- [ ] **Passo 1: Escrever a cerca**

Criar `tests/unit/selecao-longa-tem-busca.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Caixa de seleção cuja lista vem de dado — `.map(` dentro do menu — cresce
 * com o uso: modelos de IA, atendentes, etapas, credenciais. Sem busca, ela
 * obriga a pessoa a procurar no olho (a reclamação que deu origem a isto foi a
 * lista de modelos do agente). O caminho é `SearchableSelect`, em
 * `components/ui/searchable-select.tsx`, que só mostra a busca a partir de
 * `MINIMO_PARA_BUSCA` opções — migrar lista curta não custa nada.
 *
 * `AINDA_SEM_BUSCA` é o que falta migrar, por arquivo. Esta lista SÓ ENCOLHE:
 * o número de um arquivo pode descer, nunca subir, e arquivo novo não entra.
 * Quem migra uma caixa baixa o número (ou apaga a linha quando chega a zero).
 * Plano: docs/superpowers/plans/2026-10-03-caixas-de-selecao-com-busca.md
 */
const AINDA_SEM_BUSCA: Record<string, number> = {
  "app/admin/(protected)/inbox/_components/InboxList.tsx": 1,
  "app/admin/(protected)/incidents/_client.tsx": 2,
  "app/admin/(protected)/usage/_client.tsx": 1,
  "app/admin/(protected)/users/_client.tsx": 1,
  "app/app/activities/_components/ActivityReportClient.tsx": 1,
  "app/app/ads/meta/_components/MetaAdsClient.tsx": 1,
  "app/app/ai/agents/[id]/_components/AgentForm.tsx": 2,
  "app/app/ai/agents/[id]/_components/LegacyRecovery.tsx": 2,
  "app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx": 1,
  "app/app/ai/credentials/_components/AddCredentialDialog.tsx": 1,
  "app/app/ai/followups/[id]/_components/EdgeConfigPanel.tsx": 1,
  "app/app/ai/followups/[id]/_components/PublishBar.tsx": 1,
  "app/app/ai/followups/[id]/_components/TriggerConfigControl.tsx": 2,
  "app/app/ai/followups/[id]/_components/forms/ActionForm.tsx": 2,
  "app/app/ai/followups/[id]/_components/forms/ClassifyForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/CollectForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/ConditionForm.tsx": 4,
  "app/app/ai/followups/[id]/_components/forms/EndForm.tsx": 3,
  "app/app/ai/followups/[id]/_components/forms/InternalTaskForm.tsx": 2,
  "app/app/ai/followups/[id]/_components/forms/MatchReplyForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/SkillForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/WaitForm.tsx": 1,
  "app/app/ai/followups/_components/ModelosDialog.tsx": 1,
  "app/app/ai/followups/_components/QueueTab.tsx": 2,
  "app/app/ai/providers/_components/PainelDeProvedores.tsx": 2,
  "app/app/ai/routers/[id]/_client.tsx": 3,
  "app/app/ai/routers/_client.tsx": 1,
  "app/app/campaigns/[id]/edit/_client.tsx": 4,
  "app/app/campaigns/_client.tsx": 1,
  "app/app/campaigns/new/_client.tsx": 6,
  "app/app/comandas/_client.tsx": 2,
  "app/app/comandas/_pendentes.tsx": 1,
  "app/app/faturamento/_lancamentos.tsx": 1,
  "app/app/honorarios/_parcelas.tsx": 1,
  "app/app/integracao-dados/[id]/_components/ExploradorDeDados.tsx": 1,
  "app/app/integracao-dados/_components/FormularioDeConexao.tsx": 1,
  "app/app/kanban/_components/ImportarLeads.tsx": 1,
  "app/app/metrics/_components/MetricsClient.tsx": 1,
  "app/app/proposals/[id]/_components/DocumentoCanvas.tsx": 2,
  "app/app/proposals/novo/_client.tsx": 1,
  "app/app/prospecting/_client.tsx": 4,
  "app/app/settings/conversoes/_formGoogle.tsx": 2,
  "app/app/settings/conversoes/_historico.tsx": 3,
  "app/app/settings/conversoes/_regrasGoogle.tsx": 2,
  "app/app/settings/profile/_form.tsx": 2,
  "app/app/settings/tags/_painel.tsx": 1,
  "app/app/settings/tenant/_form.tsx": 4,
  "app/app/settings/tenant/agenda/_client.tsx": 4,
  "app/app/settings/tenant/financeiro/_client.tsx": 2,
  "app/app/settings/tenant/financeiro/_comissao.tsx": 2,
  "app/app/settings/tenant/financeiro/_recorrencias.tsx": 1,
  "app/app/settings/tenant/pipelines/_client.tsx": 2,
  "app/app/settings/tenant/pipelines/_mapping.tsx": 1,
  "app/app/settings/tenant/pipelines/_stages.tsx": 2,
  "app/app/team/_components/AttendantsClient.tsx": 3,
  "app/app/team/_components/TeamMembersClient.tsx": 1,
  "app/app/team/invite/_components/InviteForm.tsx": 1,
  "app/app/webhooks/_components/ActionConfigForm.tsx": 8,
  "app/app/webhooks/_components/CapturasTab.tsx": 1,
  "app/app/webhooks/_components/CreateSourceDialog.tsx": 2,
  "app/app/webhooks/_components/RuleEditor.tsx": 8,
  "app/design/components/Switcher.tsx": 3,
  "app/onboarding/invite-team/_form.tsx": 1,
  "app/onboarding/setup-ai/_inteligencia.tsx": 1,
  "app/onboarding/welcome/_form.tsx": 1,
  "components/agenda/DetalheDoCompromisso.tsx": 1,
  "components/agenda/MeetDoCompromisso.tsx": 1,
  "components/agenda/VinculoDaMarcacao.tsx": 1,
  "components/ai/AgentEditor.tsx": 3,
  "components/ai/GuardrailsEditor.tsx": 1,
  "components/ai/UsageFilters.tsx": 1,
  "components/connections/AntiBanSheet.tsx": 1,
  "components/connections/RedesSociaisClient.tsx": 2,
  "components/connections/TelefoniaClient.tsx": 4,
  "components/connections/TemplatesParceiroClient.tsx": 1,
  "components/contacts/CustomFieldsEditor.tsx": 1,
  "components/extensions/ExtensionCatalog.tsx": 1,
  "components/inbox/InboxFilters.tsx": 1,
  "components/inbox/JanelaFechadaAviso.tsx": 1,
  "components/inbox/ReassignDialog.tsx": 1,
  "components/kanban/CamposObrigatoriosDialog.tsx": 1,
  "components/kanban/MoveToOtherPipelineDialog.tsx": 1,
  "components/kanban/NewLeadDialog.tsx": 1,
};

const RAIZ = join(__dirname, "..", "..");
/** Diretórios cuja saída um cliente vê. `api` não renderiza tela. */
const AREAS = ["app", "components"];
const PASTAS_IGNORADAS = new Set(["api", "node_modules"]);

const BLOCO_DE_SELECAO = /<SelectContent[\s>][\s\S]*?<\/SelectContent>|<select[\s>][\s\S]*?<\/select>/g;

function contarSelecoesDinamicas(fonte: string): number {
  return [...fonte.matchAll(BLOCO_DE_SELECAO)].filter((m) => m[0].includes(".map(")).length;
}

function telas(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (PASTAS_IGNORADAS.has(e.name) || e.name.startsWith(".")) continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) telas(caminho, acc);
    else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) acc.push(caminho);
  }
  return acc;
}

function medir(): Record<string, number> {
  const medido: Record<string, number> = {};
  for (const area of AREAS) {
    for (const arquivo of telas(join(RAIZ, area))) {
      const n = contarSelecoesDinamicas(readFileSync(arquivo, "utf8"));
      if (n > 0) medido[relative(RAIZ, arquivo).split(sep).join("/")] = n;
    }
  }
  return medido;
}

const COMO_CONSERTAR =
  "Caixa de seleção com lista vinda de dado (`.map(` dentro do menu) precisa de busca. " +
  "Use SearchableSelect de components/ui/searchable-select.tsx — com menos de 8 opções a busca nem aparece. " +
  "Confira com: pnpm vitest run tests/unit/selecao-longa-tem-busca.test.ts";

describe("caixa de seleção de lista dinâmica tem busca", () => {
  const medido = medir();

  it("nenhuma caixa nova de lista dinâmica nasce sem busca", () => {
    const excedentes = Object.entries(medido)
      .filter(([arquivo, n]) => n > (AINDA_SEM_BUSCA[arquivo] ?? 0))
      .map(([arquivo, n]) => `${arquivo}: ${n} sem busca (registrado: ${AINDA_SEM_BUSCA[arquivo] ?? 0})`);
    expect(excedentes, COMO_CONSERTAR).toEqual([]);
  });

  it("a lista de pendências só encolhe: número velho reprova", () => {
    const folgas = Object.entries(AINDA_SEM_BUSCA)
      .filter(([arquivo, n]) => (medido[arquivo] ?? 0) < n)
      .map(
        ([arquivo, n]) =>
          `${arquivo}: registrado ${n}, medido ${medido[arquivo] ?? 0} — baixe o número (ou apague a linha se chegou a 0)`,
      );
    expect(folgas).toEqual([]);
  });

  // Controle: sem ele, um detector que nunca contasse nada passaria nos dois
  // casos acima com a lista inteira em zero.
  it("controle: conta lista dinâmica, ignora lista fixa e SearchableSelect", () => {
    const dinamica = `<SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>`;
    const nativa = `<select value={v}>{opcoes.map((o) => <option key={o}>{o}</option>)}</select>`;
    const fixa = `<SelectContent><SelectItem value="a">A</SelectItem><SelectItem value="b">B</SelectItem></SelectContent>`;
    const migrada = `<SearchableSelect options={agents.map((a) => ({ value: a.id, label: a.name }))} />`;

    expect(contarSelecoesDinamicas(dinamica)).toBe(1);
    expect(contarSelecoesDinamicas(nativa)).toBe(1);
    expect(contarSelecoesDinamicas(fixa)).toBe(0);
    expect(contarSelecoesDinamicas(migrada)).toBe(0);
  });
});
```

- [ ] **Passo 2: Rodar**

Run: `pnpm vitest run tests/unit/selecao-longa-tem-busca.test.ts`
Esperado: PASS, 3 testes.

Se o teste "só encolhe" reprovar: a Tarefa 4 ou 5 migrou mais (ou menos) caixas do que o registro supõe. Use o número **medido** que a mensagem mostra. Se o teste "nenhuma caixa nova" reprovar num arquivo que você não tocou: alguém pôs caixa nova na `escale/main` depois deste plano. Faça rebase e ajuste o número daquele arquivo **só** se a caixa já estava na base, nunca para acomodar código seu.

- [ ] **Passo 3: Provar que a cerca morde (e desfazer)**

Na própria cerca, mude temporariamente a entrada `"components/ai/UsageFilters.tsx": 1` para `0` e rode de novo.
Esperado: FAIL em "nenhuma caixa nova…" citando `components/ai/UsageFilters.tsx: 1 sem busca (registrado: 0)`. Volte o número para `1`.

- [ ] **Passo 4: Confirmar que entrou nas cercas**

Run: `pnpm cercas`
Esperado: PASS, e `tests/unit/selecao-longa-tem-busca.test.ts` aparece na lista de arquivos do projeto `cercas`.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add tests/unit/selecao-longa-tem-busca.test.ts
git commit -m "test: cerca — caixa de seleção de lista dinâmica nasce com busca

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tarefa 7: Documentação, fragmento e verificação completa

**Arquivos:**
- Modificar: `docs/design-system/06-components.md` (linha 13 + seção nova no fim)
- Criar: `.changes/caixas-de-selecao-com-busca.md`

- [ ] **Passo 1: Design system**

Em `docs/design-system/06-components.md`, trocar a linha 13:

```markdown
Próximas adições previstas (não instalados ainda): `tooltip`, `select`, `command`, `popover`, `toggle`, `progress`. Quando chegarem, atualizar este doc.
```

por:

```markdown
Próximas adições previstas (não instalados ainda): `command`, `toggle`, `progress`. Quando chegarem, atualizar este doc. (`tooltip`, `select` e `popover` já estão em `components/ui/`.)
```

E acrescentar no fim do arquivo:

````markdown
## SearchableSelect — caixa de seleção com busca

`components/ui/searchable-select.tsx`. Use no lugar do `Select` sempre que a lista vier de dado (modelos de IA, atendentes, etapas, credenciais, agentes). A busca só aparece a partir de 8 opções (`MINIMO_PARA_BUSCA`), então lista curta fica igual ao `Select`.

```tsx
<Label htmlFor="model">{t("Modelo")}</Label>
<SearchableSelect
  id="model"
  options={models.map((m) => ({ value: m.model_id, label: m.display_name, keywords: [m.model_id] }))}
  value={value || undefined}
  onValueChange={setValue}
  placeholder={t("Selecione um modelo")}
  searchPlaceholder={t("Buscar modelo…")}
  emptyMessage={t("Nenhum modelo encontrado")}
/>
```

- `label` é o que aparece e o que a busca procura. `keywords` é o que a pessoa digita mas não lê (o id técnico). O `value` não entra na busca.
- A busca ignora acento, caixa e pontuação, e aceita as palavras em qualquer ordem ("4 sonnet" acha "Claude Sonnet 4.6").
- Teclado: setas, Home/End, Enter escolhe, Esc fecha. Uma letra digitada no gatilho fechado abre a caixa já buscando por ela.
- Papéis ARIA iguais aos do `Select` (`combobox` / `option`): teste pela tela, não por detalhe do Radix.
- Valor fora da lista aparece cru no gatilho, em vez de deixá-lo em branco.
- Sem grupos (`SelectGroup`/`SelectLabel`). Lista agrupada continua no `Select` até alguém precisar disso de verdade.
- A cerca `tests/unit/selecao-longa-tem-busca.test.ts` impede caixa nova de lista dinâmica sem busca e lista o que ainda falta migrar.
````

- [ ] **Passo 2: Fragmento de release**

Criar `.changes/caixas-de-selecao-com-busca.md`:

```markdown
---
impacto: nada_mudou
secao: alterado
titulo: Escolher modelo de IA, chave, atendente, etapa ou agente agora tem busca
---

As caixas de seleção com listas longas ganharam uma barra de busca. No agente,
por exemplo, basta digitar parte do nome ou do identificador do modelo
("sonnet", "gpt-5", "anthropic/claude") em vez de rolar a lista inteira. A busca
ignora acento e maiúsculas e aparece a partir de 8 opções; listas curtas
continuam iguais. Valem também para os modelos dos provedores e do roteador,
a chave de acesso do agente, "Transferir para" na conversa, a etapa do funil na
conversa e o filtro de agente em Uso de IA.
```

- [ ] **Passo 3: Verificação completa**

Run (sem cortar a saída):
```bash
pnpm gov:verify
pnpm vitest run tests/unit/fragmentos-de-release.test.ts tests/unit/documentacao-aponta-para-o-que-existe.test.ts
```
Esperado: tudo verde. Se algo vermelho aparecer num arquivo que este plano não tocou, rode o mesmo teste na `escale/main` (`git stash`, rodar, `git stash pop`) para separar falha antiga de falha nova, e relate as duas.

- [ ] **Passo 4: Conferir na tela de verdade**

`pnpm gov:verify` não cobre e2e nem a aparência. Suba o app e confira à mão:

```bash
pnpm dev
```

1. Abra `http://localhost:3000/app/ai/agents`, entre num agente, clique em **Modelo**: a busca aparece focada; digite `sonnet` e só os Sonnet ficam; seta para baixo + Enter escolhe; Esc fecha e devolve o foco ao gatilho.
2. Num provedor com poucos modelos (menos de 8), a caixa abre **sem** busca.
3. Em **Agentes IA › Provedores**, o modelo padrão e o modelo de um ponto têm busca.
4. Numa conversa da Inbox, **Transferir para** (dentro do diálogo) abre e a lista rola com a roda do mouse. É isso que o `modal` do Popover garante.
5. Troque o idioma para espanhol: o placeholder vira "Buscar modelo…" e o vazio vira "No se encontró ningún modelo".

Se houver ambiente e2e montado, rode também a spec que já escolhe o modelo pelo papel `option`:

```bash
pnpm playwright test tests/e2e/agente-novo-e-uso.spec.ts
```

Esperado: PASS. O comentário nas linhas 95–98 da spec fala em "comboboxes do Radix". Continua verdade para o papel ARIA. Não precisa editar.

- [ ] **Passo 5: Commit (só com OK do usuário)**

```bash
git add docs/design-system/06-components.md .changes/caixas-de-selecao-com-busca.md
git commit -m "docs: SearchableSelect no design system e fragmento de release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Passo 6: PR (só com OK do usuário)**

Push e PR são feitos pelo usuário ou com OK explícito. Corpo sugerido: o que muda para quem usa (busca nas caixas longas), lista das 9 caixas migradas, a cerca e o número que ela deixa registrado (151 caixas dinâmicas ainda sem busca, em 85 arquivos), e o test plan dos Passos 3–4. Terminar com:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Fora deste plano (próximos passos, um PR por área)

A cerca da Tarefa 6 deixa registradas **151 caixas em 85 arquivos** que têm lista vinda de dado e ainda não têm busca. Migrar todas de uma vez seria um PR gigante e difícil de revisar. A ordem sugerida, pelo tamanho que essas listas costumam ter:

1. **Webhooks e automações:** `RuleEditor.tsx` (8), `ActionConfigForm.tsx` (8), que têm campos, etapas e funis.
2. **Fluxos de follow-up:** `forms/*.tsx` em `app/app/ai/followups/[id]/_components/`.
3. **Funis e equipe:** `settings/tenant/pipelines/*`, `team/*`, `kanban/*`.
4. **Campanhas e prospecção:** os `<select>` nativos de `campaigns/*` e `prospecting/_client.tsx`.

Cada migração segue a receita da Tarefa 5: montar `options` com `label` em texto puro, trocar o bloco, rodar os testes da tela e **baixar o número na cerca**.

Lista agrupada (`SelectGroup`/`SelectLabel`, ex.: `ModelosDialog.tsx`) fica de fora até um caso real pedir grupos no `SearchableSelect`.

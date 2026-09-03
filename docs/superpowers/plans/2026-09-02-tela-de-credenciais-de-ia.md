# Tela de credenciais de IA — Plano de implantação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir cinco defeitos visíveis em `/app/ai/credentials` (contagem de modelos, "Validando…" eterno, erro em código cru, diálogo sem ajuda, contagem de uso divergente da API) e, opcionalmente, tirar a chave do Google da query string.

**Architecture:** Toda regra nova vira função pura em `lib/ai/credenciais/` com teste unitário próprio; os componentes só consomem. A regra de "credencial em uso" passa a ter UMA implementação, consumida pela página e pelo `DELETE`. Nada de schema muda — `models_available` já é `text[]` no banco; o defeito é só de tipo no TypeScript.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript estrito, Vitest + Testing Library, Playwright, Zod, `useT()` para i18n.

**Spec:** Levantamento na conversa de 2026-09-02 (5 melhorias listadas a partir de `app/app/ai/credentials/**` e `app/api/v1/ai/credentials/**`). Não há spec separada; este plano é a spec.

## Global Constraints

- Toda string nova de tela passa por `t("...")` com a frase em português como chave, e ganha entrada `es` em `lib/i18n/dicionario.ts` — `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` reprova chave sem espanhol e prosa em português fora de `t()`.
- Sem `console.log`/`console.error` novo (anti-pattern 14).
- Sem mudança de schema. Se alguma tarefa parecer exigir migration, pare e reporte.
- A suíte que vale é `pnpm test:unit` **sem caminho**, com saída redirecionada (ver `CLAUDE.md` › Testes). `lib/ai/dispatcher/rate-limit.test.ts` pode ficar vermelho local por Redis desligado — não é deste PR.
- Branch a partir de `origin/main` atualizada: `git fetch origin && git merge --ff-only origin/main` antes de qualquer commit.
- Commits terminam com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Spec Playwright nova precisa entrar em `SPECS_PARTE_*` de `.github/workflows/e2e.yml`, senão `tests/unit/e2e-cobertura-completa.test.ts` reprova.

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `hooks/ai/useCredentials.ts` | Tipo `CredentialRow` e `credentialStatus()` — ganha status `unvalidated` |
| `lib/ai/credenciais/uso.ts` (novo) | `contarUsoPublicado()` — a regra única de "em uso" |
| `lib/ai/credenciais/erro-de-validacao.ts` (novo) | `descreverErroDeValidacao()` — código → frase |
| `lib/ai/pontos/provedores.ts` | Ganha `prefixoDaChave` por provedor |
| `app/app/ai/credentials/page.tsx` | Usa `contarUsoPublicado` |
| `app/api/v1/ai/credentials/[id]/route.ts` | Usa `contarUsoPublicado` |
| `app/app/ai/credentials/_components/CredentialCard.tsx` | Conta modelos, frase de erro, status novo, link para pegar chave |
| `app/app/ai/credentials/_components/AddCredentialDialog.tsx` | `quandoUsar`, link, placeholder por provedor, toast com contagem |
| `lib/i18n/dicionario.ts` | Entradas `es` das frases novas |
| `tests/e2e/credenciais-de-ia.spec.ts` (novo) | Prova pela tela |
| `.changes/tela-de-credenciais-de-ia.md` (novo) | Fragmento de release |

---

### Task 0: Branch

- [ ] **Step 1: Atualizar e criar branch**

```bash
git fetch origin && git merge --ff-only origin/main
git checkout -b fix/tela-de-credenciais-de-ia
```

Expected: `git status` limpo, branch nova em cima de `origin/main`.

---

### Task 1: `models_available` é lista, não número

**Files:**
- Modify: `hooks/ai/useCredentials.ts:22`
- Modify: `app/app/ai/credentials/_components/CredentialCard.tsx:135`
- Modify: `app/app/ai/credentials/_components/AddCredentialDialog.tsx:105-108`
- Test: `app/app/ai/credentials/_components/CredentialCard.test.tsx` (novo)

**Interfaces:**
- Produces: `CredentialRow.models_available: string[] | null` — Tasks 2, 3 e 8 dependem deste tipo.

- [ ] **Step 1: Escrever o teste que falha**

```tsx
// app/app/ai/credentials/_components/CredentialCard.test.tsx
/**
 * `models_available` é `text[]` no banco e chegava tipado como `number` no
 * hook. O card imprimia o array inteiro colado por vírgula ("claude-a,claude-b")
 * onde deveria haver uma contagem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CredentialCard } from "./CredentialCard";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));

export function credencial(extra: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "c1",
    organization_id: "o1",
    provider: "anthropic",
    label: "Produção",
    api_key_last4: "abcd",
    validated_at: "2026-09-02T00:00:00Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...extra,
  };
}

export function montar(row: CredentialRow, props: { canWrite?: boolean; usageCount?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CredentialCard credential={row} canWrite={props.canWrite ?? true} usageCount={props.usageCount ?? 0} />
    </QueryClientProvider>,
  );
}

describe("CredentialCard — modelos", () => {
  it("mostra a CONTAGEM de modelos, nunca a lista colada", () => {
    montar(credencial({ models_available: ["claude-a", "claude-b", "claude-c"] }));
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText(/claude-a,claude-b/)).toBeNull();
  });

  it("mostra travessão quando ainda não há lista", () => {
    montar(credencial({ models_available: null }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run app/app/ai/credentials/_components/CredentialCard.test.tsx`
Expected: FAIL — o primeiro caso não encontra "3" (encontra "claude-a,claude-b,claude-c"); typecheck do teste reclama que `string[]` não é `number`.

- [ ] **Step 3: Corrigir tipo e renderização**

`hooks/ai/useCredentials.ts:22`:

```ts
  models_available: string[] | null;
```

`CredentialCard.tsx:135`:

```tsx
          <dd className="font-mono">{credential.models_available?.length ?? "—"}</dd>
```

`AddCredentialDialog.tsx:105-108`:

```tsx
        if (justCreated?.models_available != null) {
          toast.success(
            `${t("Validada")} — ${justCreated.models_available.length} ${t("modelos disponíveis.")}`,
          );
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run app/app/ai/credentials/_components/CredentialCard.test.tsx && pnpm typecheck`
Expected: PASS, typecheck zerado.

- [ ] **Step 5: Commit**

```bash
git add hooks/ai/useCredentials.ts app/app/ai/credentials
git commit -m "fix(ia): card de credencial mostra contagem de modelos, não a lista colada

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: "Validando…" não é eterno

Quando o processo morre antes de a validação em segundo plano gravar (deploy, restart do contêiner), a linha fica com `validated_at` e `validation_error` nulos para sempre, e o card diz "Validando…" para sempre. A leitura honesta depois de um tempo é "não validada, clique em revalidar".

**Files:**
- Modify: `hooks/ai/useCredentials.ts:50-55`
- Modify: `app/app/ai/credentials/_components/CredentialCard.tsx:44-56`
- Modify: `lib/i18n/dicionario.ts`
- Test: `hooks/ai/useCredentials.test.ts` (novo)

**Interfaces:**
- Produces: `credentialStatus(row, agora?: number): "validated" | "validating" | "unvalidated" | "invalid" | "inactive"` e `export const JANELA_DE_VALIDACAO_MS = 2 * 60_000`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// hooks/ai/useCredentials.test.ts
/**
 * Credencial criada sem resultado de validação por mais de 2 minutos não está
 * "validando": o processo que validaria já morreu. Dizer "Validando…" para
 * sempre esconde do operador o único botão que resolve (revalidar).
 */
import { describe, expect, it } from "vitest";

import { credentialStatus, JANELA_DE_VALIDACAO_MS, type CredentialRow } from "./useCredentials";

const base: CredentialRow = {
  id: "c1", organization_id: "o1", provider: "anthropic", label: "x",
  api_key_last4: "abcd", validated_at: null, validation_error: null,
  models_available: null, is_active: true, created_by: null,
  created_at: "2026-09-02T12:00:00Z", updated_at: "2026-09-02T12:00:00Z",
};
const criadaEm = Date.parse(base.created_at);

describe("credentialStatus", () => {
  it("recém-criada sem resultado é 'validating'", () => {
    expect(credentialStatus(base, criadaEm + 10_000)).toBe("validating");
  });
  it("passada a janela sem resultado é 'unvalidated'", () => {
    expect(credentialStatus(base, criadaEm + JANELA_DE_VALIDACAO_MS + 1)).toBe("unvalidated");
  });
  it("erro gravado vence a janela", () => {
    expect(credentialStatus({ ...base, validation_error: "auth_failed_401" }, criadaEm)).toBe("invalid");
  });
  it("validada é validada", () => {
    expect(credentialStatus({ ...base, validated_at: base.created_at }, criadaEm + 1e9)).toBe("validated");
  });
  it("inativa vence tudo", () => {
    expect(credentialStatus({ ...base, is_active: false, validated_at: base.created_at }, criadaEm)).toBe("inactive");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run hooks/ai/useCredentials.test.ts`
Expected: FAIL — `JANELA_DE_VALIDACAO_MS` não exportado; segundo caso devolve "validating".

- [ ] **Step 3: Implementar**

`hooks/ai/useCredentials.ts:50-55` (substituir a função inteira):

```ts
/** Depois disto sem resultado, o processo que validaria já morreu. */
export const JANELA_DE_VALIDACAO_MS = 2 * 60_000;

export type CredentialStatus = "validated" | "validating" | "unvalidated" | "invalid" | "inactive";

export function credentialStatus(row: CredentialRow, agora: number = Date.now()): CredentialStatus {
  if (!row.is_active) return "inactive";
  if (row.validation_error) return "invalid";
  if (row.validated_at) return "validated";
  if (agora - Date.parse(row.created_at) > JANELA_DE_VALIDACAO_MS) return "unvalidated";
  return "validating";
}
```

`CredentialCard.tsx:44-56` — trocar `ReturnType<typeof credentialStatus>` por `CredentialStatus` (importar) e acrescentar a linha nova nos dois mapas:

```ts
const STATUS_LABEL: Record<CredentialStatus, string> = {
  validated: "Validada",
  validating: "Validando…",
  unvalidated: "Não validada",
  invalid: "Inválida",
  inactive: "Inativa",
};

const STATUS_VARIANT: Record<CredentialStatus, "default" | "secondary" | "destructive" | "outline"> = {
  validated: "default",
  validating: "secondary",
  unvalidated: "outline",
  invalid: "destructive",
  inactive: "outline",
};
```

E logo abaixo do bloco `{credential.validation_error && (...)}` (linha ~130), a dica de ação:

```tsx
      {status === "unvalidated" && (
        <p className="text-xs text-muted-foreground">
          {t("A validação não terminou. Clique em revalidar para testar a chave agora.")}
        </p>
      )}
```

`lib/i18n/dicionario.ts`, junto das entradas `Validada`/`Inválida` (linha ~1252):

```ts
  "Não validada": { es: "Sin validar" },
  "A validação não terminou. Clique em revalidar para testar a chave agora.": {
    es: "La validación no terminó. Haz clic en revalidar para probar la clave ahora.",
  },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run hooks/ai/useCredentials.test.ts app/app/ai/credentials tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Expected: PASS nos três; typecheck zerado.

- [ ] **Step 5: Commit**

```bash
git add hooks/ai/useCredentials.ts hooks/ai/useCredentials.test.ts app/app/ai/credentials/_components/CredentialCard.tsx lib/i18n/dicionario.ts
git commit -m "fix(ia): credencial sem resultado há mais de 2 min vira 'Não validada', não 'Validando…' eterno

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Erro de validação em frase, com link para pegar a chave

O card mostra `auth_failed_401`, `provider_status_429`, `AbortError`. Os códigos vêm de `lib/ai/provider-validators.ts` e ficam no banco como estão — o que muda é a tradução na borda da tela.

**Files:**
- Create: `lib/ai/credenciais/erro-de-validacao.ts`
- Test: `lib/ai/credenciais/erro-de-validacao.test.ts`
- Modify: `app/app/ai/credentials/_components/CredentialCard.tsx:126-130`
- Modify: `lib/i18n/dicionario.ts`

**Interfaces:**
- Produces: `descreverErroDeValidacao(codigo: string | null): { frase: string; chaveErrada: boolean }` — `frase` em pt-BR (chave para `t()`), `chaveErrada` diz se vale mostrar o link "pegar chave".

- [ ] **Step 1: Escrever o teste que falha**

```ts
// lib/ai/credenciais/erro-de-validacao.test.ts
import { describe, expect, it } from "vitest";

import { descreverErroDeValidacao } from "./erro-de-validacao";

describe("descreverErroDeValidacao", () => {
  it("401/403 é chave recusada, e aponta para onde pegar outra", () => {
    const r = descreverErroDeValidacao("auth_failed_401");
    expect(r.chaveErrada).toBe(true);
    expect(r.frase).toBe("O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.");
  });
  it("429 é limite do provedor", () => {
    expect(descreverErroDeValidacao("provider_status_429").frase).toBe(
      "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.",
    );
  });
  it("5xx é provedor fora", () => {
    expect(descreverErroDeValidacao("provider_status_503").frase).toBe(
      "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.",
    );
  });
  it("timeout e rede são a mesma frase", () => {
    const esperado = "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.";
    expect(descreverErroDeValidacao("AbortError").frase).toBe(esperado);
    expect(descreverErroDeValidacao("TimeoutError").frase).toBe(esperado);
    expect(descreverErroDeValidacao("network_error").frase).toBe(esperado);
  });
  it("código desconhecido não some: vira frase genérica COM o código", () => {
    const r = descreverErroDeValidacao("unknown_provider:foo");
    expect(r.chaveErrada).toBe(false);
    expect(r.frase).toBe("Falha na validação (unknown_provider:foo).");
  });
  it("null é string vazia", () => {
    expect(descreverErroDeValidacao(null).frase).toBe("");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/ai/credenciais/erro-de-validacao.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// lib/ai/credenciais/erro-de-validacao.ts
/**
 * Os códigos de `lib/ai/provider-validators.ts` são bons para o banco e para o
 * audit; para quem colou a chave e viu "auth_failed_401", não dizem nada.
 * Esta é a única tradução de código para frase — o card não conhece os códigos.
 *
 * As frases são chaves de `t()`: pt-BR aqui, espanhol em `lib/i18n/dicionario.ts`.
 */
export interface ErroDescrito {
  frase: string;
  /** Vale oferecer o link "pegar chave em…"? Só quando a chave em si é o problema. */
  chaveErrada: boolean;
}

const REDE = "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.";

export function descreverErroDeValidacao(codigo: string | null): ErroDescrito {
  if (!codigo) return { frase: "", chaveErrada: false };
  if (codigo === "auth_failed_401") {
    return {
      frase: "O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.",
      chaveErrada: true,
    };
  }
  if (codigo === "provider_status_429") {
    return {
      frase: "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.",
      chaveErrada: false,
    };
  }
  if (/^provider_status_5\d\d$/.test(codigo)) {
    return {
      frase: "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.",
      chaveErrada: false,
    };
  }
  if (codigo === "AbortError" || codigo === "TimeoutError" || codigo === "network_error") {
    return { frase: REDE, chaveErrada: false };
  }
  return { frase: `Falha na validação (${codigo}).`, chaveErrada: false };
}
```

`CredentialCard.tsx` — importar no topo:

```ts
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { descreverErroDeValidacao } from "@/lib/ai/credenciais/erro-de-validacao";
```

Dentro do componente, após `const inUse = usageCount > 0;`:

```ts
  const erro = descreverErroDeValidacao(credential.validation_error);
  const provedor = PROVEDORES.find((p) => p.id === credential.provider);
```

Substituir o bloco das linhas 126-130 por:

```tsx
      {credential.validation_error && (
        <p className="text-xs text-destructive" title={credential.validation_error}>
          {erro.frase.startsWith("Falha na validação (")
            ? `${t("Falha na validação")} (${credential.validation_error}).`
            : t(erro.frase)}
          {erro.chaveErrada && provedor && (
            <>
              {" "}
              <a
                className="underline underline-offset-4"
                href={provedor.ondePegarAChave}
                target="_blank"
                rel="noreferrer"
              >
                {t("Pegar chave em")} {provedor.rotulo}
              </a>
            </>
          )}
        </p>
      )}
```

(O caso genérico não passa por `t()` com o código dentro porque o código varia; a parte fixa "Falha na validação" é a chave.)

`lib/i18n/dicionario.ts`, ao lado das entradas da Task 2:

```ts
  "O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.": {
    es: "El proveedor rechazó la clave. Verifica que la copiaste entera o genera una nueva.",
  },
  "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.": {
    es: "El proveedor limitó las llamadas de esta clave. Inténtalo de nuevo en unos minutos.",
  },
  "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.": {
    es: "El proveedor está caído. La clave puede estar bien; revalida más tarde.",
  },
  "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.": {
    es: "No fue posible hablar con el proveedor desde este servidor. Revalida más tarde.",
  },
  "Falha na validação": { es: "Falla en la validación" },
  "Pegar chave em": { es: "Obtener clave en" },
```

- [ ] **Step 4: Teste de tela para o link**

Acrescentar em `CredentialCard.test.tsx` (reusa `credencial`/`montar` da Task 1):

```tsx
describe("CredentialCard — erro de validação", () => {
  it("401 vira frase e link para pegar chave nova", () => {
    montar(credencial({ validated_at: null, validation_error: "auth_failed_401" }));
    expect(screen.getByText(/recusou a chave/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pegar chave em/ })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
    expect(screen.queryByText("auth_failed_401")).toBeNull();
  });
  it("erro de rede não oferece link: a chave não é o problema", () => {
    montar(credencial({ validated_at: null, validation_error: "network_error" }));
    expect(screen.queryByRole("link", { name: /Pegar chave em/ })).toBeNull();
  });
});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run lib/ai/credenciais app/app/ai/credentials tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/credenciais/erro-de-validacao.ts lib/ai/credenciais/erro-de-validacao.test.ts app/app/ai/credentials/_components lib/i18n/dicionario.ts
git commit -m "fix(ia): erro de validação da credencial em frase, com link para gerar chave nova

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Diálogo ajuda a escolher e a achar a chave

`PROVEDORES` já tem `quandoUsar` e `ondePegarAChave`; o diálogo mostra só o rótulo e usa `sk-...` como placeholder para todo mundo (chave Google começa com `AIza`).

**Files:**
- Modify: `lib/ai/pontos/provedores.ts` (campo `prefixoDaChave`)
- Modify: `app/app/ai/credentials/_components/AddCredentialDialog.tsx:139-186`
- Modify: `lib/i18n/dicionario.ts`
- Test: `app/app/ai/credentials/_components/AddCredentialDialog.test.tsx` (novo)

**Interfaces:**
- Produces: `ProvedorSuportado.prefixoDaChave: string` (ex.: `"sk-ant-…"`).

- [ ] **Step 1: Escrever o teste que falha**

```tsx
// app/app/ai/credentials/_components/AddCredentialDialog.test.tsx
/**
 * O diálogo pedia "Provider / Label / API key" e nada mais. Quem nunca abriu
 * conta num provedor não sabia qual escolher nem onde a chave mora.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddCredentialDialog } from "./AddCredentialDialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));

function montar() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AddCredentialDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("AddCredentialDialog — ajuda ao escolher", () => {
  it("mostra quando usar o provedor selecionado (Anthropic por padrão)", () => {
    montar();
    expect(screen.getByText(/padrão recomendado para conversar com o cliente/)).toBeInTheDocument();
  });
  it("linka para onde pegar a chave do provedor selecionado", () => {
    montar();
    expect(screen.getByRole("link", { name: /Pegar chave em/ })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
  });
  it("placeholder da chave é o prefixo do provedor, não 'sk-...' genérico", () => {
    montar();
    expect(screen.getByLabelText(/API key/)).toHaveAttribute("placeholder", "sk-ant-…");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run app/app/ai/credentials/_components/AddCredentialDialog.test.tsx`
Expected: FAIL nos três casos.

- [ ] **Step 3: Implementar**

`lib/ai/pontos/provedores.ts` — na interface, após `ondePegarAChave`:

```ts
  /** Como a chave começa — vira placeholder do campo, para a pessoa reconhecer que copiou a coisa certa. */
  prefixoDaChave: string;
```

E em cada entrada de `PROVEDORES`:

```ts
    prefixoDaChave: "sk-ant-…",   // anthropic
    prefixoDaChave: "sk-…",       // openai
    prefixoDaChave: "AIza…",      // google
    prefixoDaChave: "sk-or-…",    // openrouter
```

`AddCredentialDialog.tsx` — dentro do componente, após os `useState`:

```ts
  const provedor = PROVEDORES.find((p) => p.id === provider) ?? PROVEDORES[0];
```

Substituir o bloco do select (linhas 140-157) por:

```tsx
          <div className="space-y-2">
            <Label htmlFor="cred-provider">{t("Provedor")}</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger id="cred-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVEDORES.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.rotulo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(provedor.quandoUsar)}</p>
            {errors.provider && (
              <p className="text-xs text-destructive">{errors.provider}</p>
            )}
          </div>
```

Substituir o bloco da API key (linhas 172-186) por:

```tsx
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="cred-key">{t("API key")}</Label>
              <a
                className="text-xs underline underline-offset-4"
                href={provedor.ondePegarAChave}
                target="_blank"
                rel="noreferrer"
              >
                {t("Pegar chave em")} {provedor.rotulo}
              </a>
            </div>
            <Input
              id="cred-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provedor.prefixoDaChave}
              autoComplete="off"
              required
            />
            {errors.api_key && (
              <p className="text-xs text-destructive">{errors.api_key}</p>
            )}
          </div>
```

Trocar também `t("Label")` (linha 160) por `t("Nome")` e o placeholder `t("Ex: Produção")` fica.

`lib/i18n/dicionario.ts` — as quatro frases de `quandoUsar` passam por `t()` agora, então precisam de `es`. Copiar cada `quandoUsar` de `provedores.ts` como chave (texto exato) e traduzir:

```ts
  "O padrão recomendado para conversar com o cliente: é o que melhor segue instruções longas e usa as ferramentas do CRM.": {
    es: "El estándar recomendado para conversar con el cliente: es el que mejor sigue instrucciones largas y usa las herramientas del CRM.",
  },
  "Necessário para transcrever áudio e para indexar o seu material — esses dois pontos usam tecnologia da OpenAI mesmo quando o resto está em outro provedor.": {
    es: "Necesario para transcribir audio e indexar tu material: esos dos puntos usan tecnología de OpenAI aunque el resto esté en otro proveedor.",
  },
  "Alternativa com contexto muito longo e custo baixo para tarefas de classificação.": {
    es: "Alternativa con contexto muy largo y bajo costo para tareas de clasificación.",
  },
  "Uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, inclusive os gratuitos. É o caminho mais simples para experimentar sem abrir conta em cada provedor.": {
    es: "Una sola clave da acceso a cientos de modelos de decenas de fabricantes, incluidos los gratuitos. Es el camino más simple para experimentar sin abrir cuenta en cada proveedor.",
  },
  Provedor: { es: "Proveedor" },
  Nome: { es: "Nombre" },
```

Antes de colar, conferir se `Provedor`/`Nome` já existem no dicionário (`grep -n '^  Provedor:\|^  Nome:' lib/i18n/dicionario.ts`); se existirem, não duplicar.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run app/app/ai/credentials tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/provedores-x-registry.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/pontos/provedores.ts app/app/ai/credentials/_components lib/i18n/dicionario.ts
git commit -m "feat(ia): diálogo de credencial diz quando usar cada provedor, onde pegar a chave e como ela começa

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: "Em uso" tem UMA regra, compartilhada pela tela e pelo DELETE

A página conta qualquer versão de agente ativo que aponte para a credencial; o `DELETE` só bloqueia se a versão é a `published_version_id`. Resultado: botão desabilitado com tooltip "em uso" quando a API deixaria excluir. A correção é uma função pura consumida pelos dois.

**Files:**
- Create: `lib/ai/credenciais/uso.ts`
- Test: `lib/ai/credenciais/uso.test.ts`
- Modify: `app/app/ai/credentials/page.tsx:34-61`
- Modify: `app/api/v1/ai/credentials/[id]/route.ts:45-71`

**Interfaces:**
- Produces:

```ts
export interface VersaoVinculada {
  id: string;
  credential_id: string;
  ai_agents: AgenteResumo | AgenteResumo[] | null;
}
export interface AgenteResumo { archived_at: string | null; published_version_id: string | null }
export function contarUsoPublicado(linhas: VersaoVinculada[]): Record<string, number>;
```

`contarUsoPublicado` devolve, por `credential_id`, quantos agentes NÃO arquivados têm esta versão como publicada. `DELETE` bloqueia se `(mapa[id] ?? 0) > 0`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// lib/ai/credenciais/uso.test.ts
/**
 * A tela e o DELETE tinham duas regras de "em uso" — a tela contava qualquer
 * versão de agente ativo, o DELETE só a publicada. Botão desabilitado com
 * tooltip "em uso" quando a API deixaria excluir. Uma regra, dois consumidores.
 */
import { describe, expect, it } from "vitest";

import { contarUsoPublicado, type VersaoVinculada } from "./uso";

const linha = (over: Partial<VersaoVinculada> & { publicada?: string | null; arquivado?: boolean }): VersaoVinculada => ({
  id: over.id ?? "v1",
  credential_id: over.credential_id ?? "c1",
  ai_agents: {
    archived_at: over.arquivado ? "2026-01-01T00:00:00Z" : null,
    published_version_id: over.publicada === undefined ? "v1" : over.publicada,
  },
});

describe("contarUsoPublicado", () => {
  it("conta só a versão que É a publicada do agente", () => {
    expect(contarUsoPublicado([linha({ id: "v1", publicada: "v1" })])).toEqual({ c1: 1 });
  });
  it("rascunho (versão não publicada) não conta", () => {
    expect(contarUsoPublicado([linha({ id: "v2", publicada: "v1" })])).toEqual({});
  });
  it("agente arquivado não conta", () => {
    expect(contarUsoPublicado([linha({ arquivado: true })])).toEqual({});
  });
  it("agente sem versão publicada não conta", () => {
    expect(contarUsoPublicado([linha({ publicada: null })])).toEqual({});
  });
  it("soma por credencial e aceita join como array", () => {
    const r = contarUsoPublicado([
      linha({ id: "v1", credential_id: "c1" }),
      { id: "v9", credential_id: "c1", ai_agents: [{ archived_at: null, published_version_id: "v9" }] },
      linha({ id: "v3", credential_id: "c2", publicada: "v3" }),
    ]);
    expect(r).toEqual({ c1: 2, c2: 1 });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/ai/credenciais/uso.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar a função**

```ts
// lib/ai/credenciais/uso.ts
/**
 * A REGRA de "credencial em uso": referenciada pela versão PUBLICADA de um
 * agente não arquivado. Rascunho não conta (o operador pode trocar a chave do
 * rascunho antes de publicar); arquivado não conta.
 *
 * Consumida pela tela (`app/app/ai/credentials/page.tsx`) e pelo
 * `DELETE /api/v1/ai/credentials/:id`. Enquanto eram duas cópias, divergiram.
 */
export interface AgenteResumo {
  archived_at: string | null;
  published_version_id: string | null;
}

export interface VersaoVinculada {
  id: string;
  credential_id: string;
  /** O PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
  ai_agents: AgenteResumo | AgenteResumo[] | null;
}

export function contarUsoPublicado(linhas: VersaoVinculada[]): Record<string, number> {
  const mapa: Record<string, number> = {};
  for (const linha of linhas) {
    const agente = Array.isArray(linha.ai_agents) ? linha.ai_agents[0] : linha.ai_agents;
    if (!agente || agente.archived_at) continue;
    if (agente.published_version_id !== linha.id) continue;
    mapa[linha.credential_id] = (mapa[linha.credential_id] ?? 0) + 1;
  }
  return mapa;
}
```

- [ ] **Step 4: Consumir na página**

`app/app/ai/credentials/page.tsx` — importar `import { contarUsoPublicado, type VersaoVinculada } from "@/lib/ai/credenciais/uso";` e substituir as linhas 34-61 por:

```ts
  // Mesma regra do DELETE: só conta a versão PUBLICADA de agente não arquivado.
  let usageMap: Record<string, number> = {};
  if (credentials.length > 0) {
    const { data: linked } = await supabase
      .from("ai_agent_versions")
      .select(
        "id, credential_id, ai_agents!ai_agent_versions_agent_id_fkey!inner(archived_at, published_version_id)",
      )
      .eq("organization_id", activeOrg.orgId)
      .in("credential_id", credentials.map((c) => c.id));
    usageMap = contarUsoPublicado((linked ?? []) as unknown as VersaoVinculada[]);
  }
```

- [ ] **Step 5: Consumir no DELETE**

`app/api/v1/ai/credentials/[id]/route.ts` — mesmo import; substituir as linhas 46-71 por:

```ts
  const { data: linked, error: linkErr } = await admin
    .from("ai_agent_versions")
    .select(
      "id, credential_id, ai_agents!ai_agent_versions_agent_id_fkey!inner(archived_at, published_version_id)",
    )
    .eq("credential_id", id)
    .eq("organization_id", activeOrg.orgId);

  if (linkErr) {
    return fail("internal_error", "Erro ao verificar uso da credential.", 500, { requestId });
  }

  const inUse = (contarUsoPublicado((linked ?? []) as unknown as VersaoVinculada[])[id] ?? 0) > 0;
```

Remover o tipo local `LinkedVersion` (ficou órfão).

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run lib/ai/credenciais && pnpm typecheck && pnpm lint`
Expected: PASS, zerados.

- [ ] **Step 7: Commit**

```bash
git add lib/ai/credenciais/uso.ts lib/ai/credenciais/uso.test.ts app/app/ai/credentials/page.tsx "app/api/v1/ai/credentials/[id]/route.ts"
git commit -m "fix(ia): tela e DELETE usam a mesma regra de 'credencial em uso' (só versão publicada)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6 (opcional, decisão do dono): chave do Google no header, não na URL

`validateGoogleKey` monta `?key=<chave>`. O comentário no código diz que é "o único endpoint público de discovery"; não é: a mesma API aceita `x-goog-api-key`. Vale a doutrina "API key NUNCA em query string". Executar só se o dono confirmar.

**Files:**
- Modify: `lib/ai/provider-validators.ts:92-113`
- Test: `tests/unit/chave-de-provedor-nunca-na-url.test.ts` (novo)

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/chave-de-provedor-nunca-na-url.test.ts
/**
 * Doutrina: API key nunca em query string (vaza em log de proxy, Referer e
 * histórico). O validador do Google mandava `?key=`; a API aceita header.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("validadores de chave de provedor", () => {
  it("nenhum monta a chave na URL", () => {
    const fonte = readFileSync(resolve(__dirname, "../../lib/ai/provider-validators.ts"), "utf8");
    expect(fonte).not.toMatch(/[?&]key=/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/chave-de-provedor-nunca-na-url.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Substituir o `try` de `validateGoogleKey` (comentário incluso) por:

```ts
export async function validateGoogleKey(apiKey: string): Promise<ValidationResult> {
  // A chave vai no header `x-goog-api-key`, nunca em `?key=`: query string
  // aparece em log de proxy e Referer, e a doutrina do repo proíbe.
  try {
    const res = await timedFetch("https://generativelanguage.googleapis.com/v1beta/models", {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
    });
```

O resto da função fica igual.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/chave-de-provedor-nunca-na-url.test.ts lib/ai && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/provider-validators.ts tests/unit/chave-de-provedor-nunca-na-url.test.ts
git commit -m "fix(ia): validador do Google manda a chave no header, não na query string

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Prova pela tela (Playwright) + registro no CI

Definition of Done 12: tocou UI, prova como leigo. A spec cria uma credencial com chave falsa e afirma que o card mostra uma FRASE (não um código) e o link para pegar chave. Com rede, o provedor devolve 401 → frase "recusou a chave"; sem rede, `network_error` → frase de rede. A asserção aceita qualquer frase humana e rejeita código cru.

**Files:**
- Create: `tests/e2e/credenciais-de-ia.spec.ts`
- Modify: `.github/workflows/e2e.yml` (acrescentar `credenciais-de-ia.spec.ts` em `SPECS_PARTE_1`, linha ~171)
- Modify: `docs/testing/user-journey-map.md` (jornada "Chaves de IA", `[P0]`)

- [ ] **Step 1: Escrever a spec**

```ts
// tests/e2e/credenciais-de-ia.spec.ts
/**
 * Jornada: admin cola uma chave de IA e entende o resultado sem ler código.
 * Antes, o card mostrava `auth_failed_401` e a lista de modelos colada por vírgula.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

interface E2ECreds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

function loadCreds(): E2ECreds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("Chaves de acesso à IA", () => {
  test("[P0] chave inválida vira frase legível, e a tela diz onde pegar outra", async ({ page }) => {
    await login(page, creds.users.admin!.email);
    await page.goto("/app/ai/credentials");

    const rotulo = `E2E ${Date.now()}`;
    await page.getByRole("button", { name: /adicionar credencial/i }).first().click();

    // O diálogo ajuda antes de pedir: diz quando usar e onde pegar a chave.
    await expect(page.getByText(/padrão recomendado para conversar/)).toBeVisible();
    await expect(page.getByRole("link", { name: /pegar chave em/i })).toHaveAttribute(
      "href",
      /console\.anthropic\.com/,
    );
    await expect(page.locator("#cred-key")).toHaveAttribute("placeholder", "sk-ant-…");

    await page.locator("#cred-label").fill(rotulo);
    await page.locator("#cred-key").fill("sk-ant-chave-falsa-para-e2e-0000");
    await page.getByRole("button", { name: /salvar e validar/i }).click();

    const card = page.locator("li", { hasText: rotulo });
    await expect(card).toBeVisible();

    // Resultado da validação em até 15 s (401 com rede; network_error sem).
    await expect(card.getByText(/recusou a chave|Não foi possível falar com o provedor/)).toBeVisible({
      timeout: 15_000,
    });
    // Código cru nunca aparece como texto visível.
    await expect(card.getByText(/^auth_failed_401$|^network_error$/)).toHaveCount(0);

    // Modelos: contagem ou travessão — nunca uma lista colada por vírgula.
    const modelos = await card.locator("dd").first().innerText();
    expect(modelos).toMatch(/^(\d+|—)$/);

    // Limpeza pela própria tela: não está em uso, então o botão está habilitado.
    await card.getByRole("button", { name: /excluir credencial/i }).click();
    await page.getByRole("button", { name: /^remover$/i }).click();
    await expect(card).toHaveCount(0);

    await page.screenshot({ path: ".superpowers/evidence/credenciais-de-ia.png", fullPage: true });
  });
});
```

- [ ] **Step 2: Registrar no CI**

Em `.github/workflows/e2e.yml`, dentro de `SPECS_PARTE_1: >-`, acrescentar uma linha:

```yaml
        credenciais-de-ia.spec.ts
```

Run: `pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts`
Expected: PASS (sem a linha, FAIL citando a spec nova).

- [ ] **Step 3: Rodar a spec localmente**

Pré-requisito: ambiente e2e de pé conforme `docs/testing/user-journey-map.md` (Supabase local pg17 + `next build && next start`).

Run: `pnpm exec playwright test tests/e2e/credenciais-de-ia.spec.ts`
Expected: 1 passed; arquivo `.superpowers/evidence/credenciais-de-ia.png` gerado.

- [ ] **Step 4: Mapa de jornadas**

Em `docs/testing/user-journey-map.md`, acrescentar na jornada de IA (ou criar seção "Chaves de acesso à IA"):

```markdown
- `[P0]` Colar chave inválida e entender o motivo — `tests/e2e/credenciais-de-ia.spec.ts`. Achados corrigidos em 2026-09-02: lista de modelos colada por vírgula no card; "Validando…" eterno após restart; erro em código (`auth_failed_401`); diálogo sem dizer quando usar cada provedor nem onde pegar a chave; contagem "em uso" divergente do DELETE.
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/credenciais-de-ia.spec.ts .github/workflows/e2e.yml docs/testing/user-journey-map.md .superpowers/evidence/credenciais-de-ia.png
git commit -m "test(e2e): jornada da tela de chaves de IA — erro legível, contagem de modelos, exclusão

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Fragmento de release, suíte inteira, PR

**Files:**
- Create: `.changes/tela-de-credenciais-de-ia.md`

- [ ] **Step 1: Fragmento**

```markdown
---
impacto: nada_mudou
secao: corrigido
titulo: A tela de chaves de IA explica o que deu errado e mostra quantos modelos a chave alcança
---

Quem colava uma chave de IA e errava via um código (`auth_failed_401`) no
lugar de uma explicação, e quem acertava via a lista de modelos inteira colada
por vírgula onde deveria haver um número. Se o servidor reiniciasse no meio da
validação, o cartão dizia "Validando…" para sempre.

Agora o cartão diz em português o que aconteceu ("O provedor recusou a chave.
Confira se copiou inteira ou gere uma nova."), com o link para gerar outra;
mostra a contagem de modelos; e, passados dois minutos sem resposta, troca
"Validando…" por "Não validada" com a dica de revalidar. O diálogo de adicionar
passa a dizer quando usar cada provedor, onde a chave mora e como ela começa.
O botão de excluir só fica bloqueado quando a chave está de fato numa versão
publicada de agente — a mesma regra que a API já usava.

Nenhuma configuração nova, nenhum passo de atualização.
```

Run: `pnpm release:conferir`
Expected: fragmento aceito.

- [ ] **Step 2: Suíte inteira, sem cortar a saída**

```bash
pnpm typecheck && pnpm lint
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
```

Expected: `Tests N passed` sem `failed`, exceto o vermelho conhecido de `lib/ai/dispatcher/rate-limit.test.ts` se o Redis local estiver desligado (5 casos). Qualquer outro vermelho é deste PR — corrigir antes de seguir.

- [ ] **Step 3: Commit e PR**

```bash
git add .changes/tela-de-credenciais-de-ia.md
git commit -m "docs(release): fragmento da tela de chaves de IA

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/tela-de-credenciais-de-ia
gh pr create --title "fix(ia): tela de chaves de IA explica o erro e conta os modelos" --body-file - <<'EOF'
## O que muda para quem opera

- Card mostra **quantos** modelos a chave alcança, não a lista colada.
- "Validando…" vira "Não validada" após 2 min sem resposta, com dica de revalidar.
- Erro de validação em frase, com link para gerar chave nova quando a chave é o problema.
- Diálogo de adicionar diz quando usar cada provedor, onde pegar a chave e como ela começa.
- Botão de excluir segue a mesma regra do DELETE (só versão publicada bloqueia).

## Prova

- Unit: `CredentialCard.test.tsx`, `AddCredentialDialog.test.tsx`, `useCredentials.test.ts`, `erro-de-validacao.test.ts`, `uso.test.ts`.
- E2E: `tests/e2e/credenciais-de-ia.spec.ts` (registrada em `SPECS_PARTE_1`). Evidência em `.superpowers/evidence/credenciais-de-ia.png`.
- Sem mudança de schema. Fragmento em `.changes/`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Auto-revisão

- **Cobertura:** melhoria 1 → Task 1; 2 → Task 2; 3 → Task 3; 4 → Task 4; 5 → Task 5; Google header → Task 6 (opcional); DoD 12 (prova pela tela) → Task 7; DoD 17 (fragmento) → Task 8.
- **Tipos entre tarefas:** `CredentialRow.models_available: string[] | null` (Task 1) usado nas Tasks 2, 3, 7; `CredentialStatus` (Task 2) usado nos mapas do card; `descreverErroDeValidacao` (Task 3) devolve `{ frase, chaveErrada }` e o card usa os dois; `contarUsoPublicado`/`VersaoVinculada` (Task 5) com o mesmo `select` nos dois consumidores; `prefixoDaChave` (Task 4) exigido pelo `satisfies` em todas as quatro entradas.
- **Risco conhecido:** a spec Playwright depende de o `li` do card conter o rótulo (estrutura atual de `CredentialsList`); se a lista mudar de `ul/li`, ajustar o seletor. `tests/unit/provedores-x-registry.test.ts` pode comparar shape de `PROVEDORES` — rodar depois da Task 4.

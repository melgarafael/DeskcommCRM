# PATCHES — divergências do fork Ânima em relação ao upstream

Cada arquivo do upstream alterado pelo fork entra aqui. Depois de todo sync, percorra esta lista e
confirme que cada patch continua aplicado.

**Superfície permitida** (`AGENTS.anima.md` §3) — alterações esperadas, registradas para conferência
no sync:

| Arquivo | O que muda | Desde | Como reaplicar se o sync sobrescrever |
|---|---|---|---|
| `AGENTS.md` | 1ª linha: `> Fork Ânima: leia também [AGENTS.anima.md](AGENTS.anima.md) antes de qualquer tarefa.` | 2026-11-26 | Recolocar a linha no topo |
| `CLAUDE.md` | 1ª linha: `@AGENTS.anima.md` | 2026-11-26 | Recolocar a linha no topo |
| `README.md` | 1ª linha: banner apontando para `docs/anima/README.md` | 2026-11-26 | Recolocar a linha no topo |
| `app/globals.css` — valores nos blocos `:root`, `[data-theme="light"]` e `[data-theme="dark"]` | Paleta, raios e sombras do DS | 2026-11-26 | `make ds-tokens` (🚧; hoje: `pnpm exec tsx scripts/anima/gerar-tokens-ds.ts && pnpm exec prettier --write lib/branding/regua-do-produto.ts`) |
| `app/globals.css` — token `--font-texto` no `:root`, `--font-sans: var(--font-texto)` no `@theme inline` e `var(--font-inter)` no `font-family` do `body` | Fonte Inter. O `@theme` só aceita variável que exista no `:root` (vigiado por `tests/unit/tailwind-tokens.test.ts`), por isso o token intermediário | 2026-11-26 | Reaplicar as três linhas à mão (procure `font-atkinson` no `@theme` e no `body`) |
| `app/layout.tsx` | Fonte Inter do pacote do DS (`--font-inter`) no `<html>`; tema escuro sem preferência salva (`THEME_INIT_SCRIPT` e `data-theme="dark"` no `<html>`) | 2026-11-26 | Reaplicar o bloco `const inter = localFont(...)`, a classe no `<html>` e o script |
| `package.json` / `pnpm-lock.yaml` | Dependência `@anima-solutions/design-system`; patch do Phosphor em `pnpm.patchedDependencies` | 2026-11-26 | `pnpm add @anima-solutions/design-system@<versão>`; recolocar a entrada do patch |
| `.npmrc` (novo) | Escopo `@anima-solutions` → GitHub Packages, token via `${NPM_TOKEN}` | 2026-11-26 | — (arquivo só do fork) |

**Fora da superfície permitida** (aprovados):

| Arquivo | Motivo | Aprovado por / data | Como reaplicar |
|---|---|---|---|
| `lib/theme.tsx` | Tema escuro como padrão: sem preferência salva, `readStoredTheme()` devolve `"dark"` (o upstream devolvia `"system"`). O servidor continua dizendo `"system"`, e por isso a hidratação bate (`lib/theme.test.tsx` passa sem alteração) | Responsável pelo fork, 2026-11-26 | Trocar o `return "system"` final de `readStoredTheme()` por `return "dark"` |
| `lib/branding/regua-do-produto.ts` | Arquivo **gerado** a partir do `globals.css` (comparado por `tests/unit/branding-regua-do-produto.test.ts`). Qualquer troca de paleta exige regenerá-lo | Responsável pelo fork, 2026-11-26 | Gerado pelo `scripts/anima/gerar-tokens-ds.ts` |
| `patches/@phosphor-icons__react@2.1.10.patch` (novo) | Peso padrão dos ícones Phosphor = `bold` (3 linhas nos builds ESM). Ícones com `weight=` explícito continuam como o upstream escolheu. Preferido a mexer em `lib/ui/icons.ts`, cuja lista de ícones muda a todo sync | Responsável pelo fork, 2026-11-26 | Quando o upstream subir o Phosphor, o `pnpm install` falha ao aplicar o patch: refazer com `pnpm patch @phosphor-icons/react@<versão>` trocando `"regular"` por `"bold"` em `dist/lib/{SSRBase,IconBase,context}.es.js` |
| `scripts/anima/gerar-tokens-ds.ts` (novo) | Gerador de tokens a partir do pacote do DS | Responsável pelo fork, 2026-11-26 | — (arquivo só do fork) |
| `lib/anima/tema-fixo.ts` (novo) | Tema fixo: organizações e instalação não trocam cor nem aparência (ver seção abaixo) | Responsável pelo fork, 2026-11-26 | — (arquivo só do fork) |
| `app/app/layout.tsx` | `semCorPropria(...)` na marca, `aparenciaFixa(...)` na aparência e `temaDeExtensaoFixo(...)` no tema de extensão | Responsável pelo fork, 2026-11-26 | Reenvolver as três chamadas; `grep -n tema-fixo` mostra onde |
| `app/layout.tsx` (além da fonte e do tema) | `marcaResolvida()` envolve `resolverMarca(...)` em `semCorPropria(...)` | Responsável pelo fork, 2026-11-26 | Idem |
| `lib/branding/saida.ts` | `marcaDaSaida()` envolve a marca em `semCorPropria(...)` (e-mail, ícone, MFA) | Responsável pelo fork, 2026-11-26 | Idem |
| `lib/navigation/interface.ts` | `permitidos()` filtra `rotaOcultaPeloTemaFixo(d.href)` (Aparência some do menu, do hub e do ⌘K) | Responsável pelo fork, 2026-11-26 | Recolocar a condição no filtro |
| `app/app/settings/aparencia/page.tsx` | `if (TEMA_FIXO) redirect("/app/settings/marca")` no início | Responsável pelo fork, 2026-11-26 | Recolocar a linha |
| `app/app/settings/marca/_form.tsx`, `app/admin/(protected)/marca/_form.tsx`, `app/admin/(protected)/marca/_estado.tsx` | Campos, prévia e linha de origem da cor escondidos quando `TEMA_FIXO` | Responsável pelo fork, 2026-11-26 | `hidden={TEMA_FIXO}` / `TEMA_FIXO ? null : …` nos pontos marcados |

**Valores copiados à mão do DS:** nenhum. Todo valor sai do pacote pelo gerador.

**Exceção à "regra de ouro" (`var()` do DS no CSS):** os tokens entram como **hex literal** gerado,
e não como `var(--token-do-ds)`, por três motivos medidos:

1. `extrairRegua()` (`lib/branding/contraste.ts`) lê hex literal desses blocos para montar a régua
   de contraste da marca de runtime. Um `var()` ali faz a extração lançar erro.
2. Os nomes do DS (`--primary`, `--radius-lg`, `--shadow-md`…) colidem com os do app, com outro
   significado.
3. O tema escuro do DS vale sob a classe `.dark`, e o app troca de tema por `[data-theme]`.

**Valores derivados** (o DS não os traz; a regra de cada um está no cabeçalho do gerador):

| Token | Derivação |
|---|---|
| `--color-accent-50…950` | Escada de luminosidade do upstream (`ESCADA_L`) com o matiz do `--brand-primary`; o limão entra literal no grau 100 |
| `--color-accent` (claro) | Grau 600 (`#506f00`), o primeiro que passa em todos os pisos medidos pelo upstream; texto branco |
| `--color-accent` (escuro) | O limão do DS (`#c5fe59`, grau 100); texto `--primary-foreground` do DS |
| `--color-neutral-50…950` | Escada de luminosidade dos neutros do upstream com o matiz do eixo preto↔branco da marca |
| `--color-{success,warning,error,info}-bg` | O papel do DS com 15% de opacidade (guia de cores do DS) |
| `--color-{success,warning,error,info}-fg` | O papel do DS com a luminosidade ajustada até 4,5:1 sobre o fundo atenuado |
| `--color-border` | `--border` do DS (translúcido) composto sobre o card |
| `--color-text-subtle`, `--color-border-strong` | Graus da escala de neutros, nas mesmas posições que o upstream usa |

## Testes do upstream de calibração (Sage)

Quatro testes do upstream calibram o **algoritmo** de marca (constantes `ESCADA_L`/`CURVA_C`,
caminhada de contraste, reconciliação de semânticas) contra a paleta de onde ele foi medido, a
Sage. Com a paleta Ânima no `globals.css`, 20 casos reprovavam sem que nenhum piso de contraste
falhasse. Pior: o caminho "redundância não cromática necessária" deixava de ser exercitado,
porque nenhuma semente o aciona sob a régua Ânima. Trocar os números esperados apagaria essa
cobertura.

**Solução (aprovada em 2026-11-26):** os testes passam a ler a Sage congelada, e os números do
upstream ficam intactos.

| Arquivo | Alteração (uma linha) |
|---|---|
| `tests/unit/branding-contraste.test.ts` | `const CSS = …` lê `tests/fixtures/anima/globals-sage.css` |
| `tests/unit/branding-rampa.test.ts` | idem |
| `tests/unit/branding-pares-pintados.test.ts` | idem, e `REGUA_DO_PRODUTO` importado de `tests/fixtures/anima/regua-sage.ts` |
| `tests/unit/branding-tema-escuro.test.ts` | `REGUA_DO_PRODUTO` importado de `tests/fixtures/anima/regua-sage.ts` |

Arquivos novos do fork:

- `tests/fixtures/anima/globals-sage.css`: cópia do `app/globals.css` do upstream.
- `tests/fixtures/anima/regua-sage.ts`: a régua extraída dela por `extrairRegua`.
- `tests/fixtures/anima/tema-livre.ts`: o `lib/anima/tema-fixo.ts` destravado, mesmas assinaturas.
- `tests/unit/anima-paleta-contraste.test.ts`: devolve à **paleta Ânima** as guardas que importam.
  O produto e as 16 marcas adversariais cabem nos pisos, a identidade do DS está onde foi
  decidida, e o `globals.css` está em dia com o pacote (`gerar-tokens-ds.ts --conferir`).
  Sabotado em 2026-11-26 (limão como destaque do claro): 5 testes reprovam.

### Testes "byte a byte" que congelam a identidade do upstream (aprovado em 2026-11-26)

Uma linha de `vi.mock` em cada um. O teste continua vigiando a estrutura, mas na condição do
upstream:

| Arquivo | Por que reprovava | Linha adicionada |
|---|---|---|
| `tests/unit/convite-email-html-preservado.test.ts` | E-mails usam os neutros Ânima (`NEUTROS_DE_SAIDA` sai da régua) | `vi.mock("@/lib/branding/regua-do-produto", …REGUA_SAGE)` e `vi` no import |
| `tests/unit/lgpd-texto-segue-o-pais.test.tsx` | Idem (e-mails de LGPD) | idem |
| `tests/unit/marca-contraste-do-tema-escuro.test.tsx` | A faixa de tons da cor some com o tema fixo | `vi.mock("@/lib/anima/tema-fixo", () => import("@/tests/fixtures/anima/tema-livre"))` |
| `tests/unit/branding-saida.test.ts` | O e-mail ignora a cor de marca com o tema fixo | `vi.mock("@/lib/anima/tema-fixo", () => import("@/tests/fixtures/anima/tema-livre"))` |
| `tests/unit/interface-por-empresa.test.ts` | Aparência sai do menu com o tema fixo | idem, e `vi` no import |
| `tests/unit/interface-por-vinculo.test.ts` | idem | idem, e `vi` no import |
| `tests/unit/grupos-sem-grupo-e-a-lista-de-hoje.test.tsx` | A fixture HTML traz o desenho dos ícones em peso regular, e o patch do Phosphor muda para bold | `vi.mock("@/lib/ui/icons", …)` com `weight: "regular"` como padrão, e `vi` no import |

### Falhas conhecidas que não são do fork

- `app/api/v1/prospecting/arquivo/route.test.ts` (3 casos, 422 no lugar de 201/415). Reprova
  também no commit do upstream sem nenhuma mudança Ânima. Causa não investigada; suspeita de
  ambiente (Node 27 na máquina local, e o projeto pede o 22).
- `app/app/settings/tenant/pipelines/_client.test.tsx` e `tests/unit/token-por-area/conversas.test.ts`
  reprovaram uma vez na suíte inteira e passam isolados (tempo esgotado sob carga).

**No sync:** se o upstream mexer na Sage ou nesses testes, atualize a fixture com
`git show vX.Y.Z:app/globals.css > tests/fixtures/anima/globals-sage.css` e reaplique as linhas da
tabela.

## Efeito colateral conhecido: cor de marca de organização no tema escuro

O destaque do escuro fica no grau 100 da escala (onde mora o limão). O algoritmo de marca de
runtime parte desse grau para QUALQUER cor configurada em `/admin/marca` ou em Configurações ›
Marca. Por isso, no modo escuro, uma cor de marca de cliente sai num tom pastel claro (ex.:
`#1c261d` → `#f4f5f4`; antes, `#8a948b`). Os pisos de contraste continuam garantidos (vigiados
em `anima-paleta-contraste.test.ts`). Na instalação Ânima, sem cor configurada, não há efeito.

# Handoff — o caso 131 do `filtro-por-marcador-pela-tela` só fica vermelho no PR #963

> Doc VIVO. Toda sessão que retomar isto lê daqui primeiro. Escrito em 2026-09-19,
> quando o terminal que coordenava a investigação morreu (`app_reopened`) com o
> resultado já medido e não entregue.

## O defeito, em uma linha

`tests/e2e/filtro-por-marcador-pela-tela.spec.ts:131` (Inbox #1206) estoura os 300 s no
clique da opção de marcador. **A spec não mudou**: ela passa na base e na main, e só
falha no PR #963 (`saraivabr:saraiva/social-native`).

## O que está MEDIDO (com a régua junto)

Só o **caso 131** compara entre os três SHAs — o total da parte 5 muda por SHA (50 / 53 /
52+1) e não é régua.

| SHA | run / job | caso 131 |
|---|---|---|
| base `92390306e` | 35452412529 / job 105921757650 | ✓ **11.1 s** |
| main `2b58c47a9` | 35462322078 / job 105948275435 | ✓ **8.1 s** |
| PR `63361d78c` | 35465018832 / job 105955670039 | ✘ **300 s** (1 failed / 52 passed) |

Verde **com relógio** nos dois primeiros — não é skip.

E a spec e o helper são idênticos nos três:

```bash
git diff 92390306e 63361d78c -- tests/e2e/filtro-por-marcador-pela-tela.spec.ts tests/e2e/qa-l12-comum.ts   # vazio
```

**Conclusão que isso sustenta:** a causa é o que a branch ADICIONA. Não é infra, não é o
teste, não é a base.

## A cronologia exata (trace do run vermelho)

Âncora do trace: `wallTime 1789847185632 ↔ monotonicTime 114891.375`.

| mono | o que aconteceu |
|---|---|
| 122159-122161 | `/contacts`, `/conversations?limit=50`, `/contact-tags` → invalidação do PATCH da tag, **querida** |
| 122164 | clique que ABRE o seletor |
| 122297 | começa a esperar a opção `vip-…` |
| **122506** | `locator resolved to <div role="option" …>` — apareceu **209 ms tarde** |
| 122510-122514 | `captura()` = `page.screenshot({ fullPage: true })` |
| **122591** | clique começa → `waiting for …` e **nunca resolve**, 300 s |

O call log tem **uma linha só**. O Playwright não chegou a tentar clicar: não é elemento
coberto, nem instável, nem fora da viewport — é elemento **ausente da árvore**. A
screenshot da falha confirma o estado final: seletor **fechado** ("Todas as tags"), sem
overlay. Dentro do caso são ~7 s até ali, contra 8,1 s na main: **carga de máquina não
explica**.

### O dado que mais estreita a busca

**Zero chamadas de API entre mono 122200 e 123200** — a janela em que a opção sai do DOM.
157 chamadas no caso inteiro, **nenhuma** com status >= 400. Logo:

1. nada veio do servidor para trocar os dados naquele instante;
2. a árvore de `<Providers>` **não** remontou (remontagem refaria as queries, e não há rede);
3. o que fechou o menu é efeito **puramente de cliente**.

E entre o locator resolver e o clique roda **uma coisa só**: o screenshot `fullPage`, que
redimensiona a viewport para a **altura do documento**.

## Candidatos, e o estado de cada um

| candidato | veredito | artefato |
|---|---|---|
| refetch de 30 s do `InboxFilters` | **morto** | experimento no run 35465018832 falhou igual; e `InboxFilters.tsx` não muda na branch |
| `FloatingInbox.tsx` (+359, novo) | **morto p/ este caso** | `components/inbox/FloatingInbox.tsx:40` → `if (rota?.startsWith("/app/inbox")) return null;` |
| `ChannelLogo.tsx` (+27, novo) | **morto** | `<span>` com ícone; zero rede, zero efeito |
| embed `social_platform:metadata->>…` em `_handler.ts:95` | **fraco** | coluna existe (`baseline.sql` → `"metadata" "jsonb" NOT NULL`); `/api/v1/conversations` respondeu **200 seis vezes** no run vermelho |
| laço de `draft-reply` (72 chamadas, 1 a cada ~4,1 s, não para) | **não é da branch** | `ReplyReviewPanel.tsx` tem `refetchInterval: 4000` e **não muda** no diff |
| `activeOrg` piscando → `AuthProvider.tsx:89` remonta tudo | **enfraquecido** | remontagem exigiria rede na janela, e não há |
| **`LeadEnrichment` (+131, novo) deixa a página mais ALTA → o resize do `fullPage` é maior** | **vivo, não medido** | visível na screenshot como "Sobre a empresa"; é o único que explica base-verde/PR-vermelho com spec idêntica |

## O próximo passo (instrumentação, já escrita)

Commit de experimento na branch, **para reverter depois**. Mede o mecanismo, não um bit:

- `MutationObserver` em `documentElement` grava cada entrada/saída de `[role=listbox]` e
  `[role=option]` com `performance.now()`, contagem, **`scrollHeight` e `innerHeight`**,
  mais `resize` e `focusin`. Observer **em vez de** amostrar a cada 100 ms: a janela é de
  85 ms e a amostra erraria.
- `olha()` **antes e depois** do `captura()` — é o que separa "o screenshot é o gatilho"
  de "a opção já tinha saído antes dele".
- `page.on('console' | 'response' >= 400 | 'requestfailed')`.
- clique com `timeout: 15_000` no lugar de 300 s: economiza ~285 s de CI, e o valor está
  no filme.

## Armadilhas de instrumento pagas nesta investigação

1. **`frame-snapshot` do trace é INCREMENTAL.** Presença é dado; **ausência não é**. Um
   deles marca o menu como fechado num instante em que ele comprovadamente estava aberto.
   Uma tabela inteira de "a lista oscila 2→1→0" foi montada com isso e descartada.
2. **O trace guardou `content.text` com 0 bytes** em todas as respostas — não dá para
   afirmar o que voltou no corpo, só o status.
3. **Run verde não sobe artifact**, então não há trace do verde para comparar.
4. **Sonda cega dá zero plausível**: `awk '/CREATE TABLE (public\.)?channel_sessions/'` deu
   zero porque o baseline escreve `CREATE TABLE IF NOT EXISTS "public"."channel_sessions"`.
   O controle positivo (contar as linhas que o `awk` devolve) acusou antes de o zero virar
   afirmação.

## Higiene desta branch

`cb/963` é cópia local de `refs/pull/963/head` — de um **fork**. O push vai para
`https://github.com/saraivabr/DeskcommCRM.git HEAD:saraiva/social-native`, nunca para
`origin` (lá ele cria uma branch nova e o trabalho não chega ao PR). Um experimento
anterior já foi revertido (`eb86b07d0`); `InboxFilters.tsx` bate byte a byte com a base.

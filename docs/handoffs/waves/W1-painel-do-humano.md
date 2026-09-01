# W1 — O painel de quem configura o agente

**Worktree:** `/Users/rafaelmelgaco/SonghaiCRM-ia360-w1-painel` (branch `feat/ia-360-w1-painel`, base `d25cd1c`)
**Pacote alvo:** infraestrutura de apresentação — serve todas as outras waves.

---

## CONTEXTO

Leia **antes de tudo**, nesta ordem:

1. `docs/handoffs/BRIEFING-ia-360.md` — o contrato inteiro. Não é opcional.
2. `docs/doctrine/sistema-vivo.md` — a lei de arquitetura do repo.
3. `HANDOFF-ia-360.md` — a linha de base medida e o que a Wave 0 já entregou.

O resumo do porquê: o SonghaiCRM tem um agente de IA que sabe conversar mas não sabe operar, e o
humano que configura esse agente é dono de clínica, de loja, de imobiliária — não engenheiro. Hoje
a tela de configuração mostra `crm_search_contacts` em fonte monoespaçada, agrupado por
"Leitura / Escrita / Especiais", sem dizer o que a capacidade toca, o que ela pode estragar, nem
quantas vezes foi usada.

A Wave 0 já entregou o **contrato de dados**: `lib/mcp/tools/catalogo/` com `rotulo`, `explicacao`,
`oQueToca`, `risco` e `pacotes` preenchidos nas 16 tools existentes, mais o gate mecânico em
`tests/unit/catalogo-tools-leigo-friendly.test.ts` (54 testes, verde).

**Falta a tela.** O dado existe e ninguém vê.

## FUNÇÃO

Você é o dono da camada que o humano enxerga. As outras três waves vão despejar dezenas de
capacidades novas no catálogo; se a tela não estiver pronta para isso, elas chegam como uma lista
ilegível de checkboxes e o pilar 2 morre.

## DIRECIONAMENTO

### 1. A rota tem que servir os campos novos

`app/api/v1/mcp/tools/route.ts` hoje monta a resposta a partir de `allTools` (os handlers), que
**não** carregam a camada de apresentação — ela vive em `TOOL_CATALOG`. Junte os dois por `name`.

Se um handler não tiver entrada no catálogo (ou vice-versa), **falhe alto** — não sirva a tool com
rótulo vazio. Já existe uma checagem desse tipo em `lib/mcp/tools/index.ts`; siga o mesmo padrão.

Acrescente à resposta os campos: `rotulo`, `explicacao`, `o_que_toca`, `risco`, `pacotes`
(snake_case no wire, conforme a convenção da API no `CLAUDE.md`).

### 2. O ToolPicker por pacote

`app/app/ai/agents/[id]/_components/ToolPicker.tsx` — reconstrua.

- **Caminho padrão:** os 6 pacotes de `lib/mcp/tools/pacotes.ts`, cada um com rótulo, explicação e
  a contagem de capacidades. Ligar um pacote liga as capacidades dele.
- **`entraPorPacote()` é lei:** capacidade de risco `critico` **nunca** é ligada por pacote. Ligar
  "Atender e responder" não pode, sozinho, dar ao agente o direito de mandar mensagem de WhatsApp
  para o cliente. Ela aparece destacada, exigindo marcação individual.
- **Modo avançado:** um disclosure que revela o checkbox por capacidade, com a ficha de cada uma
  (rótulo, explicação, o que toca, risco). O `name` técnico só aparece aqui.
- **O teto de 20 continua valendo** (`lib/ai/agents/validation.ts`). Com pacotes ele fica fácil de
  estourar sem perceber — mostre o consumo (`13 de 20`) e impeça a passagem, explicando por quê em
  português: mais capacidades do que isso confundem o agente na hora de escolher.

### 3. Observabilidade — o pilar 2 não é só configurar

Toda chamada de tool já é auditada em `api_audit_log` via `lib/mcp/audit.ts` (`auditMcpToolCall`).
Esse dado **não aparece em lugar nenhum da tela**. Log invisível é log morto (invariante 3).

Entregue a leitura disso na página do agente: por capacidade, quantas vezes foi usada, quantas
falharam, e a última vez. Existe `RunsTable`/`RunTrace` na mesma pasta — decida se estende ou se
cria uma aba própria, mas **cada número tem que responder "e daí?"** (invariante 5): o humano olha
e sabe o que fazer — desligar uma capacidade que só dá erro, ou perceber que ligou algo que nunca
é usado.

## OBJETIVO

Que o dono de uma clínica abra a configuração do agente, entenda em 30 segundos o que aquilo faz,
ligue "Atender e responder" com confiança, e depois consiga olhar e saber se está funcionando.

## RESULTADO ESPERADO

- `pnpm typecheck` limpo, `pnpm lint` sem erros novos, `pnpm test:unit` verde.
- **E2E em tela com Playwright**, logado como usuário real, provando: ligar um pacote marca as
  capacidades certas; capacidade `critico` não entra por pacote; o modo avançado abre; o consumo
  do teto aparece; o painel de uso mostra número real. Evidência visual salva.
- Medidas de front-end **por ferramenta** (`getBoundingClientRect` / `getComputedStyle`), nunca a
  olho.
- `HANDOFF-ia-360.md` alimentado com o que entregou, com SHA.
- Commits atômicos `feat(ia-360): <slug>`.

**Sabote antes de confiar.** Todo teste novo: quebre a propriedade de propósito, confirme que
reprova, desfaça. Teste que nunca vermelheceu não prova nada.

## LIMITES

- Não toque em `lib/mcp/tools/catalogo/*` além de **ler** — as outras waves estão escrevendo lá.
- Não renomeie nenhum `name` de tool (contrato de wire — quebra agente publicado em VPS).
- Não mexa em RBAC nem no engine de envio.
- Travou? Reporte ao Maestro com o que tentou e o que observou. Não fique parado.

# BRIEFING — IA 360 no SonghaiCRM

> **Leia isto inteiro antes de escrever uma linha de código.** Este documento é o contrato.
> Quem implementar sem ler vai divergir do resto do time e o trabalho será rejeitado no review.
>
> Branch: `feat/ia-360-mcp` · Base: `origin/main` = `687716a` · Maestro: terminal "Assistente e Testes"

---

## 1. Por que estamos fazendo isto (o motivo, não a tarefa)

O SonghaiCRM tem hoje **um agente de IA que sabe conversar, mas não sabe operar**.

Ele lê contatos, lê conversas, mexe em lead, pede socorro humano — e para. Toda a máquina que
mantém o cliente vivo (follow-up, casos, webhooks, automações, skills, propostas, conhecimento,
atendentes, memória da organização) **existe no banco, roda em worker, aparece em tela — e é
invisível para a IA**.

Números medidos em `687716a`:

| Medida | Valor |
|---|---|
| Tools no catálogo MCP | **16** (9 leitura, 6 escrita, 1 handoff) |
| Tabelas no `baseline.sql` | **~100** |
| Tabelas alcançáveis pelas 16 tools | **~8** |
| Tools de follow-up (o anti-morte da doutrina) | **0** |
| Operações de arquivamento/encerramento expostas à IA | **0** |
| Tools nativas do engine invisíveis na tela | **7** |

O produto é distribuído open-source: **quem instala numa VPS recebe exatamente isto**. Um agente
que não consegue agendar um follow-up não consegue cumprir a missão do sistema.

### A missão, em uma frase

> Chegou uma demanda — um lead interessado ou um usuário com um problema — e o sistema é
> **responsável pela linha do tempo inteira dessa demanda até a resolução ou o encerramento
> declarado pelo próprio lead.**

Fonte: `docs/doctrine/sistema-vivo.md`. **Leia a doutrina inteira antes de começar.** Ela não é
aspiração, é critério de aceite.

---

## 2. Os três pilares (o resultado esperado)

**Pilar 1 — a IA tem mãos.** Cobertura de leitura, escrita, atualização e arquivamento sobre os
recursos do fluxo de atendimento/suporte/vendas: leads, atendentes, handoff, webhooks, skills,
propostas, follow-up, conhecimento, funis, contatos, conversas, templates, memória, pedidos.

**Pilar 2 — o humano tem painel.** Quem configura o agente enxerga o que cada capacidade faz, o
que ela toca, o que ela pode estragar, quantas vezes foi usada e com que resultado. Controle,
observabilidade e acesso suficientes para operar com maestria.

**Pilar 3 — tudo em língua de gente.** O público-alvo é dono de clínica, de loja, de imobiliária.
Não é engenheiro. `crm_move_lead_stage` em fonte monoespaçada não configura nada.

---

## 3. As quatro decisões de arquitetura (aprovadas — não reabra)

### Decisão 1 — Pacotes de capacidade, não 60 checkboxes

O teto de 20 tools por agente **não é burrice**: 60 tools num prompt degradam o modelo (erra a
escolha, gasta contexto, alucina argumento) e 60 checkboxes destroem a tela do leigo.

A saída é uma camada acima: **Pacotes por jornada**. O humano liga o pacote; o sistema resolve as
tools. O checkbox por tool continua existindo em "modo avançado".

### Decisão 2 — Nada é apagado de verdade

Onde a especificação disser "delete", entregue **arquivar / encerrar / anonimizar**. Nunca
`DELETE` físico em dado de cliente. Apagar lead cascateia mensagens e destrói histórico — é o
anti-pattern 7 do `CLAUDE.md`, e a doutrina de LGPD do repo já manda anonimizar.

Para o usuário o botão se chama "Arquivar" e o efeito é o esperado. Para o banco, o histórico
sobrevive.

### Decisão 3 — Rótulo é camada, `name` é contrato

**Proibido renomear tool existente.** O campo `name` é contrato de wire: agentes já publicados em
VPS de clientes e clientes MCP externos quebram. O nome amigável entra como **camada de
apresentação** sobre o mesmo catálogo.

### Decisão 4 — A tool nunca reimplementa a regra de negócio

Existem ~140 rotas em `app/api/v1/` que já contêm a regra. A tool é **fachada fina**. Ordem de
preferência, obrigatória:

1. Já existe função em `lib/<dominio>/` → **chama**.
2. A regra está dentro de `app/api/v1/.../route.ts` → **extrai** para `lib/<dominio>/operations.ts`
   e o `route.ts` passa a chamar a função extraída. O teste existente da rota é a rede de segurança.
3. **Nunca duplicar SQL** entre route e tool. Se a IA e o humano operarem por regras diferentes,
   o sistema mente para um dos dois.

Assinatura canônica da função extraída:

```ts
export async function moverLeadDeEtapa(
  deps: { supabase: SupabaseClient; organizationId: string; actor: Actor; requestId: string },
  input: { leadId: string; stageId: string; expectedUpdatedAt?: string },
): Promise<{ lead: Lead; atividade: string }>
```

`deps` primeiro, `input` depois. Lança `ApiError` do repo. Nunca lê `organization_id` do input.

---

## 4. O contrato do catálogo (o formato que todos seguem)

Arquivo: `lib/mcp/tools/catalog.ts`. Toda entrada nova segue este shape:

```ts
export type McpToolCategory = "read" | "write" | "handoff";  // MANTIDO — dirige scope/role
export type ToolRisk = "seguro" | "atencao" | "critico";
export type ToolBundle = "atender" | "vender" | "reter" | "escalar" | "organizar" | "evoluir";

export interface McpToolCatalogEntry {
  name: string;              // CONTRATO DE WIRE — imutável depois de publicado
  category: McpToolCategory; // dirige requiresScope/requiresRole — não é rótulo
  // `description` VIVIA AQUI e foi REMOVIDA em 2026-08-07: nenhum consumidor a
  // lia (a ponte do turno monta a do HANDLER) e 48 das 51 divergiam do que o
  // modelo recebia de verdade. O texto que vai ao modelo é a `description` de
  // `lib/mcp/tools/<dominio>.ts`, e não há cópia dele neste catálogo.

  // camada de apresentação (pilar 3) — vai para o HUMANO:
  rotulo: string;        // "Mover lead de etapa" — verbo no infinitivo, pt-BR
  explicacao: string;    // o que faz, em português de gente, >= 40 caracteres
  oQueToca: string;      // "Funil de vendas" — o recurso na linguagem do usuário
  risco: ToolRisk;
  pacotes: ToolBundle[]; // >= 1
}
```

### Os seis pacotes (jornadas)

| Pacote | Rótulo na tela | Contém |
|---|---|---|
| `atender` | Atender e responder | conversas, mensagens, contatos, conhecimento, templates |
| `vender` | Vender e mover o funil | leads, etapas, score, pedidos, produtos |
| `reter` | Não perder o cliente | follow-up, risco, reativação, checkpoints |
| `escalar` | Passar para um humano | handoff, casos, atendentes, atribuição |
| `organizar` | Organizar a operação | funis, etapas, tags, time, webhooks, automações |
| `evoluir` | Aprender e evoluir | conhecimento, skills, propostas, memória da org |

### Os três níveis de risco

| Risco | Significa | Consequência na UI |
|---|---|---|
| `seguro` | só lê, não muda nada | entra por pacote, sem cerimônia |
| `atencao` | escreve no CRM, reversível pela tela | entra por pacote, mostra aviso |
| `critico` | efeito externo ou difícil de desfazer | **nunca entra por pacote sozinha** — exige marcação explícita do humano |

`critico` inclui: enviar mensagem ao cliente, disparar webhook externo, arquivar/encerrar,
aprovar proposta do flywheel, alterar automação que roda sozinha.

### Regras de escrita do `rotulo` e da `explicacao`

- **Verbo no infinitivo**, sem jargão. "Agendar retorno", não "Criar enrollment de followup".
- **Proibido no texto do humano**: `MCP`, `API`, `endpoint`, `payload`, `UUID`, `schema`, `query`,
  `webhook` (use "aviso automático"), `enrollment`, `pointer`, nome de tabela, nome de coluna.
- A `explicacao` responde **"o que acontece quando a IA usa isto"**, não "o que o código faz".

Isto é verificado mecanicamente. Ver seção 6.

---

## 5. O gate do sistema vivo (obrigatório por tool)

Antes de considerar uma tool pronta, responda as 7 perguntas. Não é formalidade — é o que separa
capacidade viva de ilha com fachada.

```
Living System Checklist — <nome da tool>
[ ] Quem me alimenta?           (aresta de entrada — fonte real, nunca do body)
[ ] Quem eu alimento?           (aresta de saída — a peça distribui)
[ ] Que atividade/log eu emito? (event_log / api_audit_log / crm_lead_activities)
[ ] Onde eu apareço na tela?    (timeline/insight — log só no banco é log morto)
[ ] Qual meu mecanismo anti-morte? (próximo passo garantido, ou N/A justificado)
[ ] Qual a continuidade IA<->humano? (payload nas duas direções, se toca handoff)
[ ] Atualizei o mapa vivo?      (docs/architecture/*.json + re-render)
```

**Atenção — o comentário não é o gate.** Escrever o checklist num bloco de comentário no topo do
arquivo é documentação para o humano. `typecheck` e `lint` passam com comentário falso dentro.
O enforcement real é comportamental: ver seção 6.

Regra dura: **toda tool de escrita emite atividade visível.** Se a tool mexe em lead, emite
`crm_lead_activities` via `lib/leads/activity-emitter.ts` — não invente emissor novo, e nunca use
string literal para o tipo de atividade (use a constante compartilhada, ver
`lib/leads/activity-vocabulary.ts`).

---

## 6. Como se prova que está pronto

Nada é declarado pronto sem evidência observada. "Rodei e passou" sem output colado não conta.

### Obrigatório em toda entrega

1. `pnpm typecheck` — zerado
2. `pnpm lint` — zerado
3. `pnpm test:unit` — verde
4. `pnpm test:db` — verde **se tocou schema, RLS ou emissão de atividade**
   (`test:unit` NÃO inclui `tests/invariants/**` — concluir "está tudo verde" só com `test:unit`
   é falso verde; os invariantes precisam de Postgres real)
5. **E2E em tela com Playwright**, logado como usuário real. `curl` só como diagnóstico —
   não prova UX. Evidência visual salva.

### Os testes de invariante que este épico adiciona

- `tests/unit/catalogo-tools-leigo-friendly.test.ts` **(já existe — Wave 0, verde)** — reprova se qualquer entrada do
  catálogo tiver `rotulo` vazio, `explicacao` < 40 chars, jargão da lista proibida, `risco`
  ausente ou `pacotes` vazio. **Isto é o gate do pilar 3** — sem ele a regra apodrece na primeira
  pressa.
- `tests/invariants/tool-de-escrita-emite-atividade.test.ts` — para toda tool `category: "write"`,
  executa o handler contra Postgres real e verifica que a linha apareceu em `api_audit_log`; para
  as que tocam lead, verifica `crm_lead_activities`. **Isto é o gate do invariante 3** — e é
  comportamental, não textual.

**Sabote o teste antes de confiar nele.** Um teste que nunca vermelheceu não prova nada: quebre a
propriedade de propósito, confirme que reprova, desfaça. Sem esse passo, você tem um teste que
acerta por sorte.

---

## 7. Regras de banco e distribuição (VPS)

Este projeto é open-source e instalado em VPS de terceiros. **Toda mudança de schema sai em três
artefatos, sempre juntos:**

1. Migration versionada em `supabase/migrations/<timestamp>_<NNNN>_<slug>.sql` — idempotente
   (`add column if not exists`, `create or replace function`), portável em `psql` puro, **sem**
   `BEGIN`/`COMMIT` explícito.
2. Apêndice idempotente e auto-curativo no fim de `supabase/baseline.sql`, com bloco rotulado
   `-- ---- <coisa> (migration NNNN) ----`. **O kit self-host aplica só o baseline.** Migration
   que não chega ao baseline não chega ao cliente.
3. Linha em `supabase/migrations/MANIFEST.md` (tabela "Applied") com o quê e o porquê.

Se a mudança adiciona constraint, **corrija/deduplique os dados ANTES** de criar a constraint —
senão o `update.sh` de um clone com dados sujos quebra.

**O kit de instalação não pode quebrar.** Se mexer em `hostgator-setup-kit/`, valide num Postgres
descartável (`pgvector/pgvector:pg17`): `install` em banco novo com `ON_ERROR_STOP=1`, e `update`
re-aplicando em banco existente sem a flag. Os dois têm que passar.

---

## 8. Higiene de trabalho

- **Branch:** trabalhe no worktree que o Maestro indicar. Não toque em worktree alheio, nem em
  árvore suja que não é sua (`git status` + `git worktree list` antes).
- **Antes de começar**, atualize contra a `main`: `git fetch origin && git merge origin/main`.
  Nunca `reset --hard` para "atualizar" — isso apaga trabalho.
- **Commits atômicos**, um por marco entregue, mensagem `feat(ia-360): <slug>`.
- **Nunca dois implementadores no mesmo worktree ao mesmo tempo.** Revisores read-only podem.
- Toda afirmação de estado declara o **SHA curto** e o `git status`. Medir contra disco sujo é
  medir contra nada.

---

## 9. Onde reportar

- **Progresso, bug encontrado, bug corrigido** → `HANDOFF-ia-360.md` na raiz do worktree, com SHA
  em cada afirmação. Alimentado a **cada** marco, não no fim.
- **Status ao Maestro** → `lina ask "@Assistente e Testes" "<status>" --intent status`.
- **Travou** → reporte com o que tentou e o que observou. Não fique parado esperando; traga o
  problema já mastigado e um caminho.

**Bug encontrado é para consertar na causa raiz**, não para devolver ao Maestro. Fix temporário,
`try/catch` que engole erro, ou "vou só silenciar esse warning" são reprovados no review.

---

## 10. Fora de escopo (não expanda por conta própria)

- Trocar o modelo de permissão RBAC.
- Mexer no engine de envio / anti-ban (`runBeforeSend` e a cadeia de gates).
- MCP público para terceiros.

Se algum destes virar bloqueio real, **avise o Maestro** em vez de resolver sozinho.

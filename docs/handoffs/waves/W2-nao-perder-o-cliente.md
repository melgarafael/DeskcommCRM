# W2 — Não perder o cliente (pacote `reter`)

**Worktree:** `/Users/rafaelmelgaco/SonghaiCRM-ia360-w2-reter` (branch `feat/ia-360-w2-reter`, base `d25cd1c`)
**Pacote alvo:** `reter` — hoje **vazio**. Esta é a wave mais importante do épico.

---

## CONTEXTO

Leia **antes de tudo**, nesta ordem:

1. `docs/handoffs/BRIEFING-ia-360.md` — o contrato inteiro. Não é opcional.
2. `docs/doctrine/sistema-vivo.md` — a lei de arquitetura. **Leia o invariante 4 duas vezes.**
3. `HANDOFF-ia-360.md` — a linha de base medida.

### Por que esta wave existe

A doutrina do repo diz, em uma frase:

> Chegou uma demanda — um lead interessado ou um usuário com um problema — e o sistema é
> responsável pela linha do tempo inteira dessa demanda até a resolução ou o encerramento
> declarado pelo próprio lead. **Nada pode morrer no sistema por falta de resposta.**

E o invariante 4 diz que follow-up **não é uma feature de agendamento — é o mecanismo anti-morte.**

Medição na linha de base (`687716a`): existem **zero** capacidades de follow-up no catálogo MCP.
O agente configurado na tela **não consegue agendar um retorno**. A máquina de follow-up existe e
funciona (`lib/agent-engine/agent/schedule-followup.ts`, `followup-turn.ts`, `cron/scheduler.ts`,
o worker em `app/api/v1/cron/followup-flow-worker/`), mas o agente só a alcança por um caminho
hardcoded no engine — invisível e não configurável.

Ou seja: **o invariante mais importante da doutrina não tem como ser cumprido pelo agente que o
usuário configura.** É isso que você vai consertar.

## FUNÇÃO

Você entrega as mãos que impedem uma demanda de morrer.

## DIRECIONAMENTO

### O que já existe e você REUSA (Decisão 4 do briefing: a tool é fachada fina)

Rotas com a regra de negócio já implementada:

- `app/api/v1/ai/followups/enrollments/` e `.../[id]/cancel/`
- `app/api/v1/ai/followups/queue/`
- `app/api/v1/ai/followup-flows/` (+ `[id]/publish`, `[id]/disable`, `[id]/rollback`)
- `app/api/v1/leads/at-risk/` — o Radar de Risco
- `app/api/v1/leads/[id]/reactivation/`, `app/api/v1/leads/reactivations/`
- `app/api/v1/leads/[id]/next-action/`

Libs de domínio já extraídas: `lib/leads/risk-radar.ts`, `lib/leads/reactivation.ts`,
`lib/leads/next-action.ts`, `lib/leads/risk-since.ts`, `lib/followup/`.

**Nunca duplique o SQL.** Se a regra estiver dentro do `route.ts`, extraia para
`lib/<dominio>/operations.ts` e faça o `route.ts` chamar a função extraída — o teste existente da
rota é a sua rede de segurança. Se a IA e o humano operarem por regras diferentes, o sistema mente
para um dos dois.

### Capacidades a entregar

Declare em `lib/mcp/tools/catalogo/retencao.ts` (arquivo **novo**, seu; ninguém mais escreve nele)
e os handlers em `lib/mcp/tools/retencao.ts`. Registre em `lib/mcp/tools/index.ts` e no agregador
`lib/mcp/tools/catalogo/index.ts` — **uma linha de import e uma de spread**, não toque no resto.

Cobertura esperada (leitura, escrita, atualização, encerramento):

- **Agendar retorno** para um cliente ou oportunidade, com prazo e motivo.
- **Cancelar retorno agendado** — quando o cliente já respondeu, insistir é dano.
- **Listar retornos agendados** de um cliente/oportunidade, e o que está por vir.
- **Consultar quem esfriou** — o Radar de Risco, com a classificação (crítico / em risco / em voo).
- **Registrar encerramento da demanda** — o outro lado do invariante 4: uma demanda aberta precisa
  ter *próximo passo* **ou** *resolução registrada*. Sem isto o anti-morte fica pela metade.
- **Propor reativação** de um cliente que esfriou.

Nomes técnicos: siga o padrão `crm_*` do catálogo. Rótulos em português de gente — o gate
`tests/unit/catalogo-tools-leigo-friendly.test.ts` reprova jargão, e a palavra "follow-up" está na
lista de jargão proibido: para o dono da clínica isso se chama **retorno** ou **acompanhamento**.

### O gate do sistema vivo (por capacidade)

Nenhuma entra sem as 7 respostas do checklist (briefing §5). Em especial:

- **Emite atividade visível.** Agendar um retorno é evento de vida do lead: emita
  `crm_lead_activities` via `lib/leads/activity-emitter.ts`. **Não invente emissor novo** e **nunca
  use string literal** para o tipo — use a constante compartilhada (`lib/leads/activity-vocabulary.ts`).
  Leia o cabeçalho de `tests/invariants/vocabulario-banco-x-typescript.test.ts` antes: essa coluna é
  de vocabulário ABERTO e deliberadamente não tem CHECK constraint — entender o porquê evita que
  você "complete" o schema e quebre o `update.sh` dos clones.
- **Aparece na tela.** O retorno agendado pelo agente tem que ser visível ao humano — o Radar
  (`/app/radar`) e a timeline do inbox são os lugares naturais. Se não aparecer, é ilha.
- **Continuidade nas duas direções.** Se o humano cancela um retorno, o agente precisa saber ao
  retomar.

### Quando você tirar `reter` da dívida

`tests/unit/catalogo-tools-leigo-friendly.test.ts` declara `PACOTES_VAZIOS_CONHECIDOS = ["reter",
"evoluir"]`. Ao entregar, **remova `"reter"` dessa lista.** Há uma segunda guarda que reprova se
você preencher o pacote e esquecer de tirar da dívida — ela existe para impedir que a lista
envelheça e minta para a próxima pessoa.

## OBJETIVO

Que nenhum cliente interessado morra no sistema por falta de resposta — e que o agente que o dono
da clínica configura na tela seja capaz de garantir isso sozinho.

## RESULTADO ESPERADO

- `pnpm typecheck` limpo, `pnpm lint` sem erros novos, `pnpm test:unit` verde.
- `pnpm test:db` verde — você toca emissão de atividade; `test:unit` **não** inclui
  `tests/invariants/**`, então concluir "tudo verde" só com ele é falso verde.
- **E2E em tela com Playwright**: um lead esfria, o agente agenda o retorno, o retorno aparece no
  Radar e na timeline, o humano cancela, e o agente vê o cancelamento. Evidência visual salva.
- Mudança de schema (se houver): **migration versionada + apêndice idempotente no
  `supabase/baseline.sql` + linha no `MANIFEST.md`**. Os três, sempre juntos — o kit self-host
  aplica só o baseline; migration que não chega lá não chega ao cliente.
- `HANDOFF-ia-360.md` alimentado a cada marco, com SHA.

**Sabote antes de confiar.** Todo teste novo: quebre a propriedade de propósito, confirme que
reprova, desfaça.

## LIMITES

- Não toque em `lib/mcp/tools/catalogo/` além do **seu** arquivo + as 2 linhas no agregador.
- Não renomeie nenhum `name` de tool existente.
- Não mexa no engine de envio / anti-ban (`runBeforeSend`) — se precisar, avise o Maestro.
- Bug encontrado é para consertar na causa raiz, não para devolver.

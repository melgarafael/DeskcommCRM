# Doutrina do Sistema Vivo — SonghaiCRM

> Lei de arquitetura. Todo desenvolvimento neste repo obedece a isto — não é aspiração, é critério de aceite (ver o item "Living System Checklist" no Definition of Done, `CLAUDE.md`).

**Este arquivo é a LEI: curta, verificável, cobrada pelo DoD e pelo CI.** O racional completo — por que cada invariante existe, qual armadilha ele evita, e como adotar a doutrina em outro sistema — vive no manual: [`sistema-vivo/`](sistema-vivo/README.md).

| Se você quer… | Vá para |
|---|---|
| Saber o que precisa responder antes do merge | Este arquivo (§ invariantes + checklist) |
| Entender *por quê*, ou aplicar isto em outro sistema | [`sistema-vivo/README.md`](sistema-vivo/README.md) |
| O gate operacional numa sessão de código | `.claude/skills/sistema-vivo/SKILL.md` |

Ao mudar um invariante aqui, atualize [`sistema-vivo/02-lei-dos-invariantes.md`](sistema-vivo/02-lei-dos-invariantes.md) na mesma sessão — ele é o espelho comentado desta lista, e dois textos que divergem deixam de ser consultados.

---

## O princípio-raiz

O SonghaiCRM é um **sistema vivo**, não um CRUD com telas. Ele existe para uma única missão:

> Chegou uma demanda — um lead interessado ou um usuário com um problema — e o sistema é **responsável pela linha do tempo inteira dessa demanda até a resolução ou o encerramento declarado pelo próprio lead.**

Nada pode morrer no sistema por falta de resolução, resposta, ou porque ninguém viu que havia algo ali precisando de atenção. Toda peça é um tentáculo orquestrado para não deixar nenhuma informação do lead escapar e nenhuma necessidade dele passar sem visibilidade na tela.

Onde a IA termina, começa uma continuidade contextualizada para o humano. Onde o humano termina, há um input estruturado para a IA retomar com contexto. Onde ambos param, há histórico legível do que foi feito.

---

## Os 7 invariantes (verificáveis)

Cada invariante é uma pergunta que uma feature responde **antes do merge**. Se não responde, ainda não está viva.

### 1. Regra das 2 conexões — nada é ilha
Toda peça da arquitetura tem no mínimo **uma aresta de entrada e uma de saída** no grafo do sistema. A peça de origem é um polvo: distribui para áreas. Uma feature que só recebe (ou só emite) e não alimenta nada está morta por definição.

- **Anti-exemplo:** "sistema de atendentes" como CRUD de usuários. **Vivo:** atendente = atribuição + carga/capacidade + métricas + relatório + log de atividade + destino de handoff da IA.
- **Verificação:** a peça aparece no mapa (`docs/architecture/`) com ≥2 arestas reais (não decorativas).

### 2. Continuidade IA↔humano nas duas direções
- **IA → humano:** quando a IA para (handoff, veto de gate, incerteza), o humano recebe **contexto pronto para continuar** — um resumo do que aconteceu e por quê, não a conversa crua.
- **Humano → IA:** quando o humano para (responde, atribui, agenda), fica um **input estruturado** que a IA lê para retomar com contexto.
- **Verificação:** existe o payload/registro de continuidade nas duas direções, não só o roteamento.

### 3. Log universal e visível
Toda mutação relevante — mexida em lead, agente, follow-up agendado, atribuição de atendente, mudança de estágio — gera **atividade**. E não só no banco (`event_log` / `api_audit_log` / `crm_lead_activities`): aparece **na tela** como timeline/insight. Log invisível é log morto.

- **Verificação:** a mutação emite atividade E há um lugar na UI onde ela é lida como parte da linha do tempo.

### 4. Nenhuma demanda sem próximo passo — follow-up é o anti-morte
Follow-up não é uma feature de agendamento; é o **mecanismo que mantém o lead/usuário vivo** até a demanda ser resolvida ou o próprio lead declarar encerrada. O invariante operacional: **nenhuma demanda aberta sem um próximo passo definido e visível.**

- **Verificação:** para toda demanda aberta existe (a) um próximo passo, ou (b) uma resolução/encerramento registrado. Uma demanda sem nenhum dos dois é um vazamento — o sistema falhou na missão.

### 5. Informação com propósito
Todo dado exibido responde "**por que estou vendo isto e o que faço a seguir**". Traz insight/direção, não só estado. Um número na tela que não muda uma decisão é ruído.

- **Verificação:** cada elemento de dado tem um "e daí?" — leva a uma ação, uma priorização, ou um alerta.

### 6. Toda configuração tem superfície
Os invariantes 3 e 5 cobrem o que **aconteceu** e o que se **vê**. Este cobre o que está **valendo**: nenhum mecanismo de backend pode depender de estado configurável que não tenha **tela para ver, tela para mudar, e caminho visível de falha**. Um mecanismo operável só por quem lê o banco não é operável.

- **Anti-exemplo:** existir disparo de template por follow-up sem nenhuma área para ver ou configurar templates — o mecanismo funciona e é invisível, o que é pior que não existir (falha sem culpado).
- **Verificação:** para todo estado configurável existe (a) rota de leitura na UI, (b) rota de escrita na UI, e (c) falta de configuração vira item de inbox ou banner — nunca um `return` mudo no worker.
- **Doutrina irmã:** [`restricao-de-canal.md`](./restricao-de-canal.md) aplica isto ao eixo dos canais externos (auto-restrição × hetero-restrição, contrato de parâmetros derivado).

### 7. Todo laço se fecha — nada decide no vazio
**Toda decisão automatizada tem um retorno mensurável que altera decisão futura.** Para cada decisão que o sistema toma sozinho — responder, escalar, agendar, priorizar, avançar estágio — existe um sinal de desfecho que volta e muda o comportamento seguinte: métrica que altera prioridade, caso que vira conhecimento, padrão que vira proposta.

A armadilha é sutil: **os invariantes 1 a 6 podem estar todos satisfeitos num sistema que não aprende nada.** Toda peça com entrada e saída, todo log gravado, toda tela no lugar — e ainda assim uma esteira: a informação entra, atravessa, sai, e nada volta para mudar o amanhã. O invariante 1 garante *caminho*; este garante *ciclo*.

A pergunta que expõe: **quando o sistema erra, o que muda nele?** Se a resposta é "fica no log", o log é estoque morto — memória sem leitor é custo de disco.

- **Verificação:** para cada classe de decisão automatizada, nomeie o sinal de retorno e onde ele é consumido. "Nenhum" só vale com justificativa escrita — e é dívida declarada, não ausência de defeito.
- **Não exige auto-modificação:** o laço pode terminar numa proposta que um humano aprova. O proibido é o laço que termina em lugar nenhum.
- **Estado atual:** parcial. O flywheel fecha o laço do agente; as demais classes de decisão ainda não declaram retorno. Detalhe em [`sistema-vivo/02-lei-dos-invariantes.md`](sistema-vivo/02-lei-dos-invariantes.md).

---

## A regra do tempo

A formulação anterior — *"todas as áreas do sistema devem funcionar em realtime"* — **está revogada.** Ela misturava duas coisas com exigências opostas, e o sistema nunca se comportou assim: throttle, janela horária e warm-up são atrasos deliberados, e estão certos.

> **Observação em tempo real. Ação no tempo apropriado ao humano do outro lado.**

Tempo real é direito do observador — painel, inbox, fila, falha de operação, conversa ao vivo — porque informação atrasada faz o mecanismo anti-morte (invariante 4) chegar atrasado junto. No canal de **ação**, delay é decisão de projeto: quanto mais irreversível o efeito, maior o intervalo entre decidir e consumar. Enviar mensagem a uma pessoa é irreversível e nunca é operação comum.

**Corolário — interruptibilidade:** o sistema nunca deve ser mais rápido do que o humano consegue interromper. Se o efeito é irreversível antes que alguém consiga cancelar, a autoridade humana existe no organograma e não no relógio.

Racional completo em [`sistema-vivo/06-tempo-do-sistema.md`](sistema-vivo/06-tempo-do-sistema.md).

---

## Living System Checklist

Cole isto (ou responda mentalmente) em **toda feature/refactor** antes de declarar pronto. É um item do Definition of Done (`CLAUDE.md`).

```
Living System Checklist — <nome da feature>
[ ] Quem me alimenta?  (aresta de entrada — fonte real, não inventada)
[ ] Quem eu alimento?  (aresta de saída — a peça é um polvo, distribui)
[ ] Que atividade/log eu emito?  (event_log / audit / crm_lead_activities)
[ ] Onde eu apareço na tela?  (timeline/insight — não só no banco)
[ ] Por qual porta se chega até mim?  (entrada em lib/navigation/registry.ts, ou allowlist justificada)
[ ] Qual meu mecanismo anti-morte?  (próximo passo garantido, ou N/A justificado)
[ ] Onde se CONFIGURA o que eu uso?  (tela de ver + tela de mudar; e o que aparece se faltar)
[ ] Qual a continuidade IA↔humano?  (payload de handoff nas duas direções, se aplicável)
[ ] Qual meu LAÇO DE RETORNO?  (o que muda no sistema quando eu erro — invariante 7)
[ ] Atualizei o mapa vivo?  (docs/architecture/*.json — a FONTE; sem re-render, ver o aviso abaixo)
```

**Como se responde mal, e é o padrão:** respondendo o que a peça *poderia* fazer. A resposta válida **nomeia o artefato concreto** — o consumidor real, a tela real, o log real. "Vai aparecer no painel" não é resposta.

Uma feature que responde "nenhum" a *quem eu alimento* ou *onde apareço na tela* é uma ilha. Desilhe antes do merge, ou registre explicitamente por que é uma exceção legítima.

> **Por que a pergunta da porta foi acrescentada (2026-08-03).** Ter tela e ser alcançável são coisas diferentes, e o checklist só cobrava a primeira. Auditoria da navegação encontrou **sete telas alcançáveis apenas por dentro da própria seção** (Conhecimento, Credenciais, Uso, Casos, Alertas — só como aba dentro de `/app/ai/*`) e **duas sem link nenhum no app** (`/app/integrations/nuvemshop`, `/app/ai/proposals`). Todas tinham passado no gate respondendo "tenho tela". Uma feature sem porta é uma ilha alcançável só por quem já sabe a URL — que é ninguém, num produto self-host.

### Regras de navegação que a doutrina passa a exigir

- **Todo destino declara seu grupo** em `lib/navigation/registry.ts`. Sem grupo, sem merge.
- **Configuração e observabilidade são grupos diferentes.** Desenhar como o sistema funciona (Agentes, Roteadores) não é a mesma atividade que olhar o sistema funcionando (Evolução da IA, Desempenho) — e quem procura uma não está procurando a outra.
- **Hub a partir de 5 telas.** Abaixo disso o grupo cabe inteiro no sidebar; um hub de 3 itens é só um clique a mais para chegar onde já dava.
- **O sidebar carrega o uso diário; o hub carrega o inventário.** Na dúvida, `sidebar: false` — o hub e o ⌘K já garantem a descoberta.
- **Mudar o lugar na navegação não exige mudar a URL.** Rota só se renomeia quando o path mente sobre o conteúdo, e cada renomeação paga um redirect permanente.

---

## O mapa vivo é parte do sistema

A doutrina só é navegável e monitorável se materializada visualmente. Dois artefatos mantêm o sistema legível:

- **archify** (`docs/architecture/`) — diagramas curados de sistema, turno do agente e flywheel. **Fonte da verdade = os `.json`, e é só neles que se mexe.** Uma peça nova entra no mapa **com ≥2 arestas** antes do merge, e `tests/unit/mapas-de-arquitetura.test.ts` verifica a coerência interna de todos eles.

  > ⚠️ **NÃO "re-renderize com archify".** Esta linha mandava fazer isso e a instrução era falsa: medido com archify 2.11.0, **só `agent-turn.workflow.json` valida**. Os `*.architecture.json` são recusados nos dois modos — os `node.type` que usamos estão fora do enum, vários `col` passam de 5, e os `dot` dos cards também. Quem seguisse a instrução receberia erro de schema e concluiria que estragou algo. Detalhe medido em [`../architecture/README.md`](../architecture/README.md).
- **graphify** (`graphify-out/`) — grafo determinístico do repo inteiro (nós, comunidades, arestas). Use `graphify query "<pergunta>"` para achar ilhas e orientar antes de ler fontes.

Regra: **mudança de arquitetura não fecha sem o mapa refletir.** O diagrama desatualizado é uma ilha de informação — viola o invariante 3.

---

## Estado atual — o que já está vivo (auditoria 2026-07-24)

Primeira passada ancorada no grafo (`graphify`) + `docs/architecture/`. A doutrina já é majoritariamente vivida:

**Vivo (confirmado no grafo):**
- `event_log` + `lib/event-log/dispatcher.ts` — nada acontece sem evento; trigger nunca faz HTTP.
- `lib/audit/index.ts` `audit()` — mutação → `api_audit_log` append-only.
- Atendentes com status/carga/capacidade/horário/disponibilidade + **Performance por Atendente** (ganhos, perdidos, conversas, 1ª resposta média).
- **IA como assignee de 1ª classe** (`assignee_kind user|ai`) + Modo de Roteamento — handoff IA→humano existe.
- Flywheel de auto-aprimoramento com gate humano; `createFollowupTurnHandler` (follow-up conduzido pelo agente).
- 10 gates before-send com veto instrutivo de volta ao modelo (continuidade IA→modelo). *(Este número já dizia "7" quando a cadeia tinha 9 — corrigido junto com a entrada do gate `internal_vocabulary`, que a levou a 10. A lista viva é `BEFORE_SEND_GATES`, travada por `tests/unit/before-send-chain-shape.test.ts`.)*

**Verificado em código (2026-07-24):**
1. ✅ **Timeline de `crm_lead_activities` renderizada** — VIVO. `components/inbox/CRMSidePanel.tsx` busca `crm_lead_activities` e renderiza como feed no inbox (API `app/api/v1/contacts/[id]/timeline/route.ts`). *Nuance:* o feed vive no inbox, não no card do pipeline — desilhar o card seria o próximo passo se o operador trabalhar direto do Kanban. (invariante 3)
2. ✅ **Payload de continuidade IA→humano** — VIVO. `buildHandoffSummary()` (`lib/agent-engine/agent/human-handoff.ts:252`) monta resumo contextual (rolling summary + compromissos + objeções + próxima ação) e vai ao inbox do humano, nunca a log. (invariante 2)
3. ✅ **Follow-up como invariante de lead — DESILHADO (2026-07-24).** Era ilha parcial: o anti-morte era forte no *engine* (`schedule-followup.ts`, `followup-turn.ts`, `cron/scheduler.ts`, `edge/crm/session-watchdog.ts`), mas invisível para o humano. Fechado com o **Radar de Risco** (`/app/radar`): tela que agrega as demandas abertas que esfriaram, classificadas em crítico / em risco / em voo (follow-up agendado = sistema mantém viva). Arestas: **entrada** = `crm_leads` (abertos, `last_activity_at`) + `cron_jobs` (follow-ups agendados); **saída** = link → inbox/conversa (ação humana). Código: `lib/leads/risk-radar.ts` (classificação pura + teste), `app/api/v1/leads/at-risk/route.ts`, `app/app/radar/`. Provado em tela (E2E `tests/e2e/risk-radar.spec.ts` verde + screenshot). (invariantes 4 + 5)

> Auditoria linha-a-linha via `graphify` + leitura de fontes. C1 desilhado com o Radar de Risco; C2/C3 já eram vivos.

---

## Enforcement — como a doutrina se perpetua

| Camada | Artefato | Garante |
|---|---|---|
| Mentalidade | Skill `sistema-vivo` (`.claude/skills/`) | Injeta o checklist em toda feature/refactor |
| Gate de sessão | Item "Living System Checklist" no DoD (`CLAUDE.md`) | Nenhuma task fecha sem responder o checklist |
| Contexto persistente | Memória de projeto | Sessões futuras carregam a doutrina |
| Mapa vivo | archify + graphify | Peça nova aparece com ≥2 arestas |
| **CI (mecânico)** | `tests/unit/navegacao-completude.test.ts` | **Tela sem porta reprova o build** |

**Rung futuro (opcional, não construído):** enforcement mecânico via CI/hook — ex.: teste que exige que toda tabela tenant-aware nova declare sua estratégia de activity log. Gates de *mentalidade* vivem melhor em skill+DoD (hábito) do que em hook frágil (ruído). Adicionar só se a doutrina começar a vazar na prática.

**Acionado em 2026-08-03 — para a pergunta da porta.** A condição acima ("se a doutrina começar a vazar na prática") se cumpriu: nove telas sem porta, todas aprovadas por um gate de hábito. `navegacao-completude.test.ts` varre `app/app/**/page.tsx` e cruza com o registro nos dois sentidos — tela sem porta e destino apontando para rota inexistente. A allowlist exige justificativa escrita por entrada, e um teste cobra que a justificativa exista.

O caso é instrutivo sobre o limite do gate de hábito: **o próprio teste achou duas telas órfãs que três varreduras manuais nesta sessão não acharam** — incluindo uma (`/app/ai/proposals`) que eu havia declarado, com convicção, não ser uma tela. A varredura por arquivo não tem opinião. Onde a propriedade a garantir é *enumerável a partir do repositório*, o teste ganha do hábito; onde ela exige julgamento (a peça faz sentido? o log é útil?), o hábito continua sendo o instrumento certo.

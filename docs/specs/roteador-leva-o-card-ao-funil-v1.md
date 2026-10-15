# Roteador de intenção leva o card ao funil certo — desenho v1

> **Estado em 07/10/2026.** O dado (§3.1) já está na `main`: migration 0542 (PR #2290) criou
> `pipeline_id` e `stage_id` em `ai_router_members`, com apêndice no `baseline.sql`, e
> `router-config.ts` já os lê. A transferência do card de entrada também já existe
> (`aplicaDestinoDaIntencao`). Falta, e está em branch própria
> (`feat/roteador-card-adicional-entre-produtos`), o caso "dois cards" do §3.4 item 3:
> `abreCardAdicionalNoFunil` (`lib/leads/abre-card-adicional.ts`) e o status `card_adicional`.
> **Funil de entrada foi resolvido pela alternativa derivada**: é entrada o funil que não é
> destino de nenhuma intenção do roteador (`funisDeProdutoDoRoteador`), sem coluna nova
> (pergunta 1 do §8). Cliente com negócio **ganho** em outro produto também ganha o card novo;
> quem já tem card de qualquer status no destino não ganha outro. Não verificado: prova pela
> tela e `pnpm test:db`.

Rascunho de desenho para a parte principal da #2155. Não é código. Escrito a partir de uma
instalação real (v1.69.0) e do código de `origin/main` (31e9278e3). O #2162 já cobre a parte
pequena (a regra "criar ou mover negócio" aceita `lead.tag_added`); este documento é o resto.

## 1. O problema, medido

Instalação com três funis (Recepção, Investimentos, Consórcio), um agente por funil (cada um com
escopo só no próprio funil) e um roteador ativo no número de WhatsApp, com duas intenções e a
Recepção como fallback.

1. Cliente novo escreve "Oi": nasce o card em **Recepção › Triagem**; o roteador não casa
   intenção (`router_outcome: fallback`) e a Recepção responde.
2. O mesmo cliente escreve "Quero investir": o roteador classifica **Investimentos**
   (`classified`) e o agente certo responde.
3. **O card continua em Recepção › Triagem.** O agente do produto só escreve no próprio funil,
   então etapa, etiqueta, campos e follow-up por etapa não funcionam para esse cliente.

Causa: `ai_router_members` guarda agente, intenção, descrição, exemplos, posição e
`flow_pointer_id`. **Não guarda funil nem etapa.** O resolvedor escolhe o agente e não toca no card.

## 2. Decisões de produto

O segundo card entre funis de produto foi pedido pelo autor da issue #2480 e aprovado pelo mantenedor em 14/10/2026 (opção A: entra, com duas guardas — contato bloqueado ou anonimizado não ganha card novo, e quem já passou pelo funil de destino não ganha outro card lá, tenha ou não card aberto em outro produto).

- **Um contato pode ter dois cards abertos, um por funil de produto.** Quem começa em
  Investimentos e depois pergunta de Consórcio (ou o contrário) ganha um segundo card; o primeiro
  **não** é encerrado. Cada funil conta a sua história.
- **O card do funil de entrada (Recepção) é transferido**, não duplicado: encerrado com o motivo
  canônico de transferência, que não conta como perda comercial.
- **Compatível por padrão.** Intenção sem destino configurado se comporta exatamente como hoje.

## 3. O desenho

### 3.1 Dado

Duas colunas opcionais em `ai_router_members`, juntas ou nenhuma:

- `pipeline_id uuid` — funil de destino da intenção.
- `stage_id uuid` — etapa em que o card nasce.

Regras de integridade: CHECK "as duas nulas ou as duas preenchidas"; a etapa pertence ao funil e
ao mesmo `organization_id` (FK composta ou validação na API **e** no banco — o precedente é a FK
composta de `flow_pointer_id`, migration 0394, com `on delete set null`); funil ou etapa apagados
voltam a intenção ao comportamento antigo, sem derrubar o roteador. Tripla de migration como
manda a doutrina: arquivo em `supabase/migrations/`, apêndice idempotente no `baseline.sql`,
e a linha `-- manifest: <o quê e porquê>` no cabeçalho do `.sql` (o `MANIFEST.md` é histórico). Número: o próximo livre — rode `pnpm checar:colisao-de-migration`.

### 3.2 Onde decidir

`lib/agent-engine/agent/resolve-turn-agent.ts` já devolve `flowPointerId` do membro casado
(linha ~317, `outcome === 'sticky' ? null : …`) e `inbound-turn.ts` (~2449) o consome. O destino
de funil é primo direto: o resolvedor devolve `destinoDeFunil: { pipelineId, stageId } | null`,
**só** para `classified` e `reclassified` com membro que tenha destino. Nunca para `sticky`,
`fallback`, `no_match`, `classifier_failed`, `no_router` nem `campanha`.

O `RouterMember` em `router-config.ts` ganha os dois campos; o `loadActiveRouter` os lê.

### 3.3 Onde executar

No turno, **antes de o agente do produto usar qualquer ferramenta** (junto de onde o turno já
aplica o `flowPointerId`). Sem isso, na primeira resposta depois da classificação o agente ainda
enxerga o card no funil errado — é o que a medição mostrou.

Nota de verificação para quem implementar: no motor, `leadId` do turno é o **id do contato**
(`job.contact_id`), não o do card. Confirme como o agente localiza o card dele (pelo escopo de
funil da versão publicada) para garantir que ele enxerga o card novo no mesmo turno.

### 3.4 O que fazer com o card — `garantirCardNoFunil(contato, pipelineId, stageId)`

Função de decisão **pura** (tabela de casos testável) mais uma camada fina que fala com o banco:

1. Contato já tem card **aberto** no funil de destino → **não faz nada**. Idempotente e nunca
   retrocede um card que já avançou (resolve o "voltar para Conversando").
2. Senão, contato tem card aberto num **funil de entrada** → **transfere**: clona para o destino e
   encerra a origem com o motivo canônico `moved_to_another_pipeline`.
3. Senão (sem card, ou só cards em outros funis de produto) → **cria** um card novo no destino e
   **não encerra** os outros. É o "dois cards".

**Funil de entrada = funil que não é destino de nenhuma intenção do roteador.** Isso evita coluna
nova: Recepção nunca é destino, então é de entrada; Investimentos e Consórcio são destinos, então
são paralelos. Alternativa mais explícita, se a revisão preferir: `ai_routers.entry_pipeline_id`.

**Não escreva uma segunda implementação de "trocar de funil".** O comentário em
`create-or-move-lead.ts` já cita o motivo (duas divergiriam na primeira mudança). Extraia
`transfereParaOFunil` (hoje privada ali) para `lib/leads/`, junto de `clonar-para-funil.ts`, e use
a mesma nos dois chamadores. O que ela já faz: confere a etapa de destino, confere que a origem
tem etapa de perda, cria o clone com título, contato, valor, tags e campos personalizados, e
encerra a origem.

### 3.5 Falhas e segurança

- **Falha aberta.** Erro ao transferir não pode calar o atendimento: o turno segue, registra
  `log.warn`, e a falha aparece onde o operador olha (aba Atividade / Execuções) com o motivo. O
  próprio cabeçalho do resolvedor já define o roteador como "estritamente aditivo".
- **Multi-tenant.** O destino vem da linha do roteador (resolvida do canal), nunca do corpo da
  requisição ou do texto do cliente. Toda leitura e escrita filtra `organization_id`.
- **Antiloop.** O que o turno grava não pode disparar de novo a regra "Recepção → Funil X" nem
  outro gatilho em cadeia; se a transferência emitir evento de lead, ele precisa carregar a
  marca de origem (`caused_by_rule` ou equivalente) para a trava existente reconhecê-lo.
- **Auditoria e linha do tempo.** Uma atividade legível nos **dois** cards ("Levado para o funil
  Investimentos pelo roteador, intenção Investimentos") usando constante compartilhada para o
  tipo (a coluna é de vocabulário aberto, sem CHECK — ver `CLAUDE.md`).

## 4. Tela

Na tela do roteador (`app/app/ai/routers/[id]/_client.tsx`), em cada intenção, dois campos
opcionais: "Levar o card para o funil" e "Etapa". Texto de ajuda em linguagem simples:
"Quando o cliente pedir isto, o card vai para este funil." Zod na API
(`app/api/v1/ai/routers/[id]/members/route.ts`, `lib/ai/agents/router-members-http.ts`),
`lib/ai/agents/router-members.ts`, `lib/database.types.ts` regenerado, i18n em pt, en e es.
A tela precisa de porta de navegação já existente (é a tela do roteador, que já tem).

## 5. Provas esperadas

- **Unit** da decisão pura: sem destino; `sticky`; já tem card no destino; só card no funil de
  entrada; só card em outro funil de produto (dois cards); sem card; funil ou etapa arquivados;
  erro do banco.
- **Invariantes (`test:db`)**: isolamento entre duas organizações (destino de uma não alcança a
  outra); FK/CHECK; apagar funil ou etapa devolve a intenção ao comportamento antigo.
- **E2E em banco fresco, pela tela, com o agente real**: "Oi" → Recepção; "Quero investir" →
  card em Investimentos › etapa configurada e origem encerrada como transferência; depois "Quero
  consórcio" → **dois cards abertos**; voltar a falar de Investimentos → nenhum card novo, nenhuma
  etapa retrocedida. Pela doutrina do repositório, a prova passa pelo agente e também pela ferramenta
  direta, e os dois precisam concordar.
- Rodar `pnpm test:db` localmente (schema); `pnpm gov:verify` **não** o cobre.

## 6. Checklist de doutrina

Destino: **núcleo** (o roteador por intenção é recurso do núcleo e hoje não cumpre a promessa de
entregar o cliente ao funil certo; com um funil só, nada muda). Fragmento em `.changes/`
(`capacidade_nova`). Migration em tripla. Sem `console.log`. Zod em todo input. i18n completo.

## 7. Fora de escopo

Ferramenta de IA para mover card entre funis (proibida de propósito); mover cards antigos já
parados na Recepção (pede ação à parte, por exemplo "levar para outro funil" na tela do card);
campo de funil por regra de automação.

## 8. Perguntas abertas para a revisão

1. ~~"Funil de entrada" derivado ou explícito?~~ Resolvido: derivado (ver o estado no topo).
2. Contato com card **encerrado** (ganho ou perdido) no funil de destino: abrir um card novo ou
   reaproveitar a política de reabertura de `lib/leads/reabertura.ts`?
3. Confirmar no código como o agente localiza o card depois da transferência no mesmo turno.
4. Vale um aviso quando um card ficar parado na Recepção por mais de X horas (cliente que disse
   "Oi" e sumiu)?

# Importar e exportar fluxos (follow-ups e roteiros)

> Status: implementado. Rotas `GET /api/v1/ai/followup-flows/:id/export` e
> `POST /api/v1/ai/followup-flows/import`; regras em `lib/followup/portabilidade.ts`.
> Exemplo pronto: [`exemplos/fluxo-de-exemplo.fluxo.json`](exemplos/fluxo-de-exemplo.fluxo.json)
> (um teste garante que ele importa e publica: `tests/unit/followup-portabilidade.test.ts`).

Montar um fluxo no canvas é delicado: uma ligação solta, um ramo sem saída e o **Publicar**
recusa. Exportar e importar deixa o fluxo virar um **arquivo** e voltar, nesta ou em outra conta
(outra organização, outra instalação), sem redesenhar nada.

## Na tela

Em **Agente de IA › Follow-ups**, aba **Fluxos** (e na tela de fluxos de atendimento, quando o
módulo está ligado):

- **Exportar**, em cada cartão: baixa `nome-do-fluxo.fluxo.json`.
- **Importar fluxo**, ao lado de "Novo fluxo": escolha o arquivo (ou cole o conteúdo), dê outro
  nome se quiser, e importe.

Os dois botões aparecem para papel **gerente** ou acima, como Duplicar e Excluir. Pela API, exportar
aceita qualquer membro (o arquivo não mostra nada que a tela do fluxo já não mostre) e importar exige
gerente, o mesmo de criar fluxo.

## O que acontece ao importar

1. **O arquivo é validado pelas MESMAS regras do editor.** Tipo de cada caixa, limites de cada
   campo (espera mínima de 5 minutos, até 60 caixas, até 120 ligações, ligação que aponta para caixa
   inexistente, id repetido…). Arquivo recusado não grava nada, e a tela lista cada problema com o
   caminho até o campo, por exemplo `flow.graph.nodes.3.config.duration_ms: …`.
2. **O fluxo nasce como RASCUNHO.** Nunca é publicado na importação e não manda mensagem para
   ninguém. Para ir ao ar, ele passa pelo **Publicar**, com a mesma conferência de qualquer fluxo
   desenhado à mão (caminho até o fim, saídas cobertas, etapa escolhida…).
3. **Cada referência à conta é conferida.** Veja a próxima seção.
4. **Nome livre:** se já existe um fluxo com o mesmo nome, o importado ganha " (importado)".
5. **Auditoria:** registra `followup_flow.imported`, com contagens e códigos das pendências, nunca o
   texto das mensagens.

O arquivo **não** leva inscrições, versões publicadas, vínculo com agente nem o estado "Ativo".

## Referências a coisas da conta (etapas, modelos, pessoas)

Algumas caixas apontam para registros da conta pelo identificador interno. Em outra conta esses
identificadores não existem, por isso o arquivo leva também o **nome** de cada coisa citada (seção
`references`). Na importação, para cada referência:

| Situação | O que a importação faz |
|---|---|
| O registro existe nesta conta (importar na mesma conta) | Mantém. |
| Não existe, mas o nome bate com **um** registro daqui (sem diferenciar acento e maiúsculas) | Liga ao registro daqui e avisa ("ajustado automaticamente"). |
| Não existe e o nome não bate, ou bate com dois ou mais | Não adivinha: limpa o campo (ou volta ao valor neutro) e mostra **"resolva antes de publicar"**. |

Caso a caso:

| Onde | Sem correspondência |
|---|---|
| **Mover lead no funil** (etapa de destino) | Destino fica vazio; o Publicar exige escolher. |
| **Condição** "Etapa do lead" | A regra fica, e o Publicar a recusa (etapa não encontrada) até você escolher a etapa. |
| **Ação › modelo** (`template_id`) | Fica o id de fora e a pendência **bloqueia**: escolha o modelo no editor. O Publicar não confere modelo, então essa conferência é da tela da importação. |
| **Ação › mensagem por IA › modelo de reserva** | O modelo de reserva sai. Se a espera longa exigir reserva, o Publicar cobra. |
| **Lembrete interno › responsável** | Vira "dono do lead" (e-mail de pessoa não sai no arquivo). |
| **Fim › iniciar próximo fluxo** | Vira "não fazer nada". |
| **Gatilho "Etapa do funil"** | Gatilho volta a **Manual** (não dispara sozinho) e a pendência bloqueia. |
| **Gatilho "Falta confirmada pela equipe"** com tipo de compromisso inexistente | Volta a **Manual**. Tirar só o tipo ausente faria o gatilho valer para todos os tipos, em silêncio. |

Etapa **arquivada** conta como inexistente: o Publicar não aceita destino arquivado.

O que **não** é conferido, porque não aponta para registro da conta: o `media_url` de uma Ação (a URL vai como está; se ela aponta para o armazenamento da instalação de origem, confira se continua acessível), o `key` de uma regra `lead_date` e o `save_to` de uma Resposta (nomes de campo personalizado: crie o campo com o mesmo nome na conta de destino) e o `skill_name` (a skill precisa estar instalada).

## O formato do arquivo

```json
{
  "format": "followup_flow",
  "version": 1,
  "exported_at": "2026-10-17T12:00:00.000Z",
  "flow": {
    "name": "Retomar quem parou de responder",
    "surface": "followup",
    "handoff_policy": "pause",
    "trigger_config": { "kind": "silence", "params": { "threshold_minutes": 1440 } },
    "graph": { "nodes": [ … ], "edges": [ … ], "settings": { … } }
  },
  "references": {
    "stages": { "<uuid>": "Proposta · Funil de Vendas" },
    "templates": { "<uuid>": "Boas-vindas" },
    "flows": { "<uuid>": "Agendamento" },
    "event_types": { "<uuid>": "Consulta" }
  }
}
```

- `format` e `version` são obrigatórios e fixos.
- `surface`: `followup` (padrão), `crm_automation` ou `atendimento`. Um roteiro de atendimento só
  importa com o módulo **Fluxos de atendimento** ligado na instalação.
- `handoff_policy`: o que o fluxo faz quando uma pessoa assume a conversa: `pause` (pausa, o
  padrão), `cancel` (encerra) ou `allow` (continua).
- `references` é opcional. Um arquivo escrito à mão (ou por uma IA) sem essa seção é válido: as
  referências viram pendência em vez de serem ligadas pelo nome.
- Tamanho máximo: 512 KB.

Um arquivo pode ser escrito do zero seguindo o catálogo abaixo. A importação é a forma mais segura
de criar um fluxo grande, porque o erro aparece com o caminho exato antes de qualquer coisa ser gravada.

## Catálogo do bot: tudo o que um fluxo pode ter

A fonte da verdade é `lib/followup/graph-schema.ts` (forma de cada caixa) e
`lib/followup/api-schemas.ts` (gatilhos). Este catálogo descreve esses arquivos; se divergirem,
eles vencem.

### Estrutura

- `graph.nodes`: de 2 a 60 caixas. Cada uma tem `id` (único), `type`, `label` (1–60 caracteres),
  `position` (`{ x, y }`, só desenho) e `config` (depende do tipo).
- `graph.edges`: até 120 ligações. Cada uma tem `id` (único), `source` e `target` (ids de caixas que
  existem), `priority` (inteiro, padrão 0) e `condition` (por qual saída da caixa de origem ela sai).
- `graph.settings` (opcional): veja [Configurações do fluxo](#configurações-do-fluxo).

Todo objeto é **estrito**: chave desconhecida é recusada (é o que pega erro de digitação).

### Gatilhos (`trigger_config`)

| `kind` | Na tela | Quando dispara | `params` |
|---|---|---|---|
| `manual` | Manual | Nunca sozinho: uma regra de automação ("Iniciar fluxo de mensagem"), o agente de IA ou a API inscreve o contato. | — |
| `webhook` | Automação (Webhooks) | Por uma regra em Webhooks. | — |
| `lead_created` | Lead criado | Quando nasce um negócio. | `{}` (opcional) |
| `stage_change` | Etapa do funil | Quando o lead entra numa etapa. | `{ "stage_id": "<uuid>" }` |
| `silence` | Silêncio | Quando o contato fica calado. | `threshold_minutes` (5–10080), opcional `max_silence_minutes` (teto: só silêncio recente), `reentry_pause_minutes` (pausa antes de recomeçar para quem já passou pelo fluxo), `reentry_pause_basis`, `max_enrollments_por_contato` (1–50: quantas vezes no total o fluxo pode recomeçar para o mesmo contato), `exige_resposta_da_equipe` (`true` = só alcança quem a equipe já respondeu), `segments` |
| `inbound_after_silence` | Cliente voltou | Quando o contato volta a escrever depois de um tempo parado. | `threshold_minutes` (mínimo 1 h, máximo 90 dias), opcional `segments` |
| `case_opened` | Agente pediu ajuda | Quando o agente abre um caso. | `{}` (opcional) |
| `appointment_no_show` | Falta confirmada pela equipe | Quando a equipe confirma a falta num compromisso. | opcional `event_type_ids` (vazio = todos os tipos) |

Todos aceitam `cancel_on_reply` (`true`/`false`): `true` encerra a inscrição na primeira resposta do
contato em vez de seguir o fluxo. Ausente vale `false`, salvo em `appointment_no_show`, onde ausente
vale `true`: a sequência de falta sempre para quando o paciente responde.

Um roteiro de atendimento (`surface: "atendimento"`) só publica com gatilho `manual`: ele começa por
palavra-gatilho (`settings.gatilhos`) ou pelo roteador.

### Caixas (`type`) e o `config` de cada uma

| `type` | Na tela | O que faz | `config` |
|---|---|---|---|
| `trigger` | Gatilho / Início do fluxo | Ponto de entrada. Um por fluxo. | `{}` |
| `wait` | Aguardar | Pausa. | Fixa: `{ "mode": "fixed", "duration_ms": 300000…7776000000 }` (5 min a 90 dias), opcional `immune_to_reply: true` (a resposta do cliente **não** encurta a espera; para cadências longas). Inteligente: `{ "mode": "smart", "min_ms", "max_ms", "guidance"? }` (a IA escolhe dentro da faixa). |
| `condition` | Condição | Decide o caminho pelo estado do lead. | `checks` (1–10 regras), `combinator` (`and`/`or`, padrão `and`), `branching` (`combined` = saídas Sim/Não; `per_check` = uma saída por regra, cada regra com `id`). |
| `ai_classify` | Classificar (IA) | Espera a resposta e a IA escolhe uma classe. | `classes` (1–8 nomes), `grace_timeout_ms` (mínimo 15 min: prazo para responder), `target` (`last_reply`/`summary`), `hint` (dica para a IA, até 500), opcional `branches` (ids estáveis; ver [Saídas](#saídas-de-cada-caixa-ligações)). |
| `match_reply` | Resposta (texto) | Espera a resposta e decide por texto, sem IA. | `branches` (1–8, cada uma `{ id, label, op: "eq"/"contains", pattern }`), `grace_timeout_ms` (mínimo 15 min), opcional `save_to` (`{ "kind": "contact_name" }` ou `{ "kind": "lead_custom", "key": "campo" }`) e `if_exists` (`skip`/`overwrite`/`confirm`). |
| `repeat` | Repetir | Repete o trecho `body` N vezes, com N tirado da última resposta (número ou palavra). | `{ "max_count": 1…20 }` |
| `action` | Ação | Envia mensagem. | Texto: `{ "mode": "text", "body": "…" }` (até 4000), opcional `media_url` (imagem, vídeo, áudio ou documento por URL; o `body` vira a legenda — no áudio, nota de voz, não há legenda). IA: `{ "mode": "ai_message", "prompt_hint": "…", "fallback_template_id"? }`. Modelo: `{ "mode": "template", "template_id": "<uuid>" }`. |
| `internal_task` | Lembrete interno | Cria tarefa para a equipe; **não** envia mensagem. | `titulo` (até 200), `vence_em_dias` (0–365), `atribuir_a` (`"dono_do_lead"` ou `{ "usuario_id": "<uuid>" }`), `prioridade` (`low`/`medium`/`high`/`urgent`). |
| `move_lead` | Mover lead no funil | Move o card para outra etapa **do mesmo funil**. | `stage_id` (vazio no rascunho; o Publicar exige), `lost_reason` (obrigatório ao mover para etapa de perda). |
| `edit_lead_tag` | Editar tag do lead | Grava tags no lead. | `tags` (até 10, até 60 caracteres cada; vazio só no rascunho). |
| `collect` | Pergunta | *(só roteiro de atendimento)* Um campo que a IA pergunta na conversa. | `key` (minúsculas/números/_), `label`, `type` (`text`/`number`/`date`/`boolean`/`select`/`cpf`), `required`, `permite_correcao`, `options` (para `select`), `question`. |
| `skill` | Skill | *(só roteiro de atendimento)* Puxa uma skill instalada para o passo. | `{ "skill_name": "…" }` |
| `end` | Fim | Encerra. | `outcome` (`converted`/`exhausted`/`custom`), `note`, opcional `ao_finalizar`: `{ "tipo": "nada" }`, `{ "tipo": "ia", "prompt"? }`, `{ "tipo": "skill", "skill_name" }` ou `{ "tipo": "proximo_fluxo", "fluxo": "<id do fluxo>" }`. |

**Variáveis no texto** (`body`, `titulo`): `{{nome}}`, `{{primeiro_nome}}`, `{{contact.name}}` e
outros campos do contato, `{{lead.title}}` e outros campos do negócio. Dentro de um `repeat`:
`{{volta}}` (a volta atual) e `{{voltas}}` (o total).

### Regras de condição (`checks`)

Cada regra é `{ "field", "op", "value" }`, com `id` e `label` opcionais (obrigatório `id` em `per_check`).

| `field` | O que compara | Operadores úteis |
|---|---|---|
| `lead_stage` | Etapa atual do lead (`value` = id da etapa) | `eq`, `neq` |
| `tag` | Tags do lead (`value` = a tag) | `eq`/`contains` = "tem a tag"; `neq` = "não tem" |
| `steps_taken` | Quantos passos o lead já deu no fluxo | `eq`, `gte`, `lte` |
| `last_outcome` | Última classe escolhida por um `ai_classify`/`match_reply` | `eq`, `neq`, `contains` |
| `lead_date` | Uma data num campo personalizado do lead (`key` = nome do campo, ex.: `fim_teste`), por dia de calendário no fuso da organização | `passou_ha` N (a data é hoje ou ficou N dias ou mais no passado; N = 0 inclui hoje), `falta_para` N (faltam N dias ou mais). Só estes dois operadores valem para `lead_date`. |

Dado ausente nunca satisfaz uma negação, e campo de data vazio ou inválido responde sempre "não": um lead que ainda não foi classificado **não** passa por
`last_outcome neq "quente"`.

### Saídas de cada caixa (ligações)

O `condition` de uma ligação diz por qual saída da caixa de **origem** ela sai:

| Caixa de origem | Saídas | Como a ligação escreve |
|---|---|---|
| Qualquer caixa de saída única | Sempre | `{ "type": "always" }` |
| `condition` combinada | Sim, Não, Outros casos | `{ "type": "cond_result", "value": true }` / `false`; `always` |
| `condition` `per_check` | Uma por regra, Nenhuma delas | `{ "type": "branch", "branch_id": "<id da regra>" }`; `always` |
| `ai_classify` (sem `branches`) | Uma por classe, Sem resposta, Outros casos | `{ "type": "class_match", "value": "<classe>" }`, `{ "type": "class_match", "value": "no_reply" }`; `always` |
| `ai_classify` (com `branches`) / `match_reply` | Uma por ramo, Sem resposta, Outros casos | `{ "type": "branch", "branch_id": "<id>" }`, `{ "type": "branch", "branch_id": "no_reply" }`; `always` |
| `repeat` | Próxima volta, Acabou, Outros casos | `{ "type": "branch", "branch_id": "body" }`, `"done"`; `always` |

`always` é a saída de "outros casos": o motor só a usa quando nenhuma outra serve, e nunca manda o
lead por duas ao mesmo tempo. Ids reservados (não use como id de regra/ramo): `else`, `no_reply`,
`true`, `false`, `body`, `done`.

### Configurações do fluxo

`graph.settings` (todas opcionais):

| Chave | Para que serve |
|---|---|
| `somente_interno` | O fluxo inteiro não fala com o cliente; o Publicar recusa qualquer caixa de envio. |
| `gatilhos` | *(roteiro)* Até 30 palavras/expressões que iniciam o roteiro quando aparecem na mensagem. |
| `max_tentativas_pergunta` | *(roteiro)* Quantas vezes uma pergunta é feita sem resposta (1–10, padrão 3). |
| `expira_em_horas` | *(roteiro)* Prazo, sem mensagem do cliente, para o roteiro expirar (1–720, padrão 72). |
| `pode_recomecar` | *(roteiro)* O roteiro pode começar de novo para quem já o concluiu. |

## Pela API

```bash
# Exportar (sessão do navegador)
GET /api/v1/ai/followup-flows/<id>/export
→ { "data": { "file_name": "….fluxo.json", "file": { …arquivo… } } }

# Importar
POST /api/v1/ai/followup-flows/import
{ "file": { …arquivo… }, "name": "opcional" }
→ 201 { "data": { "flow": { …rascunho criado… }, "pendencias": [ { "codigo", "bloqueia", "no", "referencia" } ] } }
→ 422 { "error": { "code": "invalid_flow_file", "details": { "problemas": [ "flow.graph…: …" ] } } }
```

Códigos de pendência: `etapa_remapeada`, `etapa_nao_encontrada`, `modelo_remapeado`,
`modelo_nao_encontrado`, `modelo_reserva_removido`, `responsavel_trocado`, `proximo_fluxo_remapeado`,
`proximo_fluxo_removido`, `gatilho_trocado_para_manual`. `bloqueia: true` = o fluxo não deve ir ao ar
sem você resolver.

# Spec 17 — A conversa vira lead

> Doutrina: [`sistema-vivo.md`](../doctrine/sistema-vivo.md) (invariantes 1, 3, 4 e 7) e
> [`separacao-fala-e-operacao.md`](../doctrine/separacao-fala-e-operacao.md) (quem opera é o Operador).
> Depende da [spec 16](16-spec-tres-papeis-do-agente.md): o papel Operador é quem move o funil.
>
> Base medida: `a9ac78e9`, produção do projeto em 2026-08-06.

---

## 1. O problema é UM só

A conversa e o CRM são **dois mundos que não se tocam**. O WhatsApp cria contato; o CRM tem lead;
e nada liga um no outro. Kanban vazio, agente sem regra e contato sem dado são **sintomas disso**,
não problemas separados.

### Medido na produção

| medida | valor | o que significa |
|---|---:|---|
| contatos **sem telefone** | **49 / 58 · 84%** | o ingest não consegue gravar o número |
| contatos sem email | 52 / 58 · 90% | não há caminho para capturar |
| leads **sem contato vinculado** | **13 / 15 · 87%** | o vínculo existe e está vazio |
| conversas × leads | **32 × 15** | quase toda conversa morre fora do funil |
| etapas mapeadas para o agente | **6 / 36 · 17%** | ele não sabe para onde mover |

### As causas, uma a uma

**Telefone.** O campo existe (`contacts.phone_number`). O WhatsApp entrega **`@lid`** — identificador
opaco — e `fn_upsert_wa_contact` só grava o telefone quando o tipo é `phone`. Efeito colateral
medido: `display_name` vira **`Contato 543134@lid`**. Vocabulário técnico na tela de quem atende — a
mesma doença que a spec 16 mediu em 30% dos turnos.

**Lead da conversa.** Não existe. Varredura em todo o repo: **nenhum código insere em `crm_leads` a
partir de conversa**.

**Kanban "sem vínculo".** ⚠️ **O vínculo EXISTE** — `crm_leads.contact_id` está no schema e a UI já o
usa (`LeadDossier` abre timeline por contato; `NewLeadDialog` permite ligar). Ele está **vazio**,
porque nada o preenche. Não é construir: é popular. A distinção muda o tamanho do trabalho.

**Escopo do agente.** `crm_move_lead_stage` move qualquer lead em qualquer funil. A produção tem 6
funis, incluindo "Comercial - Andrea", "Comercial - Julia" e "Suporte - IA" — nada impede o agente
de mexer no funil da Andrea.

**Regras de movimentação.** Existe metade: `lib/leads/agent-mapping.ts` traduz os 7 estágios do
agente para as etapas do funil do tenant, com tela em `settings/tenant/pipelines`. Mas **6 de 36
etapas mapeadas**, e os funis Comercial/Suporte têm **zero** — nesses, o agente não sabe para onde
mover.

---

## 2. Decisões fechadas

| # | decisão | consequência |
|---|---|---|
| **a** | **O lead nasce sempre**, na etapa de entrada | funil enche de curioso — e é o certo: o invariante 4 diz que nada fica fora do radar. Quem não avança morre na primeira etapa, **visivelmente** |
| **b** | **Funil de entrada é CONFIGURÁVEL**, nunca fixo | vale para o produto, não para uma org. Ver §3 |
| **c** | **O sistema cria; o agente cria e move** | a criação de entrada é determinística (não depende de modelo); o agente pode abrir oportunidade nova e mover, **dentro do escopo marcado** |

### Sobre (b), que é a decisão estruturante

Nada de "o funil é o Pedidos". O produto é self-host, multi-tenant e o funil é do dono do negócio —
uma clínica, uma imobiliária e um infoprodutor não têm o mesmo desenho.

**O funil de entrada reusa `crm_pipelines.is_default`**, que já existe, já tem tela e já tem regra de
exclusividade (`lib/pipelines/pipeline-editing.ts`). Não se cria campo novo para o mesmo conceito
(DIRC — *Duplicar?* não: já vive aqui).

**A etapa de entrada é a de menor `position`** entre as não-arquivadas. Não se cria flag
`is_entry`: a ordem do funil **já** diz qual é a primeira, e um segundo lugar para a mesma verdade
é onde a divergência nasce.

---

## 3. O elo que falta

```
mensagem chega → contato (existe) → [LEAD]  ← a peça nova
                                      ↓
                              kanban · timeline · Operador · follow-up
```

**Quando:** primeira mensagem **inbound** de um contato que não tem lead aberto.
**Onde:** funil `is_default` da organização, etapa de menor `position`.
**Quem:** o runtime, determinístico — não o modelo (mesma razão do checkpoint imposto na spec 16).

**Não nasce lead** quando: é grupo (`@g.us`), o contato está bloqueado/opt-out, ou já existe lead
aberto para ele. Cada recusa é registrada — silêncio não distingue "não devia" de "falhou".

---

## 4. O contato para de nascer anônimo

1. **Telefone do `@lid`** quando o WAHA o fornecer em qualquer campo do payload; quando não,
   `phone_number` fica nulo — mas o **`display_name` nunca exibe identificador técnico**.
2. **O Operador ganha capacidade de salvar dado que o cliente disser** (email, nome real). É assim
   que um CRM se preenche num negócio de verdade: alguém diz o email na conversa, e ele fica.

---

## 4b. O dado que o cliente diz na conversa — fila, não escrita direta

> Decidido pelo Rafael em 2026-08-06, depois de a medição mostrar que não havia política nenhuma.

**Por padrão, o Operador PROPÕE; um humano CONFIRMA.** A IA não sobrescreve os dados da ficha. O problema não é
hipotético: `contactPatchSchema` aceita e-mail livre, o handler não lê o valor anterior antes de
sobrescrever, e o audit grava só os NOMES dos campos alterados — um e-mail dito de brincadeira
substituiria o correto e **o valor antigo não existiria em lugar nenhum**.

Note a assimetria que ficaria sem esta decisão: o `pushName` do WhatsApp é CONGELADO pelo
`coalesce` do upsert, e o e-mail dito ao robô seria sobrescrevível à vontade.

**Exceções opt-in do contrato atual:** a organização pode permitir preencher telefone vazio
e, nesta contribuição, nome vazio em **Configurações → Distribuição de atendimento**. O nome
exige seleção pela capacidade `crm_propose_contact_field`, mensagem inbound real do próprio
contato, contexto e revisão do runtime, correspondência com o texto e CAS que preserva edição
humana. As opções vêm desligadas; nome existente diferente, e-mail e nascimento continuam
aguardando revisão. O percurso e seus limites estão em
[`Aviso de transferência humana e nome informado`](../features/atendimento-alerta-humano-nome-informado.md).
A aplicação automática do nome registra auditoria, muda a ficha e deixa uma linha na timeline
do contato (como o telefone aplicado); não grava consentimento. A seção abaixo descreve a confirmação humana, não transforma a
autoaplicação em confirmação ou consentimento do titular.

### Base legal — aplicada, não inventada

A regra **L-05** já existe no catálogo e já define o vocabulário: categorias `marketing` /
`transactional` / `profiling`, campo `contacts.consent.<categoria>.granted_at`. E a exceção dela diz
que comunicação **`transactional` originada pelo próprio cliente** é dispensada de verificação.

Um dado que a pessoa digita espontaneamente num atendimento **que ela iniciou** é exatamente esse
caso. Logo: escopo `transactional`, `granted_at` = o instante da confirmação humana, `source` =
quem confirmou e de onde veio.

**Nada disso é formato novo.** `lib/lgpd/export-collector.ts:197-215` já LÊ
`{escopo: {granted, granted_at, source}}` de `contacts.consent` — o leitor existe há tempo e o
escritor nunca foi escrito. Preencher o que já é lido é o oposto de criar um segundo lugar para a
mesma verdade.

### O que a confirmação fecha, de graça

| exigência | como a fila resolve |
|---|---|
| **L-06** — audit com `from/to` em mutação de `contacts.email` (exceção: "Nenhuma") | a proposta guarda o valor anterior; a confirmação tem os dois lados |
| **L-04** — anonimização é irreversível | proposta pendente sobre contato anonimizado é descartada, não aplicada |
| invariante 3 (log visível) | a pendência aparece na Central, não só no banco |
| invariante 7 (todo laço se fecha) | rejeitar é sinal: o que o humano recusa diz onde a IA erra |

---

## 5. Escopo e regras do agente

**Escopo:** o agente opera só nos funis marcados. Sem marcação, **nenhum** — falha fechada: um
agente novo não sai movendo card de ninguém.

**Regras:** a área de CRM na configuração do agente é a ideia do Rafael, com uma correção de rumo
declarada: **não é campo de prosa para "treinar"**. Prosa vira o defeito da spec 16 — instrução que
o modelo esquece, ou repete ao cliente. É uma **tabela de tradução**: para cada etapa do funil, o
que precisa ser verdade para o agente mover para lá. É o `agent_stage_hint` que já existe, com
superfície boa e cobrança de completude.

---

## 6. Living System Checklist

| # | pergunta | resposta |
|---|---|---|
| 1 | quem me alimenta? | ingest do WAHA (`lib/waha/`), na primeira inbound |
| 2 | quem eu alimento? | kanban, timeline do lead, Operador (spec 16), motor de follow-up, Radar de Risco |
| 3 | que registro emito? | `crm_lead_activities` (nascimento e cada movimentação, com evidência) |
| 4 | onde apareço na tela? | card no kanban + linha na timeline do contato |
| 5 | por qual porta? | `/app/kanban` (já registrada) |
| 6 | anti-morte? | o lead entra no funil ⇒ passa a ser visto pelo Radar e pelo follow-up. **É o anti-morte que hoje não existe: conversa fora do funil não é cobrada por ninguém** |
| 7 | onde se configura? | funil de entrada (`is_default`, tela de funis) · escopo do agente (aba do Operador) · tradução de etapas (`settings/tenant/pipelines`) |
| 8 | continuidade IA↔humano? | o lead carrega o contato ⇒ o handoff entrega histórico **e** posição no funil |
| 9 | laço de retorno? | movimentação do agente que o humano **desfaz** vira sinal — sem isso ele erra igual amanhã (invariante 7) |
| 10 | mapa atualizado? | `docs/architecture/` ganha a aresta conversa→lead |

---

## 7. Ordem de construção

| # | passo | sinal de sucesso | estado |
|---|---|---|---|
| 1 | **conversa vira lead** (elo que falta) | conversa nova ⇒ card no kanban ligado ao contato | ✅ provado na tela |
| 2 | **contato deixa de ser anônimo** | zero `display_name` com `@lid`; telefone quando o payload traz | ✅ provado na tela |
| 3 | **escopo por pipeline** | agente sem marcação não move nada | ✅ código + tela; ⏳ prova de tela |
| 4 | **tradução de etapas com superfície** | as 36 etapas mapeadas, ou a falta visível | ✅ a lacuna aparece onde custa |
| 5 | **o laço** | desfazer movimentação do agente vira sinal | ✅ detectado, registrado e agregado |

### O que cada passo virou, na prática

**1.** O lead nasce no funil `is_default`, na primeira etapa aberta, com o contato vinculado — e
com atividade na timeline dizendo de onde veio. Achado no caminho: toda organização nasce com um
funil de **e-commerce** (`Pedidos`, com *Carrinho abandonado*), então numa clínica o lead nasce ali.

**2.** O telefone **sempre chegou** em `_data.key.remoteJidAlt` (76 de 76 payloads `@lid`) e nunca
foi lido. Gravá-lo exigiu `contacts.wa_lid`, porque preencher `phone_number` mudava a identidade
gerada e duplicava o contato. E o canal de envio NÃO muda: conversa que veio por `@lid` continua
saindo por `@lid`.

**3.** `ai_agent_versions.pipeline_ids`, com backfill derivado do histórico real (sem ele, todo
agente pararia de mexer em card no dia do deploy). O gate é uma função pura chamada onde se sabe
que quem age é o agente — não nos handlers, que são compartilhados com pessoas e automações.

**4.** A lacuna de tradução aparece **ao lado da marcação do funil**, no momento da decisão — e só
para funil marcado, porque fora do escopo ela não custa nada.

**5.** Um humano mover um card que a IA moveu por último vira atividade própria, com a etapa que a
IA escolheu — o dado que responde "onde ele mais erra".

**O passo 1 vem primeiro porque sem ele os outros não têm o que mover.**

---

## 8. Não-objetivos

- **Não** criar campo `is_entry_pipeline`: `is_default` já é isso.
- **Não** criar flag de primeira etapa: `position` já ordena.
- **Não** dar ao agente um campo de prosa para "aprender o CRM" (§5).
- **Não** deixar o agente criar lead sem escopo marcado.
- **Não** resolver identidade probabilística (juntar contatos que talvez sejam a mesma pessoa) —
  fora do MVP, e a spec 02 já trata do determinístico.

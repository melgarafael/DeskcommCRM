# Spec 16 — Os três papéis do agente

> Executa [`docs/doctrine/separacao-fala-e-operacao.md`](../doctrine/separacao-fala-e-operacao.md),
> agora com o número medido e as decisões de produto fechadas.
> Doutrina irmã: [`sistema-vivo.md`](../doctrine/sistema-vivo.md).
>
> Base medida: `origin/main` = `0a85d251`, árvore limpa.

---

## 1. O problema, com número

Um agente que **fala com o lead** e **opera o CRM** no mesmo contexto sofre contaminação que não
tem saída por prompt. O ciclo é conhecido e reprodutível:

- o prompt **não ensina** a operar → ele responde bem e não mexe em nada;
- o prompt **ensina** → ele mexe, e conta ao lead que mexeu.

**Isso deixou de ser hipótese em 2026-08-05.** 18 turnos com `gpt-5.6-terra`, um por corrida,
gate desarmado (vazamento cru), relatório em
[`evidence/ia-360-w4/medicao-vazamento/RELATORIO.md`](../../evidence/ia-360-w4/medicao-vazamento/RELATORIO.md):

| prompt | turnos | com vazamento | taxa |
|---|---:|---:|---:|
| **OPERADOR** ("atende E mantém a casa em ordem… USE as ferramentas") | 10 | 3 | **30,0%** |
| **ATENDIMENTO** (voz de paciente, self-hoster comum) | 8 | 0 | **0,0%** |

O zero vale: cinco dos oito cenários pisam de propósito no território das capacidades e **três
chamaram ferramenta de verdade**. Zero por tradução, não por silêncio.

**A conclusão que dirige esta spec: o prompt é a variável dominante.** Não é o modelo que é ruim,
não é a rede que segura os 0%. É que ensinar a operar e pedir para não falar disso são ordens
contraditórias dadas no mesmo lugar.

### 1.1 São TRÊS portas de vazamento, não uma

A doutrina previa duas. A medição achou a terceira, e ela muda o desenho:

| # | porta | evidência medida | fecha como |
|---|---|---|---|
| 1 | **`description` da tool** | `"…(webhook_sources)"` → *"nenhuma entrada automática de contatos (webhook)"* | não mostrar a tool |
| 2 | **`name` da tool** | após limpar a description, voltou por `crm_list_webhook_sources` | não mostrar a tool — `name` é contrato de wire, não se renomeia |
| 3 | **o DADO que a tool devolveu** | *"deram erro na ação de webhook: `unsafe_url:https_required`"* | **projeção do retorno** — esconder a tool não basta |

> **A porta 3 é a que a doutrina subestimava.** Ela dizia "com retorno já traduzido"; a medição
> mostrou que o retorno cru é uma fonte independente e igualmente potente. Um Conversador que não
> vê tool nenhuma mas recebe payload cru continua vazando.

**Achado adjacente, mesma família:** a resposta `9-quem-pede-mexer` despejou **UUIDs crus de
usuários** na tela do cliente. Não é vocabulário — é **dado interno**. O detector de vazamento PEGA uuid por FORMA (a regra E2 de
> `vazamento-interno.ts`, desde 2026-08-05) — mas isso é REDE, não cura: ela barra a
> mensagem já escrita e gasta um veto, enquanto a projeção (§4) impede que o dado
> chegue ao modelo. A frase anterior desta linha dizia que o detector não pega uuid
> "por desenho", e instruía o leitor a não contar com uma rede que existe.
---

## 2. Decisões fechadas

Aprovadas por Rafael em 2026-08-05. Cada uma com o que ela exclui.

| # | decisão | consequência |
|---|---|---|
| **a** | **Uma unidade, três papéis** | não são 3 agentes na lista. "O SDR da clínica" é uma coisa só; o Intent Router continua escolhendo a unidade |
| **b** | **O Operador roda DEPOIS do envio** | o lead nunca espera o CRM. A promessa vira obrigação registrada que o Operador quita; falha vira item na Central, nunca silêncio |
| **c** | **Operador desligado ≠ registro desligado** | ver §2.1 |
| **d** | **2 tentativas de correção, depois handoff humano** | silêncio nunca é opção |
| **e** | **Custo aceito** | +1 chamada por turno com Operador ligado. É por isso que desligar existe de verdade |
| **f** | **Camada de projeção do contexto** | trabalho próprio, não brinde de outra tarefa (§4) |
| **g** | **A UI pode ser reorganizada** | as 6 abas de hoje viram a estrutura de §6 |

### 2.1 O que "desligar o Operador" significa (decisão c)

A declaração do Conversador **já é linguagem de negócio** — "prometi retorno na terça", "desistiu
por preço". Virar `update_lead_state`, agendar o follow-up prometido e emitir a atividade na
timeline é **tradução determinística do contrato, sem LLM**.

Portanto:

| com Operador **ligado** | com Operador **desligado** |
|---|---|
| registro básico (estado, follow-up, timeline) | **idem** — por código, não por modelo |
| julgamento sobre as 51 capacidades do catálogo: abrir caso, distribuir atendente, marcar, criar etapa, mexer em automação | **ausente** |
| custo: +1 chamada de modelo por turno | custo: zero adicional |

**Desligar o Operador não pode produzir um agente mudo para o sistema.** Um agente que conversa e
não deixa rastro viola o invariante 4 do sistema vivo (nada morre sem próximo passo). A tela dirá
exatamente isto, sem jargão: *"ele continua registrando o básico sozinho; o que você desliga é a
capacidade de mexer na operação."*

---

## 3. Os três papéis

### 3.1 Conversador — fala, e só

- **Vê:** voz da marca, conhecimento do produto, regras de atendimento, histórico **projetado**
  (§4), memória do lead.
- **Não vê:** nome de ferramenta, nome de tabela/coluna, papel de acesso, código de erro, UUID.
  Ele não sabe que existe um CRM.
- **Tools:** `send_message`, `get_lead_context`, `search_knowledge`, `get_lead_note`,
  `read_skill_reference`. Leitura e fala — **nenhuma escrita**.
- **Saída:** duas coisas separadas — a **mensagem** e a **declaração** (§5).

### 3.2 Operador — opera, e nunca fala

- **Disparo:** evento (`event_log` + worker), imposto pelo runtime. **Roda sempre** que o turno FECHOU (o checkpoint existe) e o papel está
  ligado, inclusive quando o Conversador não declarou nada. Turno que morre antes do
  fechamento não gera Operador naquela tentativa; se o job morre de vez, o laço fecha
  pelo `job_dead` crítico na Central.
- **Vê:** estado do lead, a declaração, o histórico, as 51 capacidades do catálogo.
- **Tools:** as de escrita do catálogo MCP + as nativas de operação (`update_lead_state`,
  `schedule_followup`, `save_lead_note`, `open_human_case`, `provide_case_update`).
- **Não tem canal.** `send_message` não existe no toolset dele. Não é regra de prompt — é ausência.
- **Saída:** chamadas de ferramenta + registro. Um turno sem ação é **"nada a fazer" registrado**,
  nunca um `return` mudo.

> **O Conversador NUNCA chama o Operador.** Isso devolveria o problema inteiro: voltaria a depender
> do modelo lembrar, e um turno em que ele "não achou necessário" seria um lead parado em silêncio.
> É a mesma razão pela qual o checkpoint de fechamento é imposto pelo runtime e não é tool.

### 3.3 Segurança — verifica antes de sair

**Não é um terceiro LLM genérico revisando tudo.** É a superfície de configuração da cadeia que já
existe, mais os classificadores onde regra não alcança.

| camada | natureza | custo | estado |
|---|---|---|---|
| 10 gates de `BEFORE_SEND_GATES` (v6) | determinística | zero | **pronto** |
| promessa semântica | LLM auxiliar | 1 chamada/envio | **pronto**, opt-in |
| jailbreak (inbound) | LLM auxiliar | 1 chamada/turno | **pronto**, opt-in |
| vazamento de vocabulário | determinística | zero | **pronto** (`internal_vocabulary`) |

O que falta é **superfície**: hoje o dono do negócio não sabe que tem 10 gates, e os knobs de modelo
auxiliar vêm do `.env`, não da tela.

> **Por que não um revisor LLM genérico:** um gate determinístico é auditável, custa zero, tem
> trace por linha e não alucina. Um revisor LLM sobre toda mensagem dobra custo e latência e pode
> ele mesmo errar. Chamada de modelo só onde regra não alcança — que é exatamente onde as duas
> camadas semânticas já estão.

---

## 4. A projeção — o que fecha a porta 3

Camada pura entre o retorno de qualquer leitura e os olhos do Conversador. Entrada: payload cru.
Saída: fatos em linguagem de negócio.

**Regras:**

1. **Allowlist, nunca denylist.** O que não está declarado como projetável não passa. Uma denylist
   envelhece a cada coluna nova; uma allowlist falha fechado.
2. **Nenhum identificador atravessa.** UUID, id numérico, `external_id` — o Conversador não precisa
   deles para conversar, e foi exatamente por aí que os UUIDs chegaram ao cliente.
3. **Erro vira consequência, não código.** `unsafe_url:https_required` → *"a integração está
   configurada com um endereço que não é seguro"*. O mapa mora em código, com teste.
4. **Rótulo do tenant vence.** Etapa chamada "Aguardando pagamento" é vocabulário do cliente e passa
   inteira; `stage='qualifying'` não passa.

O que o **Operador** vê não é projetado — ele precisa do dado cru para operar, e não tem canal para
vazar.

---

## 5. O contrato entre os papéis

**JSON validado por Zod, nunca prosa.** Prosa contamina; esquema não.

O contrato já existe pela metade: `lead_checkpoints` (compromissos, objeções, `next_action`, rolling
summary) e `lead_state` (estágio). Esta spec o **promove a fronteira declarada** e acrescenta o
campo que falta: a **declaração de intenção** do turno.

```
DeclaracaoDoTurno {
  intencoes: Array<{
    o_que: string          // linguagem de NEGÓCIO: "quer remarcar", "desistiu por preço"
    evidencia: string      // trecho da conversa que sustenta
  }>
  promessas: Array<{
    o_que: string          // "vou verificar com a equipe e te retorno"
    prazo: string | null   // ISO-8601 quando houver
  }>
  nada_a_declarar: boolean // explícito: o turno não teve intenção nem promessa
}
```

**`nada_a_declarar` é campo, não ausência.** A diferença entre "o Conversador avaliou e não havia
nada" e "o Conversador esqueceu" é a diferença entre um sistema vivo e um silêncio — e um campo
opcional com default (`false`) é o padrão deste repo para wire que passa a distinguir estado novo.

**Toda promessa declarada é uma obrigação.** O Operador a quita ou registra por que não conseguiu.
Promessa sem quitação e sem registro é o defeito que esta spec existe para matar.

---

## 6. A UI

Reorganização das 6 abas atuais. O eixo é **disciplina de informação**: nada passa batido, e cada
controle diz onde impacta.

```
┌─ Identidade ──────────── quem é, por qual número atende
├─ 🗣  Conversador ──────── voz, instruções, modelo, estilo de resposta
│                          "o que o cliente vê"
├─ 🔧  Operador ─────────── [liga/desliga] modelo, capacidades por pacote
│                          "o que acontece no sistema depois"
├─ 🛡  Segurança ────────── [liga/desliga por camada] os 10 gates, visíveis
│                          "o que é conferido antes de sair"
└─ Provas ──────────────── Teste · Execuções · Capacidades · Histórico
```

**Três regras de tela:**

1. **Cada papel mostra as tools QUE ELE tem** — não uma lista única do catálogo inteiro contra
   um teto só.
2. **O teto deixa de ser problema.** Hoje o Conversador carrega as 12 nativas mais as do
   catálogo num prompt só. Separado: Conversador ≈5, Operador ≈45. **Isso conserta um defeito
   existente, não é efeito colateral.**

   ⚠️ DUAS AFIRMAÇÕES DESTE ITEM VENCERAM, e as duas mediam contra régua que não existe mais:
   (a) o teto era 20 e passou a ser **25**, quando o dono do produto ficou sem como ligar as
   capacidades de agenda num agente cheio — o porquê está junto da constante em
   `lib/mcp/tools/selecao-por-pacote.ts`; (b) o e2e `capacidades-do-agente.spec.ts` **não está
   fora do CI**: ele roda em `SPECS_PARTE_2` de `.github/workflows/e2e.yml`, e `e2e` é status
   check obrigatório. Quem for planejar a divisão de papéis contra este item confere os dois na
   fonte antes.
3. **Desligar diz a consequência**, em pt-BR de dono de clínica, não "desabilitar agente operador".

### 6.1 O botão "Testar" mente hoje — e isso entra no escopo

`/api/v1/ai/agents/[id]/versions/[vid]/dry-run` chama `runAgent` de `lib/ai/runtime/agent.ts`, marcado
`@deprecated`, que **não importa `runBeforeSend`**. Medido: a cadeia inteira de guardrails está
ausente do build do app Next — ela vive no processo do worker.

**Consequência para o produto:** o self-hoster testa na tela, vê comportamento limpo, publica, e
produção se comporta diferente. É falha-em-verde no caminho de primeira impressão — a categoria de
defeito mais cara num produto que a pessoa instala sozinha.

De nada adianta uma tela de configuração impecável se o botão que a valida não exercita o que roda.

---

## 7. Sistema vivo — o checklist respondido

| invariante | como esta arquitetura cumpre |
|---|---|
| **1 · nada é ilha** | Conversador → declaração → Operador → CRM → timeline → humano → contexto do próximo turno |
| **2 · continuidade nos dois sentidos** | a declaração é o input estruturado que o humano lê no handoff **e** o que o Operador consome. Um artefato, dois leitores |
| **3 · log visível** | toda decisão do Operador emite `crm_lead_activities` — aparece na timeline, não só no banco |
| **4 · nada morre sem próximo passo** | o Operador roda sempre; `nada_a_declarar: true` é decisão registrada, não esquecimento |
| **5 · informação com propósito** | o veto devolve ao modelo o que escrever no lugar, não só a negativa |
| **6 · configuração tem superfície** | Operador que não consegue agir (papel, dado faltando) → item de inbox, nunca `return` mudo |

**Métricas que passam a existir:** taxa de ação por turno, promessas declaradas vs quitadas, turnos
em que o Operador quis agir e não pôde. Se ele parar de agir, alguém vê.

---

## 8. Ordem de construção

Cada passo vale sozinho. **Ordem inversa quebra o produto no meio.**

| # | passo | estado | sinal de sucesso |
|---|---|---|---|
| **1** | Gate de vazamento no `before-send` | ✅ **feito** (`0a85d251`) | **30% / 0% medidos** |
| **2** | Contrato de estado explícito (§5) | ⬜ | a declaração existe, é validada por Zod, e um turno sem ela reprova |
| **3** | Projeção do contexto (§4) | ⬜ | payload cru não alcança o Conversador; teste com o `unsafe_url:https_required` real |
| **4** | Operador nasce por evento, em paralelo | ⬜ | ele age nos casos em que o turno único não agia — comparável lado a lado |
| **5** | UI dos três papéis (§6) + `Testar` no caminho real (§6.1) | ⬜ | o self-hoster configura os três sabendo o que cada um faz |
| **6** | Tirar as tools de escrita do Conversador | ⬜ | **o vazamento medido no passo 1 vai a zero por ausência, não por filtro** |

O passo 6 é o último de propósito: ele só é seguro depois que o 4 estiver cobrindo de verdade.

---

## 9. Não-objetivos

- **Não** transformar os 10 gates determinísticos em agente de IA (§3.3).
- **Não** deixar o Conversador chamar o Operador (§3.2).
- **Não** renomear nenhuma tool — `name` é contrato de wire, agentes publicados em VPS de clientes
  o referenciam.
- **Não** confundir os dois eixos: o Intent Router escolhe **qual unidade** atende o assunto; os
  papéis são a divisão **dentro** de uma unidade. Os dois convivem.
- **Não** resolver aqui os dois achados adjacentes registrados na medição: o inbound que não ganhou
  turno próprio (5 mensagens, 4 jobs, nenhum `deduped`) e a 2ª camada do fail-safe de vazamento,
  não exercitada. Ficam rastreados, fora do escopo.

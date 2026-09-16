---
name: sistema-vivo
description: Doutrina de arquitetura do Sistema Vivo — o método para construir software em que nada morre por falta de resposta, resolução ou visibilidade. USE SEMPRE ao implementar, projetar ou refatorar QUALQUER peça de um sistema que atende pessoas (lead, agente, atendente, follow-up, conversa, pipeline, handoff, demanda, caso, métrica, painel, log, tela, worker, rota, tabela). Aplica os 7 invariantes — nada é ilha, continuidade IA↔humano nas duas direções, log universal e visível, nenhuma demanda sem próximo passo, informação com propósito, configuração com superfície, todo laço se fecha — mais a regra do tempo (observação em realtime, ação no tempo do humano). Aciona em toda task que adiciona ou muda comportamento, dado, rota, componente, worker ou métrica. Fonte: docs/doctrine/sistema-vivo.md (lei) e docs/doctrine/sistema-vivo/ (manual).
---

# Sistema Vivo — gate de arquitetura

Esta skill é o **gate operacional**. A lei está em `docs/doctrine/sistema-vivo.md`; o racional completo, no manual `docs/doctrine/sistema-vivo/`.

> **Portabilidade:** as seções 1 a 6 são universais — valem em qualquer sistema que adote a doutrina. A seção 7 (*Binding*) é o que muda de repositório para repositório. Ao levar esta skill para outro sistema, **reescreva só a seção 7**.

---

## 1. O princípio em uma frase

O sistema é responsável pela **linha do tempo inteira de cada demanda** — alguém interessado ou alguém com um problema — até a resolução ou o encerramento declarado pela própria pessoa.

Nada morre por falta de resposta, de resolução, ou porque ninguém viu. Toda peça é um polvo: recebe e distribui.

---

## 2. O checklist — responda ANTES de declarar pronto

```
Living System Checklist — <nome da peça>

[ ] 1. Quem me alimenta?          → aresta de entrada; fonte real e confiável
[ ] 2. Quem eu alimento?          → aresta de saída; "ninguém" = ilha
[ ] 3. Que registro eu emito?     → atividade / auditoria / evento
[ ] 4. Onde eu apareço na tela?   → registro só no banco é registro morto
[ ] 5. Por qual porta se chega?   → ter tela ≠ ser alcançável
[ ] 6. Qual meu anti-morte?       → próximo passo garantido, ou justificativa
[ ] 7. Onde se configura?         → ver + mudar + o que aparece se faltar
[ ] 8. Qual a continuidade?       → IA↔humano, nas DUAS direções
[ ] 9. Qual meu laço de retorno?  → o que muda no sistema quando eu erro
[ ] 10. Atualizei o mapa?         → peça nova entra com ≥2 arestas
```

**Como se responde mal, e é o padrão:** respondendo o que a peça *poderia* fazer. A resposta válida **nomeia o artefato concreto** — o consumidor real, a tela real, o log real. *"Vai aparecer no painel"* não é resposta; *"aparece na timeline do lead, renderizada por `<componente>`"* é.

**"Nenhum" é aceitável** nas perguntas 6 e 9, **com justificativa escrita**. Peça de leitura pura não tem anti-morte. Dívida declarada não é defeito; dívida presumida é.

---

## 3. Os 7 invariantes

| # | Invariante | Violação típica |
|---|---|---|
| 1 | **Nada é ilha** — ≥1 aresta de entrada e ≥1 de saída | CRUD disfarçado de feature |
| 2 | **Continuidade nas duas direções** — IA→humano entrega contexto pronto; humano→IA deixa input estruturado | Handoff que entrega conversa crua: transferiu custo, não contexto |
| 3 | **Log universal e visível** — emite atividade E aparece na tela | Log só no banco: ninguém lê, não muda decisão |
| 4 | **Nenhuma demanda sem próximo passo** — follow-up é o anti-morte | Silêncio tratado como neutro. Não é: é a perda mais comum e a mais invisível |
| 5 | **Informação com propósito** — todo dado responde "e daí?" | Painel de vaidade: números que sobem e não mudam nada |
| 6 | **Configuração tem superfície** — ver + mudar + falha visível | Mecanismo invisível que funciona; quando falha, falha sem culpado |
| 7 | **Todo laço se fecha** — decisão automática tem retorno que altera decisão futura | Esteira: 1–6 satisfeitos e o sistema não aprende nada |

**O 7 é o mais fácil de perder.** O 1 garante *caminho*; o 7 garante *ciclo*. A pergunta que expõe: **quando o sistema erra, o que muda nele?** Se a resposta é "fica no log", o log é estoque morto.

---

## 4. A regra do tempo

> **Observação em tempo real. Ação no tempo apropriado ao humano do outro lado.**

- **Observar** em realtime é direito do humano: painel, inbox, fila, falha, conversa ao vivo. Informação atrasada faz o anti-morte (invariante 4) chegar atrasado junto.
- **Agir** em realtime costuma ser errado. Quanto mais irreversível o efeito, maior o intervalo entre decidir e consumar. **Enviar mensagem a uma pessoa é irreversível** e nunca é operação comum.
- **Interruptibilidade:** o sistema nunca deve ser mais rápido do que o humano consegue interromper.

Nunca escreva "tudo em realtime" numa spec. Diga *quem observa* e *o que age*.

---

## 5. Receitas

### Implementar uma peça nova

1. **Localize antes de criar** — descubra de quem recebe e quem deve alimentar. Metade das ilhas nasce de desconhecimento do que já existe.
2. **Escreva as duas arestas primeiro** — antes da lógica interna. Se não consegue nomear as duas, a peça ainda não tem lugar no sistema.
3. **Log no mesmo commit da mutação** — log adicionado depois nunca é adicionado.
4. **Leve até a tela** — peça que funciona e não aparece falha sem culpado.
5. **Dê a porta** — registre o destino na navegação.
6. **Nomeie o laço** — o que muda quando ela acerta? e quando erra?
7. **Atualize o mapa** — arquitetura sem mapa é ilha de informação.

### Desilhar uma peça existente

1. **Meça antes de opinar** — quem chama, quem lê. Por ferramenta, não por memória.
2. **Ache o consumidor natural** — quase sempre já existe alguém que deveria ler aquilo.
3. **Uma aresta real vale mais que duas decorativas.**
4. **Sem consumidor, o caminho é remover.** Peça sem consumidor é dívida com aparência de recurso.

---

## 6. Red flags — pare e reconecte

| Sinal | Invariante ferido |
|---|---|
| "É só um CRUD de X" | 1 — X vivo tem métrica, log, destino de handoff, timeline |
| Mutação sem atividade emitida | 3 |
| Dado na tela que não muda decisão | 5 — ruído compete com o que importava |
| Demanda aberta sem próximo passo | 4 — algo vai morrer sem ninguém ver |
| Peça nova fora do diagrama | 3, aplicado à documentação |
| Handoff entrega conversa crua | 2 |
| Configuração só alterável no banco | 6 |
| Decisão automática sem sinal de retorno | 7 |
| "Vamos medir depois" | Nunca. A instrumentação some entre a intenção e o merge |
| Métrica de eficiência sem contra-métrica de dano | 5 — o sistema vai se otimizar contra si mesmo |

---

## 7. Binding — DeskcommCRM

> Reescreva **apenas esta seção** ao levar a skill para outro sistema.

| Pergunta do checklist | Neste repo |
|---|---|
| Que registro eu emito? | `event_log` (side effects) · `audit()` de `lib/audit/` → `api_audit_log` · `crm_lead_activities` (timeline do lead) |
| Onde apareço na tela? | Timeline no inbox · Radar de Risco (`/app/radar`) · painéis em `app/app/` |
| Por qual porta se chega? | `lib/navigation/registry.ts` — ou allowlist **com justificativa escrita** em `tests/unit/navegacao-completude.test.ts` |
| Qual meu anti-morte? | Motor de follow-up (`lib/followup/`, `lib/agent-engine/cron/`) + Radar de Risco |
| Qual a continuidade IA↔humano? | `buildHandoffSummary()` em `lib/agent-engine/agent/human-handoff.ts` |
| Atualizei o mapa? | `docs/architecture/*.json` (fonte da verdade). **Sem re-render:** o archify 2.11.0 recusa o formato `architecture` — ver `docs/architecture/README.md` |

**Orientação antes de implementar:** rode `graphify query "<pergunta>"` sobre `graphify-out/` para descobrir de quem a peça recebe e quem ela deve alimentar — evita criar ilha por desconhecimento do que já existe.

**Gates mecânicos ligados:** completude de navegação (`tests/unit/navegacao-completude.test.ts`) · forma da cadeia de envio (`tests/unit/before-send-chain-shape.test.ts`) · isolamento entre organizações (`tests/invariants/`).

**Não substitui outras doutrinas — rode junto:**

- Schema, RLS, migrations, DIRC → `CLAUDE.md` e skill `tomik-db-doctrine`
- Canais externos → `docs/doctrine/restricao-de-canal.md`
- Fala × operação → `docs/doctrine/separacao-fala-e-operacao.md`

Esta skill trata de **conectividade e vida**; as outras tratam de correção em eixos específicos.

**Definition of Done:** o item "Living System Checklist" do `CLAUDE.md` é este mesmo checklist. A task não fecha sem ele.

---

## Quando ler o manual

A skill basta para a maioria das implementações. Vá ao manual (`docs/doctrine/sistema-vivo/`) quando:

| Situação | Capítulo |
|---|---|
| Precisa do racional para convencer alguém (ou a si mesmo) | `01-fundamentos.md` |
| Está criando ou revisando um invariante | `02-lei-dos-invariantes.md` |
| Vai definir métrica, painel ou meta | `03-medida-do-proposito.md` |
| Mexe em handoff, escalada, permissão ou autoridade da IA | `04-fronteira-de-autoridade.md` |
| Mexe em lead, caso, conversa ou modelagem de demanda | `05-unidade-de-demanda.md` |
| Decide sobre realtime, throttle, delay ou agendamento | `06-tempo-do-sistema.md` |
| Trata de adoção, contribuição, telemetria ou patrocínio | `07-o-projeto-como-sistema.md` |
| Vai ligar um gate ou adotar a doutrina num sistema novo | `08-aplicacao.md` |

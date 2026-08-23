# Mapas de arquitetura

## Regra única deste diretório: o JSON é a FONTE; o HTML é DERIVADO

Cada mapa tem um `*.json` (fonte) e pode ter um `*.html` (render).

> **Se os dois divergirem, o HTML é que está errado.** Nunca edite o HTML à mão: regenere-o a partir do
> JSON.

O motivo está aqui e não num handoff porque é aqui que a decisão errada seria tomada. O HTML é o
formato mais fácil de abrir e editar — e **o formato mais fácil de editar é o que envelhece mentindo**:
uma correção feita nele parece funcionar, some na próxima geração, e nesse intervalo a fonte deixou de
ser fonte sem ninguém decidir isso.

## Mapas

| arquivo | escopo |
|---|---|
| `agent-turn.workflow.json` | os **dois** turnos do agente — Conversador (fala, 2 chamadas de modelo) e Operador (opera, sem canal). 24 peças, 33 arestas, 13 faixas. **É o único mapa que o archify renderiza** — ver o aviso abaixo |
| `crm-vivo.architecture.json` | subsistema **CRM Vivo** — 24 peças, 44 arestas, 6 faixas |
| `atualizacao-self-service.architecture.json` | botão de atualizar pela UI — `agent.sh`/`update.sh` (host) ↔ rota do agente ↔ tabelas de instância ↔ rodapé/tela |
| `gestao-funis.architecture.json` | gestão de funis pela tela do Kanban — 18 peças, 30 arestas; as três dependências do funil e por que só uma o banco defende |
| `ia-360-organizar.architecture.json` | IA 360 W4 — o agente organiza a operação: 18 peças, 24 arestas; uma regra por operação servindo REST e MCP, a autoria da configuração ao lado do estado, e **quatro não-ligações declaradas** (autoria não aponta para `ai_agents`; o agente não escreve regra automática, nem resposta pronta, nem o vocabulário canônico de marcadores) |
| `ia-360-retencao.architecture.json` | pacote **Não perder o cliente** (IA 360 · wave 2) — 26 peças, 36 arestas; a regra única do retorno para o motor e para a capacidade configurável, e por que cancelado precisou deixar de ser igual a disparado |
| `escalacao-ciclo-humano.architecture.json` | o ciclo agente ↔ pessoa — 30 peças, 38 arestas; as **três** travas da passagem (só uma era solta) e por onde a decisão da pessoa volta ao contexto do turno |
| `followup-dossie.architecture.json` | dossiê do follow-up e intervenção humana — 20 peças, 30 arestas; as **duas metades** da corrida contra o motor (o tick reclamado e o turno em voo) e quatro não-ligações declaradas |
| `indice-de-atrito.architecture.json` | índice de atrito — 24 peças, 31 arestas; a régua do atrito, o rádio que a lê e as demandas que entram nela |
| `marca-propria.architecture.json` | marca própria (white-label) — 37 peças, 54 arestas, 6 faixas; a pilha org → instalação → `.env` → padrão, as saídas SEM DOM (`marcaDaSaida`) e a **não-ligação declarada** do PDF de LGPD, que imprime o CONTROLADOR e nunca a marca de quem revende |
| `retencao-de-historico.architecture.json` | poda do histórico (issue #261 + migration 0172) — 18 peças, 20 arestas, 6 faixas; o que sai (`done`/`failed`/`dead` velho em `job_queue`/`api_audit_log`/`event_log`), o que tem dono e **não** sai (`pending`/`running`/`processing`, e `dead` com aviso ainda aberto), e por que o expurgo do audit é uma `security definer` sem seletor de linha em vez de uma porta |

> **Esta tabela já apodreceu uma vez:** ela listava 8 mapas quando o disco tinha 9 — faltava
> `indice-de-atrito`. Nenhum teste lê este README (o gate lê os `.json`), então mapa novo que
> não ganhe linha aqui nasce invisível para quem lê antes de codar. Confira com
> `ls docs/architecture/*.json` antes de confiar na lista.


### Aviso: só o `agent-turn.workflow.json` é renderizável hoje

Medido com archify 2.11.0: os `*.architecture.json` deste diretório **não validam em nenhum
dos dois modos**. Como `workflow` param no `diagram_type`; como `architecture` param na forma —
aquele schema pede `components`, não `lanes`/`nodes`/`edges`. Trocar o `diagram_type` não
resolve: os `node.type` que usamos (`api`, `service`, `table`, `lib`, `route`, `tool`,
`config`) estão fora do enum do archify
(`frontend|backend|database|cloud|security|messagebus|external`), vários `col` passam de 5, e
os `dot` `sky`/`red`/`blue`/`green` não existem no enum de cards.

A prova de que ninguém tentou renderizar está no próprio diretório: existe **um** `.html`, e é
o do único arquivo que valida.

Isto não invalida os outros mapas — eles seguem sendo a fonte da verdade em JSON, lida por
gente e pelo `tests/unit/mapas-de-arquitetura.test.ts`. Mas o README dizia "re-renderize" como
se fosse possível para todos, e não é: quem seguisse a instrução em qualquer um dos outros
receberia um erro de schema e concluiria que estragou algo.

### `crm-vivo.architecture.json` é PLANTA, não fotografia

Ele descreve o desenho **contratado** das oito waves do épico. As waves 6, 7 e 8 **ainda não existem em
código** — quem procurar essas peças no repositório não vai achar, e **o mapa não está errado: está
adiantado**.

Invariantes que a forma não mostra vivem nos `cards` do próprio JSON — inclusive as **não-ligações
deliberadas** (ex.: o score fica **fora** da publicação de realtime, de propósito). *Ausência de aresta
é indistinguível de aresta esquecida; por isso a não-ligação se **declara**, não se desenha.*

## O pedágio do eixo CONTATO × NEGÓCIO

Três peças diferentes pagaram o mesmo custo, e a quarta pagaria igual se isto
não estivesse escrito:

| onde | o que custou |
|---|---|
| **dossiê** (wave 6) | a timeline era indexada por `contact_id`; negócio sem contato ficava mudo — 25% dos leads, 64% das atividades |
| **reativação** (wave 7) | `cron_jobs` é por contato; negócio sem contato não pode receber proposta de retomada — 26 de 68 abertos |
| **funil do agente** (wave 8) | `lead_state.stage` é por contato e o card é por negócio; um contato com dois negócios exige decidir qual se move |

**A aresta:** `contacts` ─(1:N)─ `crm_leads`, e quase todo mecanismo do agente
vive do lado do CONTATO enquanto quase toda superfície do produto vive do lado
do NEGÓCIO.

**A regra que sai daí:** toda peça nova que ligue um mecanismo do agente a uma
superfície do CRM atravessa essa aresta, e precisa responder três perguntas
**antes** de ser escrita:

1. e se o contato tiver **dois** negócios abertos? — reuse
   `resolveActiveLeadForContact`, nunca escreva um segundo resolvedor;
2. e se o negócio **não tiver** contato? — é 25% dos casos, não é canto;
3. o que a peça faz quando não dá para decidir? — não agir e deixar rastro é
   resposta; agir no negócio errado não é.

As três vezes o custo foi o mesmo: descobrir a aresta **durante** a
implementação, com a peça já meio pronta.

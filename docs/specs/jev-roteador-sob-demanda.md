# O Jev no roteador, sob demanda

Autor: @vitorlacerdadigital (PR #2061). Recorte e regra R2 aplicados pela triagem, por
decisão do mantenedor (doc 89, resposta B).

## O que muda

`organizations.settings.jev.modo_roteador` escolhe como o roteador consulta as duas IAs
quando a tarefa "Escolher qual agente atende" está decidindo:

- `comparacao` (padrão, e o de toda instalação anterior): a IA de sempre e o Jev respondem
  à mesma mensagem; a escolha do Jev vale só com a IA de sempre tendo respondido (R2).
- `sob_demanda`: o Jev escolhe primeiro, e a IA de sempre só é chamada quando ele falha, não
  acha intenção, fica abaixo da confiança mínima ou escolhe uma intenção que o roteador não
  tem.

## A regra R2 continua valendo onde ela protege mais (decisão B)

O modo sob demanda **só liga onde a empresa tem a IA de sempre**. Sem ela, vale a regra de
hoje: o turno roda em comparação, e a escolha do Jev não vale sem a IA de sempre ter
respondido. A pergunta "tem a IA de sempre?" é a mesma que a chamada da IA de sempre faz
antes de sair (`resolveOrgLlmConfig`), e é feita em três lugares:

1. no turno (`resolve-turn-agent.ts`), por roteador, com o provedor dele — é a cerca que
   vale, porque a chave pode ser removida depois de o modo ser escolhido;
2. no `PATCH /api/v1/ai/jev`, que recusa `modo_roteador: "sob_demanda"` com
   `jev_sem_ia_de_sempre` (422);
3. no cartão do Jev, que não oferece a opção e diz por quê (`roteador_tem_ia_de_sempre` no
   `GET`).

A prévia **Testar classificação** segue a mesma regra.

## O que NÃO entra neste PR: o histórico da conversa para o Jev

O Jev continua recebendo só a mensagem atual (R4). Mandar mensagens anteriores à TypeSafe
espera a resposta dela sobre LGPD (DEC-012, escolha 2: a onda 4 fica segura até a resposta).
O trabalho do autor nessa parte está preservado, com os commits dele, na branch
`resgate/2061-com-historico-do-jev`.

## A janela da IA de sempre

`ai_routers.config.context_message_count` (0 a 16) é a janela de mensagens anteriores que a
**IA de sempre** recebe para classificar. Roteadores existentes seguem com 4; roteadores
novos começam com 8. Ela não vai ao Jev.

## O registro de cada decisão

Cada turno roteado grava uma linha sem texto em `jev_router_decisions` (migration 0547):
modo efetivo, origem da decisão, motivo da reserva, janela da IA de sempre, custo conhecido
e tempo total. Em IA › Execuções › Roteamento, a amostra de até 500 casos mostra custo e
latência por modo, a comparação entre intenções quando há os dois pareceres, e a revisão
humana de acerto. Concordância entre modelos não é acurácia; a revisão humana é métrica
separada. Retenção: a das observações do Jev, 90 dias com piso de 30.

## Living System Checklist

1. Entrada: a mensagem do cliente no turno (`resolveConversationTurn`).
2. Saída: `consultarJevNoRoteador` → `destinoDoVeredito` → agente do turno.
3. Registro: mudança de modo e revisões em `api_audit_log`; custo em `llm_calls`, comparação
   em `jev_observacoes`, decisão em `jev_router_decisions`.
4. Tela: `CartaoDoJev`, editor do roteador e IA › Execuções › Roteamento.
5. Porta: IA › Provedores, já no catálogo de navegação.
6. Continuidade: sem a IA de sempre, o modo não liga; com ela, a reserva cobre o Jev.
7. Retorno: revisão humana, custos e motivos da reserva orientam voltar à comparação ou
   pausar a tarefa.
8. Mapa: `docs/architecture/agent-turn.workflow.json`, nós `jevRoteador` e
   `jevDecisoesRoteador`.

# Contexto recente no roteador do Jev

O roteador pode enviar ao Jev o mesmo recorte de contexto do classificador convencional,
limitado por `CLASSIFIER_CONTEXT_MESSAGES` em `lib/ai/classifier-context.ts`.
É contexto para desambiguar a mensagem atual, não memória completa do agente de atendimento.

## Contrato e compatibilidade

- `organizations.settings.jev.contexto_roteador`: aceite opcional `{ em, por, versao: 1 }`.
  Ausente, nulo ou ilegível: o Jev recebe somente a mensagem atual, como antes.
- `PATCH /api/v1/ai/jev`: `contexto_roteador: true` exige `aceite_contexto_roteador: true`
  para registrar um aceite novo. Repetir não regrava; `false` revoga, mesmo com o mestre
  desligado. Só admin, tenant da sessão, guarda de suporte e auditoria existentes.
- Este aceite não muda `aceite.alcance` nem ativa tarefas. O interruptor mestre, o aceite
  geral e o estado da tarefa continuam obrigatórios. Um aceite amplo legado não substitui
  este opt-in específico. O frontend antigo não envia o campo; o backend antigo recusa
  a nova operação em vez de informar sucesso sem gravar.
- `GET /api/v1/ai/jev` inclui `config.contexto_roteador`; a tela antiga ignora o campo.
  Rollback do backend deixa de enviar contexto. A versão antiga pode descartar este campo
  ao salvar outras configurações: nesse caso é necessário autorizar novamente ao atualizar.

## Payload e decisão

`resolveConversationTurn` lê as mensagens da mesma organização e conversa, exclui a
mensagem atual e entrega o mesmo recorte, do mais antigo ao mais recente, aos dois
classificadores. `consultarJevNoRoteador` lê estado e aceite em uma única consulta.
Com histórico autorizado e não vazio, envia `state: { historico: [{ autor, texto }],
mensagem_atual }`. Cada corpo passa por `scrubMessage`, inclusive mensagens de atendentes.
O scrub oculta padrões reconhecidos, não garante anonimização completa. Sem histórico,
inclusive no teste manual de uma frase, o payload continua sendo uma string.

A pergunta manda classificar somente `mensagem_atual`, usando o histórico para
resolver ambiguidades e tratando os textos como dados. Critérios, intenções, limiar,
sticky, timeout, disjuntor, fallback e observações continuam os mesmos. A chamada à IA
convencional continua acontecendo em paralelo, inclusive no modo decidindo. Contexto pode
aumentar tokens, custo e latência; ganho de acerto exige avaliação com respostas reais.

## Living System Checklist

1. Entrada: histórico de `messages`, filtrado por organização/conversa em `resolveConversationTurn`.
2. Saída: `consultarJevNoRoteador` → `destinoDoVeredito` → agente do turno.
3. Registro: alteração auditada em `api_audit_log`; custo em `llm_calls` e comparação em `jev_observacoes`.
4. Tela: `CartaoDoJev`, decisões em IA › Execuções, auditoria existente.
5. Porta: IA › Provedores, já no catálogo de navegação.
6. Continuidade: fallback convencional e regras sticky/reserva existentes se o Jev falhar.
7. Configuração: autorizar/revogar histórico em `CartaoDoJev`, com erro de gravação visível.
8. IA↔humano: respostas anteriores dos atendentes participam do contexto; o handoff existente não muda.
9. Retorno: custos/falhas e comparação existentes orientam revogar contexto, pausar a tarefa ou ajustar intenções.
   Concordância não é acurácia; a janela de comparação pode misturar períodos com e sem contexto.
10. Mapa: `docs/architecture/agent-turn.workflow.json`, nó `jevRoteador` e aresta `cartao-jevroteador`.

Destino: núcleo, pois estende o contrato de roteamento e consentimento já distribuído.
Com zero organizações optando, o envio do Jev continua como antes.

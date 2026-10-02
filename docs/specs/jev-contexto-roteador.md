# Contexto recente no roteador do Jev

O roteador pode enviar ao Jev o mesmo recorte de contexto do classificador convencional,
limitado por `context_message_count` do roteador (`lib/ai/classifier-context.ts`).
É contexto para desambiguar a mensagem atual, não memória completa do agente de atendimento.

## Contrato e compatibilidade

- `organizations.settings.jev.contexto_roteador`: aceite opcional `{ em, por, versao: 1 | 2 }`.
  Aceite V1 preserva o limite de quatro mensagens mesmo em roteadores configurados para mais;
  V2 autoriza até 16, respeitando o limite do roteador. Ausente, nulo ou ilegível: o Jev
  recebe somente a mensagem atual, como antes.
- `PATCH /api/v1/ai/jev`: `contexto_roteador: true` exige `aceite_contexto_roteador: true`
  para registrar um aceite novo ou ampliar V1 para V2. Repetir V2 não regrava; `false`
  revoga, mesmo com o mestre desligado. Só admin, tenant da sessão, guarda de suporte e
  auditoria existentes.
- Este aceite não muda `aceite.alcance` nem ativa tarefas. O interruptor mestre, o aceite
  geral e o estado da tarefa continuam obrigatórios. Um aceite amplo legado não substitui
  este opt-in específico. O frontend antigo não envia o campo; o backend antigo recusa
  a nova operação em vez de informar sucesso sem gravar.
- `GET /api/v1/ai/jev` inclui `config.contexto_roteador`; a tela antiga ignora o campo.
  Rollback do backend deixa de enviar contexto. A versão antiga pode descartar este campo
  ao salvar outras configurações: nesse caso é necessário autorizar novamente ao atualizar.

## Payload e decisão

`resolveConversationTurn` lê até 16 mensagens da mesma organização e conversa, exclui a
mensagem atual e entrega o recorte configurado, do mais antigo ao mais recente, aos dois
classificadores quando ambos são chamados. Roteadores já existentes continuam com quatro
mensagens anteriores; roteadores novos começam com oito. O administrador pode escolher de
zero a 16 no editor. `consultarJevNoRoteador` lê estado e aceite em uma única consulta.
Com aceite V1, a janela comum de comparação fica em quatro até a autorização ser ampliada;
sem aceite, a IA convencional usa o limite configurado e o Jev recebe só a mensagem atual.
Com histórico autorizado e não vazio, envia `state: { historico: [{ autor, texto }],
mensagem_atual }`. Cada corpo passa por `scrubMessage`, inclusive mensagens de atendentes.
O scrub oculta padrões reconhecidos, não garante anonimização completa. Sem histórico,
inclusive no teste manual de uma frase, o payload continua sendo uma string.

A pergunta manda classificar somente `mensagem_atual`, usando o histórico para
resolver ambiguidades e tratando os textos como dados. Critérios, intenções, limiar,
sticky, timeout, disjuntor, fallback e observações continuam os mesmos. No modo
`comparacao`, a IA convencional e o Jev continuam em paralelo, inclusive quando o Jev decide.
No modo `sob_demanda`, disponível quando o Jev decide, só se chama a IA convencional se o Jev
falhar, não identificar intenção válida ou ficar abaixo da confiança mínima. O modo salvo
sem configuração explícita é `comparacao`, preservando instalações anteriores. Contexto pode
aumentar tokens, custo e latência; ganho de acerto exige avaliação com respostas reais.

Cada turno registra uma linha sem texto em `jev_router_decisions`: modo efetivo, origem da
decisão, motivo da reserva, janela de histórico disponível, custo conhecido e tempo total.
A janela não afirma que o Jev recebeu todo o histórico: o aceite específico continua limitando o envio. Em IA › Execuções ›
Roteamento, a amostra de até 500 casos mostra custo e latência por modo, comparação entre
intenções e destinos quando há os dois pareceres, e revisão humana de acerto. Concordância
entre modelos não é acurácia; a revisão humana é uma métrica separada. Custo desconhecido é
marcado como incompleto e não entra no total conhecido. A retenção acompanha as observações
do Jev, com padrão de 90 dias e piso de 30 dias.

## Living System Checklist

1. Entrada: histórico de `messages`, filtrado por organização/conversa em `resolveConversationTurn`.
2. Saída: `consultarJevNoRoteador` → `destinoDoVeredito` → agente do turno.
3. Registro: alterações e revisões auditadas em `api_audit_log`; custo em `llm_calls`, comparação em `jev_observacoes` e decisão em `jev_router_decisions`.
4. Tela: `CartaoDoJev`, editor do roteador e IA › Execuções › Roteamento.
5. Porta: IA › Provedores, já no catálogo de navegação.
6. Continuidade: fallback convencional e regras sticky/reserva existentes se o Jev falhar.
7. Configuração: autorizar/revogar histórico em `CartaoDoJev`, com erro de gravação visível.
8. IA↔humano: respostas anteriores dos atendentes participam do contexto; o handoff existente não muda.
9. Retorno: revisão humana, custos, falhas e comparação por janela de contexto orientam voltar à comparação, reduzir o contexto, pausar a tarefa ou ajustar intenções.
10. Mapa: `docs/architecture/agent-turn.workflow.json`, nós `jevRoteador` e `jevDecisoesRoteador` e arestas para Execuções.

Destino: núcleo, pois estende o contrato de roteamento e consentimento já distribuído.
Com zero organizações optando, o envio do Jev continua como antes.

O botão **Testar classificação** respeita o modo salvo: sob demanda dispensa a IA
tradicional quando o Jev escolhe intenção confiável, e informa que ela não foi
consultada. A prévia recebe somente a frase digitada; não gera observações nem
decisões reais no painel de resultados. Custos de teste continuam em Execuções.

---
impacto: capacidade_nova
secao: alterado
titulo: O fechamento do turno recusado duas vezes no modelo escolhido para o ponto é refeito no modelo do agente, sem repetir o turno
---

Quem escolheu em IA › Provedores um modelo próprio para o ponto do fechamento do turno (o resumo que o agente grava depois de responder) podia ver o turno inteiro se repetir quando esse modelo devolvia o resultado fora do formato duas vezes seguidas. A resposta ao cliente já tinha saído, mas a fila refazia tudo, inclusive a chamada principal do agente, que é a cara. Agora, nesse caso, uma terceira chamada só do fechamento vai ao modelo do agente. Se ela também falhar, o turno é repetido como antes.

Quem não escolheu modelo para esse ponto não vê diferença: o fechamento já roda no modelo do agente e nada muda.

Em IA › Execuções, essa terceira chamada aparece com o porquê «O modelo escolhido para este ponto devolveu o resultado fora do formato duas vezes; a chamada foi repetida no modelo do agente.». Se a sua integração lê o campo `origem_da_escolha` das execuções (`GET /api/v1/ai/runs`), ela passa a ver também o valor `reserva_de_formato`.

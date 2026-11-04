# Prontidão operacional adicional do Inbox

A instalação contribuinte diferencia comando estrutural da conversa e capacidade publicada de atendimento: canal, autorização de IA, campanha que originou a conversa, sticky do roteador, fallback e prioridade de agente. Uma conversa estruturalmente automática pode estar aguardando um agente elegível.

A main já possui a coluna denormalizada `contato_trava_humano` e o wrapper otimizado `comando_da_conversa`. Não se deve substituir esse ganho por consultas de prontidão em todas as linhas sem medir. Esta contribuição mantém o wrapper nativo intacto e propõe o campo calculado adicional `comando_operacional_da_conversa` para adoção explícita via PostgREST `select`/filtro. O campo usa SECURITY INVOKER: os dados de contato/canal/agente são lidos sob as permissões do chamador. Não amplia acesso nem autoriza IA.

Os helpers puros normalizam variantes telefônicas, validam a allowlist de teste e aplicam TTL inclusivo. O header de TTL altera apenas a classificação de leitura; não é autorização de atendimento. Sem header, vale 21 dias. Estado publicado/automático não prova execução nem entrega de resposta.

## Limites desta proposta

O consumidor padrão e as contagens da main **não são trocados silenciosamente**. Integrar este campo às abas exige decisão de produto e medir planos/custos com os mesmos filtros e papéis. Os consumidores de contexto estão relacionados ao PR #4007, mas este campo adicional não prova equivalência automática com a instalação original. Não foi executado DB/REST ou benchmark nesta branch.

Isso torna o delta de SQL disponível para revisão sem regressão silenciosa no caminho rápido. Sem adoção explícita, a main continua com a classificação anterior. Não confundir este recurso com o conserto de desempenho/RLS já contribuído.

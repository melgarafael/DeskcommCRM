---
impacto: nada_mudou
secao: corrigido
titulo: Os trabalhos de fundo respeitam o módulo que a empresa desligou
---

O aviso de queda na taxa de aceite de propostas e a conferência de WhatsApp da prospecção rodam sozinhos, sem ninguém olhando, e percorrem várias empresas na mesma execução. Até aqui eles decidiam pela instalação: uma empresa que desligasse Propostas (ou a conferência de WhatsApp) em Módulos por empresa continuava recebendo o aviso e tendo o número dos leads conferido em massa, porque o interruptor do servidor estava ligado. Agora os dois trabalhos leem também a linha da empresa, uma vez por rodada, e pulam só quem desligou — as demais seguem sendo processadas na mesma execução. O servidor continua sendo o teto: com o módulo desligado na instalação, nada roda, nem para quem tem a linha "ligado" na empresa; empresa sem linha continua herdando a instalação; e se a leitura das linhas por empresa falhar, a rodada não processa ninguém em vez de processar todo mundo. Não muda nada de banco, de tela nem de payload de job. Contribuição de @webtecnica (issue #4871).

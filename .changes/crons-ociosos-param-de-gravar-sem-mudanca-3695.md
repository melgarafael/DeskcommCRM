---
impacto: nada_mudou
secao: corrigido
titulo: Três rotinas de fundo deixam de gravar no banco quando nada mudou
---

Numa instalação parada, três rotinas gravavam no banco a cada minuto sem mudar nada: a sincronização das agendas Google carimbava todas as conexões do lote, a verificação do agendador de pausas fechava um aviso da Central que não existia, e o vigia das sessões do WhatsApp mandava atualizar sessões que já estavam certas. Agora cada uma só grava quando há o que mudar. A agenda Google continua passando por todas as conexões em rodízio, e continua registrando a última leitura quando uma agenda é lida. Isso reduz escrita e uso de disco do banco na VPS. Nada muda na tela nem na configuração.

Crédito: @webtecnica.

---
impacto: nada_mudou
secao: corrigido
titulo: Reverter uma versão ou criar um agente pela tela não desliga mais o follow-up automático
---

Ao reverter para uma versão antiga pelo Histórico ou ao criar um agente pela tela, a versão nova nascia com o follow-up automático no padrão (desligado), sem aviso. Ao criar uma versão pela API, a opção de o agente rascunhar proposta com IA voltava a ficar ligada, mesmo quando a chamada pedia desligada. Agora esses caminhos levam a configuração inteira da versão, e um teste reprova a próxima chave que for esquecida neles. Não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2011), fechando a #2004.

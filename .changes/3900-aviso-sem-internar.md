---
impacto: capacidade_nova
secao: adicionado
titulo: Avisar um membro da equipe que também é cliente sem tornar o número dele interno
---

Quem atende pode ser cliente da própria empresa — a equipe de uma agência de
viagens viaja pela própria agência, e o WhatsApp pessoal de cada atendente é um
contato do CRM. No modo `responsavel` o aviso de caso já saía para esse número,
mas a tela recebia `aviso_numero_de_cliente` e pedia confirmação: confirmar
transformava o número em **interno**, e a partir daí tudo o que a atendente
mandava deixava de virar contato, conversa e atendimento. Quando ela mesma
viajava e escrevia como cliente, a mensagem não chegava.

Agora, quando o destino é o WhatsApp de um membro **ativo** da equipe, o aviso
sai sem confirmação e o número **não** vira interno: as mensagens dele continuam
entrando no CRM como as de qualquer cliente. A exceção vale só no modo
`responsavel`; em `fixo` o destino é o número da empresa, ele vira interno de
verdade, e a pergunta continua sendo feita. Cliente comum que não é da equipe
também continua sendo perguntado, e `confirma_contato` segue obrigatório para
ele. A auditoria registra qual regra autorizou (`membro_da_equipe` ×
`confirmacao_explicita`), para que os dois casos não fiquem iguais no log.

A resposta do membro ao aviso continua funcionando: `RESPONDER`/`PERGUNTAR`
enviados do número de destino seguem sendo resposta de caso, e só a mensagem
comum é que passa a entrar como mensagem de cliente. O eco do próprio envio
continua sendo descartado, para o aviso não criar uma conversa consigo mesmo.

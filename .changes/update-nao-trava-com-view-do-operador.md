---
impacto: nada_mudou
secao: corrigido
titulo: A atualização não para mais quando o banco tem uma view própria sobre a Inbox
---

Quem tinha no banco um objeto próprio construído sobre o campo que diz quem atende cada conversa da Inbox (por exemplo, uma view de relatório ou de BI) via a atualização para a v1.119.0 parar com "cannot change name of input parameter c". Agora a atualização passa e mantém esse objeto. Quem já ficou com a atualização interrompida e ainda tem o objeto recebe uma mensagem que diz qual objeto remover antes de repetir a atualização; depois é só recriá-lo. Sem objeto próprio, nada muda e nenhuma ação é necessária.

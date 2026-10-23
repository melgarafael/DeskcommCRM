---
impacto: nada_mudou
secao: corrigido
titulo: A lista de conversas da Inbox deixa de travar quando a organização tem muitas conversas
---

A lista de conversas lê, para cada conversa, o número de WhatsApp por onde ela entrou. A regra que diz quem pode editar esse número também valia para a leitura, e ela é cara: consulta o papel da pessoa na empresa e se há uma sessão de suporte aberta. Por isso ela rodava de novo para cada conversa da lista. Numa instalação real com cerca de 570 conversas, a lista levava de 7 a 10 segundos ou não abria ("Erro interno"). Agora a regra de edição vale só para criar, alterar e apagar, e a lista volta em cerca de 100 ms na mesma instalação. Quem pode ver e quem pode editar não muda: qualquer pessoa da empresa vê o número, e só quem administra a empresa o altera. A atualização aplica a mudança sozinha; nada a fazer na VPS.

Contribuição de @rogercampel (fecha #3202).

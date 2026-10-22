---
impacto: capacidade_nova
secao: adicionado
titulo: Atendimento conjunto — convide colegas para a mesma conversa
---

Até agora uma conversa tinha **um** responsável: ou você assumia (e o outro saía), ou você passava (e você saía). As situações que pedem **dois perfis na mesma conversa** — fechamento com comercial e técnico, escalonamento sem trocar de mão, treinamento ao vivo, supervisão, dois departamentos — não tinham caminho: a transferência é mão única e a nota interna é contexto, não co-atendimento.

Esta entrega abre o **atendimento conjunto**. No **cabeçalho da conversa** aparecem **quem já participa** — avatares e nomes — e o botão **Convidar**, que abre o seletor com os colegas da sua organização. O convidado passa a ver a conversa e as mensagens dela e pode responder **junto** — sem entrar no lugar de ninguém; a lista do cabeçalho se atualiza no instante do convite.

Quem convida é o **responsável pela conversa** ou um **gestor**. Só entra quem é membro ativo da mesma organização com papel de atendente ou acima — `viewer` e gente de outra organização ficam de fora: o seletor não oferece quem já participa, e a rota recusa o resto com o motivo dito na tela.

**O que NÃO muda:** o **dono da conversa continua o mesmo**. Convidar não é assumir: quem responde pela conversa (e pode fechá-la ou transferi-la) segue sendo quem era antes do convite. É exatamente isso que permite o cenário em que o N1 continua atendendo enquanto o N2 entra para ajudar.

**O que o convidado NÃO vê:** as **notas internas**, os **rascunhos** e as **passagens** continuam pertencendo ao operador que conduz a conversa. O convite divide o **atendimento** (as mensagens da conversa), não a cozinha: as três policies continuam presas a `fn_can_view_conversation`, que não conhece participante.

O convite é **interno**: nada sai para o WhatsApp do cliente. Na auditoria ficam registrados os dois fatos, com quem foi convidado — `conversation.invited` e `conversation.participant_removed`. O **aviso para o convidado** (notificação) é fatia seguinte desta issue e ainda não está aqui.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2542).

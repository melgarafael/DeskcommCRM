---
impacto: nada_mudou
secao: corrigido
titulo: Salvar o rascunho de um agente para de escrever por cima de um rascunho antigo
---

Na tela de um agente, "Salvar rascunho" podia gravar numa versão **diferente**
da que estava aberta na tela — e apagar, no caminho, um rascunho antigo que a
própria tela prometia estar guardado.

O estado que produzia isso é comum e tem um gatilho conhecido: quem tinha
trabalho em andamento num rascunho e usou o botão **Reverter**, na aba
Histórico. Reverter cria uma versão nova e a publica na hora; o rascunho que
existia fica, a partir dali, "atrás" da versão publicada. A tela sabe disso e
avisa, no selo ao lado do nome do agente: *"o rascunho v5 é anterior a esta
versão e foi superado por ela — ele continua no Histórico."*

Só que o servidor não sabia. Ele procurava "o rascunho de maior número" e
gravava ali. Duas consequências, nenhuma delas com mensagem de erro:

- **O trabalho parecia sumir.** O aviso verde dizia "Rascunho v5 salvo.", a
  página recarregava, e a tela voltava a mostrar o texto anterior — porque ela
  não reabre um rascunho superado, e o botão de publicar também não o oferece.
  Quem estava editando via "salvo" e nada mudando, sem ter o que fazer a
  respeito.
- **O Histórico perdia conteúdo, em silêncio.** Aquele rascunho v5 é um
  retrato: a linha dele no Histórico existe para mostrar o que estava escrito
  ali. Regravá-lo trocava esse conteúdo por um texto que ninguém rascunhou
  naquele momento, sem aviso e sem volta.

Agora o servidor decide em qual versão escrever pela **mesma regra** que a tela
usa para decidir qual versão abrir. Quando o rascunho existente está superado,
a gravação nasce numa versão nova — que é a que a tela reabre e o botão publica
— e o rascunho antigo fica intacto no Histórico, como estava prometido.

Junto vem um cuidado que não aparece na tela mas decide o resultado: quem é a
versão publicada passa a ser sempre o **ponteiro que o atendimento executa**, e
não o rótulo "publicada" gravado na linha da versão. Os dois já se contradizem
em instalações reais, e a resposta otimista era a errada.

Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
nova, nenhum passo de atualização, nenhuma mudança no banco. O que muda é que
"salvei" volta a significar "está salvo onde você está vendo".

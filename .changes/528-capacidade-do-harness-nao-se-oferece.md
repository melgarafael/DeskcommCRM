---
impacto: nada_mudou
secao: corrigido
titulo: Ligar o pacote "Atender e responder" não oferece mais duas capacidades que o motor descartava
---

Na configuração do agente, o pacote **Atender e responder** listava duas capacidades com
checkbox marcável que o motor recusava em silêncio a cada turno: enviar mensagem de WhatsApp
e passar a conversa para uma pessoa. Quem marcava via o agente publicado com a capacidade
ligada, e nada acontecia — o único sinal era uma linha no log do worker.

As duas continuam existindo e continuam acontecendo: quem envia é o próprio sistema, pelo
caminho seguro, com opt-out, regra anti-ban e o silêncio dos follow-ups quando um humano
assume. O que muda é a tela — em vez de um checkbox que o motor descartava, ela mostra a
capacidade com o motivo escrito, e o pacote passa a contar só o que ele de fato entrega.

Quem instala não precisa fazer nada: nada que o agente já fazia deixou de funcionar, e
nenhuma capacidade ligada por engano passa a ter efeito.

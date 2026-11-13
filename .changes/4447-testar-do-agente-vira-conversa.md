---
impacto: capacidade_nova
secao: adicionado
titulo: O Testar do agente vira conversa — os turnos anteriores seguem junto e cada turno mostra as ferramentas que a IA usou
---

Antes, cada disparo do "Testar agente" ia ao motor sozinho e o painel apagava
o resultado anterior: não dava para ver como a IA reage a uma objeção, a uma
mudança de assunto ou à volta ao preço. Agora o painel mantém a conversa —
cada envio leva os turnos anteriores — e mostra, turno a turno, o que o
cliente disse, o que a IA respondeu e quais ferramentas ela chamou (inclusive
as de leitura, que antes não apareciam). "Recomeçar conversa" limpa tudo. A
conversa vive só na tela (recarregar recomeça), passa pelas mesmas janelas de
histórico da versão do agente e é recusada acima de 30 mensagens ou 20.000
caracteres. Nada é enviado a cliente real: o teste continua no modo de
simulação. Contribuição de @webtecnica (#4447).

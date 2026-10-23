---
impacto: nada_mudou
secao: corrigido
titulo: Quem não tem nome no cadastro aparece como "Atendente sem nome", e não como um código
---

Membro da equipe sem nome cadastrado — perfil antigo, convite não completado ou
instalação sem a chave de serviço — aparecia na tela de duas formas diferentes e
as duas erradas: no seletor de **Transferir para** a linha virava "Atendente
4fa3a91c", os oito primeiros dígitos do identificador interno dele, e a lista de
menções do compositor escrevia esse mesmo código dentro da nota interna, que é
lida pelos colegas e vira a notificação de quem foi mencionado. O identificador
não é nome: não ajuda ninguém a reconhecer a pessoa e não deveria aparecer em
tela nenhuma.

Agora os dois lugares mostram o mesmo rótulo **Atendente sem nome**, igual em
qualquer tela e em qualquer idioma da interface. Quem tem nome cadastrado
continua aparecendo pelo nome. O identificador segue indo apenas por dentro, no
registro da nota — é ele que faz a notificação chegar à pessoa certa —, nunca no
texto que se lê.

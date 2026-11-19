---
impacto: nada_mudou
secao: corrigido
titulo: A ficha do contato fala o idioma da tela na aba Linha do tempo e nos rótulos Email e Tags
---

Na ficha do contato, a aba "Timeline" e os rótulos "Email" e "Tags" estavam escritos direto no
código: com a tela em espanhol, a aba vizinha "Visão geral" virava "Resumen", mas esses três
ficavam como estavam.

Agora os três seguem o idioma da tela pelo dicionário, que já tinha as chaves: em espanhol a aba
diz "Línea de tiempo" e os rótulos "Correo" e "Etiquetas"; em português a aba passa a dizer
"Linha do tempo", e "Email" e "Tags" continuam iguais. As sondas e os roteiros de captura que
procuravam a aba pelo nome "Timeline" agora a acham também como "Linha do tempo".

Nada muda em quem já opera uma instalação: é só o texto da tela.

Contribuição de @yunshu0909, a partir da issue #4903.

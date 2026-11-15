---
impacto: capacidade_nova
secao: adicionado
titulo: O inglês pode ser escolhido como idioma da organização e do perfil
---

O inglês deixou de estar em construção: Configurações › Organização e o
perfil passam a oferecer **English** ao lado de Português e Español, e um
navegador em inglês sem preferência salva já abre o login em inglês.

Toda frase de tela tem inglês — o mesmo gate que cobra o espanhol agora cobra
o inglês (`tests/unit/i18n-espanhol-cobre-a-tela`). A prosa fixa que o motor
do agente injeta no prompt e os textos que saem para o cliente (aviso de
passagem para humano, avisos do sistema) também seguem o idioma da
organização, porque passam pelo mesmo dicionário. Datas usam o `Locale`
inglês do date-fns.

Nada muda para quem usa português ou espanhol. Texto que vem do banco (nome de
funil, etapa, mensagem) continua como foi cadastrado.

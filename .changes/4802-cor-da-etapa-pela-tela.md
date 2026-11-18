---
impacto: capacidade_nova
secao: adicionado
titulo: A cor de cada etapa do funil passa a se escolher na tela, com a paleta do produto e um botão «Padrão»
---

A cor da etapa existia no banco desde o começo e o quadro Kanban já a pintava,
mas nenhuma tela sabia gravá-la: para mudar o tom de uma coluna era preciso
exportar os funis, editar o arquivo e importar de novo. Agora cada etapa tem um
seletor de cor em **Configurações › Etapas do funil**, ao lado da janela de
esfriando, mostrando o tom atual pelo nome.

A paleta é a mesma das etiquetas — oito tons medidos em #1271/#2373, com nome
porque escolher por «Âmbar» chega ao mesmo lugar que escolher pelo círculo e o
leitor de tela anuncia o tom. O popover traz uma prévia com o nome da etapa sobre
o tom escolhido, e a frente do texto (preto ou branco) é calculada pela régua de
contraste do produto, nunca fixa.

**«Padrão» volta ao que é hoje**: a etapa sem cor, que o quadro desenha com o
ponto neutro. A gravação vai pelo mesmo `PATCH` de etapa que já existia — o mesmo
caminho do import/export, com a mesma auditoria dos outros campos —, então não há
duas verdades sobre a cor de uma etapa. O Kanban relê sozinho ao salvar.

Ficaram fora, como fatias separadas da mesma issue: arrastar para reordenar as
etapas, transferir negócios ao arquivar ou excluir um funil, relatórios de
faturamento por funil e etapa, e a exportação dos relatórios de vendas.

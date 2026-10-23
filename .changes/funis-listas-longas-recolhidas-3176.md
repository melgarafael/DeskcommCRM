---
impacto: capacidade_nova
secao: corrigido
titulo: Configurações › Funis abre rápido com listas longas, e a lista agora exporta CSV
---
A tela Configurações › Funis travava quando um campo de lista tinha centenas de opções, porque ela montava de uma vez a lista inteira de todos os campos de todos os funis. Agora as opções de um campo aparecem recolhidas, com a contagem ao lado («756 opções»), e a lista abre só quando você pede — com busca e em páginas de 20. Cada funil tem um botão para montar o editor de vocabulário e campos somente quando você precisar dele; recolher o editor só o esconde, sem perder o que foi editado e ainda não salvo. Junto do Importar CSV, a lista ganhou um Exportar CSV (`value,label,apelidos`), para editar a lista fora do CRM e reimportar. O formato do arquivo de importação, os apelidos e o valor canônico das opções continuam iguais, e nada precisa ser feito na atualização.

Relatado por @aerosuiteapp (#3176).

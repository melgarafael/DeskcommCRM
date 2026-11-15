---
impacto: capacidade_nova
secao: adicionado
titulo: Exportar e importar funis com as etapas, em Configurações › Funis
---

A tela Configurações › Funis ganhou dois botões, para quem é gestor ou administrador: "Exportar funis" baixa um arquivo com os funis ativos e as etapas de cada um, na ordem do quadro, e "Importar funis" aplica esse arquivo nesta ou em outra organização.

Cada funil do arquivo chega como um funil novo, e nada do que já existe é alterado. Se já houver um funil com o mesmo nome e etapas diferentes, o importado entra como cópia ("Vendas (importado)"). Aplicar o mesmo arquivo de novo não duplica: o funil que já está lá com as mesmas etapas fica como está, e a tela diz quantos foram pulados.

O arquivo leva o nome e a descrição do funil e, de cada etapa, o nome, a cor e a marca de ganho ou de perda. Vocabulário, campos personalizados e os ajustes finos das etapas não viajam. O limite é de 200 funis por arquivo e 200 etapas por funil. Exportar e importar ficam registrados na auditoria, só com a contagem.

Crédito: @webtecnica, que escreveu as rotas e o formato do arquivo (#4283), e @aleflores35, que trouxe o caso de uso (#1995).

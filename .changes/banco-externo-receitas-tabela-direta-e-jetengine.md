---
impacto: capacidade_nova
secao: adicionado
titulo: Receitas prontas do banco externo: tabela direta e JetEngine imóveis (R3)
---

Duas novas receitas prontas no conector de Dados externos (módulo `banco_externo`, desligado por padrão):

1. **tabela-direta**: lê qualquer tabela plana do banco externo, onde cada coluna é um dado (ex.: carros: id, modelo, ano, preco, cor, foto). O admin escolhe a tabela e diz qual coluna é cada dado (id, título, preço, filtros de texto, filtro numérico, colunas a exibir, status). Suporta busca por texto, preço mínimo/máximo, filtro numérico mínimo/máximo e filtro de status.

2. **jetengine-imoveis**: lê imóveis de um tipo de conteúdo (CCT) do JetEngine. O admin informa o prefixo e o slug do CCT (a tabela é `<prefixo>jet_cct_<slug>`). Só imóveis publicados (`cct_status = 'publish'`). Suporta busca por bairro, quartos mínimos, preço máximo, cidade e limite.

Ambas as receitas validam identificadores (tabela e colunas) via regex e quotagem com crase, nunca concatenação bruta. Valores usam placeholders `?`. A execução confere que cada coluna usada está nas fontes liberadas da conexão.

O DDL das colunas do JetEngine é inferido da documentação 3.x; a medição contra uma instalação real (C1 JetEngine) está pendente e é pré-requisito para liberar a receita a cliente.

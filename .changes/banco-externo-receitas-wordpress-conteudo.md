---
impacto: capacidade_nova
secao: adicionado
titulo: O agente consulta o conteúdo de um site WordPress de qualquer nicho pelo banco externo
---

Em Integração de dados, uma conexão MySQL com um site WordPress ganha a receita pronta "Conteúdo do WordPress (qualquer tipo de post)". Serve para imóveis, veículos, cursos, eventos, cardápio — o que o site publica no tipo de post que ele quiser. O site pode usar o plugin ACF ou o JetEngine no modo padrão: os dois gravam os dados do mesmo jeito, e a mesma receita lê os dois.

O administrador diz o tipo de post, mapeia os campos que o site guarda (o nome do campo no site, o tipo — texto, número ou preço — e se o cliente pode filtrar por ele) e mapeia as categorias do WordPress (a taxonomia, o nível na hierarquia e se o filtro é por pedaço do texto ou por igualdade). O que fica de fora também se aponta: o campo e os valores que somem (por exemplo, o conteúdo vendido).

Para quem não quer mapear tudo à mão, a tela oferece começar de um modelo: "Imóveis" já vem com código, preço de venda, aluguel, condomínio, quartos, suítes, banheiros, vagas e área, mais bairro, cidade, tipo e finalidade, e com o campo que esconde o imóvel vendido. É só um atalho que preenche a tela — os nomes dos campos e das categorias são só sugestão, e o administrador ajusta o que o site dele usa. O modelo "Em branco" começa do zero.

A busca do cliente vira filtro na consulta: "carros da fiat a partir de 2020, até 60 mil quilômetros, a até 90 mil" vira o filtro de marca, o de ano, o de quilometragem e o de preço. Quando o dado pedido não existe na configuração, o assistente recebe um erro que diz quais filtros existem naquela receita — em vez de devolver a lista inteira como se o filtro tivesse sido aplicado.

Nada precisa ser feito ao atualizar: a receita só entra em quem adicioná-la à conexão, e o que já estava configurado continua como estava. Fica desligada até alguém adicioná-la; nada muda para quem não usa o banco externo.

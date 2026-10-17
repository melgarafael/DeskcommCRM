---
impacto: capacidade_nova
secao: adicionado
titulo: Receitas prontas do banco externo: imóveis WordPress com ACF (R2)
---

Nova receita pronta `acf-imoveis` no conector de Dados externos (módulo `banco_externo`, desligado por padrão): lê imóveis publicados de um WordPress com ACF (título, preço, quartos, bairro e opcionalmente cidade, área, finalidade) a partir de um prefixo de tabela e de meta_keys mapeadas pelo administrador na tela.

O que o operador vê:

- Na tela de uma conexão MySQL (`/app/integracao-dados/[id]`), ao escolher a receita `acf-imoveis`, aparecem os campos "Tipo de post" e o mapeamento de cada dado (Preço, Quartos, Bairro, Cidade, Área) como meta_key do WordPress/ACF.
- Um botão "Sugerir campos" consulta o banco de origem e preenche os meta_key mais frequentes daquele tipo de post, sem sobrescrever o que o administrador já digitou.
- Sem taxonomia nesta fatia: o bairro vem de um campo ACF; busca por taxonomia (wp_terms etc.) fica para uma fatia seguinte.

O que o agente vê:

- A ferramenta `crm_consultar_receita` lista e executa a instância `acf-imoveis`, validando os parâmetros de busca pelo Zod da receita (bairro, quartos_min, preco_max, cidade, limite).

Não muda nada para quem não ligar o módulo `banco_externo` nem não cadastrar uma conexão MySQL com esta receita.

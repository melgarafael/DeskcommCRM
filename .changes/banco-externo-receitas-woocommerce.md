---
impacto: capacidade_nova
secao: adicionado
titulo: Receitas prontas do banco externo: WooCommerce + instâncias + ferramenta do agente
---

Nova capacidade do conector de Dados externos (módulo `banco_externo`, desligado por padrão): agora dá para cadastrar instâncias de receitas prontas numa conexão MySQL e o agente pode consultá-las pelo WhatsApp sem escrever SQL.

Na primeira fatia (R1) vem a receita `woocommerce-produtos`: lê os produtos publicados de uma loja WordPress/WooCommerce (título, preço, SKU, estoque) a partir de um prefixo de tabela (padrão `wp_`), com busca por título/SKU, preço máximo, só-em-estoque e limite de até 5 itens.

O que o operador vê:
- Na tela de uma conexão MySQL (`/app/integracao-dados/[id]`), uma nova seção "Receitas prontas" onde o administrador escolhe a receita, preenche o prefixo, dá um rótulo e descrição, liga/desliga e salva. Só o administrador grava; os demais veem só leitura.
- Um botão "Pré-visualizar" mostra até 5 linhas do resultado (sem SQL à vista). Se o banco de origem não responder, aparece uma mensagem legível em vez de quebrar a tela.

O que o agente vê:
- Uma nova ferramenta `crm_consultar_receita` que lista as receitas ativas da conexão e executa uma delas com os parâmetros de busca da conversa. O resultado nunca entra no rastro com os valores das linhas — só contagem de linhas, colunas e se foi truncado (regra de escopo da D8).

Não muda nada para quem não ligar o módulo `banco_externo` nem não cadastrar uma conexão MySQL com receitas.

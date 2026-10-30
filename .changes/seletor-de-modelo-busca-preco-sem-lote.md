---
impacto: capacidade_nova
secao: corrigido
titulo: "Seletor de modelo do agente: busca, custo por milhão de tokens e sem as variantes em lote que davam erro"
---

O seletor de modelo do agente (IA › Agentes › Modelo) agora tem um campo de busca que filtra pelo nome ou pelo identificador, e um ícone de cifrão em cada modelo: ao passar o cursor, mostra o custo de entrada e de saída por 1 milhão de tokens, em dólares. Preço que o catálogo não informa aparece como "não informado", nunca como grátis. As variantes `:batch` da OpenRouter deixaram de ser oferecidas: elas só funcionam em processamento em lote, e escolhê-las fazia o teste e o atendimento falharem com um aviso de chave ou modelo inválido, mesmo com a chave correta. Um agente que já tinha salvo uma variante em lote continua mostrando o modelo e avisa por que ele não responde. Nada muda na VPS.

Crédito: @Hefesto25.

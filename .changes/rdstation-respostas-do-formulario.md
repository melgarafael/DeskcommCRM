---
impacto: capacidade_nova
secao: corrigido
titulo: As respostas do formulário do RD Station chegam ao card do lead
---
Quando o lead vinha pelo webhook do RD Station, o card nascia só com nome, telefone, e-mail e os dados de origem do RD: as respostas do formulário (por exemplo, orçamento, cidade preferida ou o aceite da política de privacidade) ficavam pelo caminho. Agora elas entram no card como entrariam num envio comum para a mesma fonte, respeitando o mapeamento de campos e os tipos das perguntas configuradas (moeda e número). As informações técnicas que o RD manda junto — token, rastreio de tráfego, navegador, identificador da conversão — continuam fora do card. Nada muda nos formulários de outras origens.

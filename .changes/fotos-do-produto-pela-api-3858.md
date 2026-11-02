---
impacto: capacidade_nova
secao: adicionado
titulo: A API de produto aceita fotos por URL — o servidor baixa, guarda e a URL deixa de ser a fonte
---

Quem integra o catálogo por fora (n8n, script, sistema de estoque da loja) podia mandar
nome, preço e código do produto, mas não a foto: o campo era descartado em silêncio e o
cadastro voltava com sucesso, sem imagem. A foto só entrava uma a uma pela tela — num
estoque de revenda, centenas de envios manuais.

Agora `POST /api/v1/products` e `PATCH /api/v1/products/:id` aceitam `fotos`, uma lista de
até 5 endereços `http(s)` na ordem em que devem aparecer, sendo a primeira a capa. O
servidor baixa cada arquivo, confere que é mesmo JPG ou PNG pelo conteúdo, guarda no
armazenamento do sistema e grava o produto apontando para o arquivo. O endereço de origem
deixa de ser necessário: se o site da loja sair do ar ou o anúncio for vendido, a foto
continua no catálogo e o agente continua conseguindo enviá-la na conversa.

Se algo na lista não puder ser usado — mais de 5 fotos, um endereço que não é `http(s)`,
um link que não abre, um arquivo acima de 5 MB ou que não é JPG/PNG — o cadastro inteiro é
recusado com a explicação do item, em vez de entrar pela metade com a capa errada. No
PATCH, a lista enviada **substitui** as fotos do produto (as que saíram deixam de existir),
enquanto um PATCH que não menciona `fotos` continua sem tocar nelas.

Não há nada a fazer em quem já usa o sistema: o campo é opcional, nenhuma migração é
necessária e o cadastro pela tela continua igual.

Contribuição de @webtecnica (#3858).

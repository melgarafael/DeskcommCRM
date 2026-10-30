---
impacto: capacidade_nova
secao: adicionado
titulo: O contato pessoa física passa a ter endereço (CEP, rua, número, bairro, cidade, UF) na ficha
---

Até aqui só a empresa tinha endereço; quem vendia para pessoa física e precisava entregar ou cobrar guardava a rua em campo personalizado ou fora do CRM. Agora o diálogo de edição do contato tem CEP, UF, logradouro, número, complemento, bairro e cidade, e a ficha mostra o endereço numa linha quando ele existe. A API de contatos aceita os mesmos campos no POST e no PATCH (`zip_code`, `street`, `number`, `complement`, `district`, `city`, `state`).

Todos os campos são opcionais: contato sem endereço segue como estava, e a ficha não mostra o bloco. A anonimização (LGPD) apaga o endereço junto com nome, e-mail e telefone, e o relatório de acesso do titular passa a trazê-lo.

Nada muda para quem opera a VPS: as colunas entram pela atualização normal, sem edição de arquivo. A busca pelo CEP e o endereço na exportação de contatos ficam para depois. Crédito: @webtecnica.

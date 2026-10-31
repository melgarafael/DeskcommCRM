---
impacto: exige_acao
secao: corrigido
titulo: Campos de seleção passam a gravar a opção do funil, não o texto cru
---

Um funil com a opção "São Paulo" (valor `sp`) nascia com `estado: "sao paulo"` quando o negócio entrava pela API, pelo agente de IA ou por um formulário de captação: a ficha não reconhecia o texto como nenhuma opção e mostrava o campo vazio. Filtros, relatórios e mensagens com `{{estado}}` passavam a somar uma grafia por formulário.

A régua que já existia na ficha passou a valer nas três portas de escrita do servidor. Ela ignora maiúscula, acento e espaço, casa por valor, rótulo ou apelido, e grava sempre o valor da opção — `sao paulo`, `SÃO PAULO` e `SP` chegam ao banco como `sp`. Numa seleção múltipla, `casa, apartamento` vira a lista das duas opções, e um rótulo que já contém vírgula ("Rio de Janeiro, RJ") não é partido ao meio.

O que não está na lista tem dois destinos, de propósito: na API e nas ferramentas do agente a escrita é recusada com o motivo, e nada é gravado; na captação por formulário o valor entra como veio, porque recusar perderia o contato que a empresa pagou para receber. A limpeza de um campo continua livre, e campo sem opções cadastradas segue aceitando qualquer valor.

Nenhum dado já gravado é convertido: quem tem o texto fora da lista continua com ele, e a edição só julga o que mudou.

Contribuição de @webtecnica (#3508).

## Requer atenção

Se uma integração sua (pela API) ou o agente de IA grava num campo do tipo "Lista de uma escolha", "Lista de várias escolhas" ou "Lista pesquisável" (sem "permitir valor novo") um valor que não está entre as opções cadastradas no funil, essa escrita passa a ser recusada com o erro `custom_field_value_not_in_list`, e nada é gravado. Antes de atualizar, cadastre no funil as opções que faltam ou ajuste a integração.

O valor que casa com uma opção é gravado pelo valor dela (`sp`, não `São Paulo`): se a sua integração lê o campo de volta esperando o texto que enviou, ela passa a receber o valor da opção. Numa lista de várias escolhas, o texto `casa, apartamento` passa a ser gravado como lista (`["casa","apto"]`).

Formulários de captação não são recusados: o valor fora da lista entra como veio.

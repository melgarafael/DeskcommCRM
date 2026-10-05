---
impacto: nada_mudou
secao: corrigido
titulo: A transferência de funil pergunta a régua da etapa de perda da origem antes de criar o clone
---

A troca de funil (`transfereParaOFunil`, usada pela automação `create_or_move_lead` e pelo roteador de intenção) criava o clone no funil de destino e só depois encerrava a origem — e a exigência de campos da etapa de perda mora dentro do encerramento. Quando a etapa de perda da ORIGEM tinha `obrigatorio_em` (`ao_perder` ou `etapas`) apontando um campo que o negócio não tinha, a recusa `required_fields_missing` nascia depois do clone gravado: o cliente ficava com dois negócios abertos, um em cada funil, com a recusa dizendo que nada mudou.

A régua agora é conferida antes da primeira escrita, com a mesma função de sempre (`validaCamposExigidos`) e o mesmo 422 com `details.faltando` — os dois chamadores continuam tratando exatamente o mesmo código, e quando a régua recusa nenhum negócio novo é gravado.

Nada muda para quem não configurou `obrigatorio_em` no funil da origem: a regra continua opt-in, e uma leitura indisponível das configurações deixa a transferência acontecer como antes.

Contribuição de @webtecnica (#2308).

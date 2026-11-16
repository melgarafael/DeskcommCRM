---
impacto: capacidade_nova
secao: adicionado
titulo: Com o módulo "Empresas e pessoas" ligado, a empresa prospectada no Google nasce como Empresa, com o contato ligado a ela
---

Com o módulo "Empresas e pessoas" ligado, cada negócio que a prospecção do Google aborda passa a existir também como **Empresa** do módulo: nome, telefone, e-mail, site, link do Maps e o `place_id` do Google. Dois candidatos do mesmo negócio, na mesma organização, caem na mesma Empresa — a deduplicação é pelo `place_id`, a primeira chave por negócio que o módulo tem (até hoje ele só comparava CNPJ). O contato que a prospecção cria nasce ligado a essa Empresa, porque o telefone do Google é o da recepção, não de uma pessoa: a ficha do contato mostra a empresa, e não é criada nenhuma pessoa "Recepção". Nota, número de avaliações e categoria continuam na prospecção, porque mudam com o tempo. A ligação é recusada se a Empresa for de outra organização, e o expurgo da prospecção depois de 365 dias não leva junto a Empresa nem o que ela guarda.

Com o módulo **desligado**, nada muda: a prospecção segue criando contato, negócio e conversa como hoje, e nenhuma linha é escrita em Empresas.

---
impacto: capacidade_nova
secao: adicionado
titulo: Com o módulo "Empresas e pessoas" ligado, a empresa prospectada no Google nasce como Empresa, com o contato ligado a ela
---

Com o módulo "Empresas e pessoas" ligado, cada negócio que a prospecção do Google aborda passa a existir também como **Empresa** do módulo, com nome, telefone e e-mail. Dois candidatos do mesmo negócio, na mesma organização, caem na mesma Empresa: a deduplicação é pelo `place_id` do Google, a primeira chave por negócio que o módulo tem (até hoje ele só comparava CNPJ). O banco também guarda na Empresa o site, o link do Maps e o `place_id`, e liga a ela o contato que a prospecção cria, porque o telefone do Google é o da recepção (não é criada nenhuma pessoa "Recepção"). As telas ainda não mostram esses campos nem esse vínculo. Nota, número de avaliações e categoria continuam na prospecção, porque mudam com o tempo. A ligação é recusada se a Empresa for de outra organização, e o expurgo da prospecção depois de 365 dias não leva junto a Empresa nem o que ela guarda.

Com o módulo **desligado**, nada muda: a prospecção segue criando contato, negócio e conversa como hoje, e nenhuma linha é escrita em Empresas.

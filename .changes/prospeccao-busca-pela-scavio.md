---
impacto: capacidade_nova
secao: adicionado
titulo: A prospecção pode buscar empresas do Google Maps pela API da Scavio
---

Quem tem conta na Scavio agora pode apontar a busca da prospecção para ela, sem depender da Apify. São dois passos: a organização escolhe `scavio` em `organizations.settings.prospecting.provider` (ainda por SQL, sem tela) e salva a chave da Scavio no mesmo campo de chave da tela de prospecção. A chave é conferida sem gastar crédito e fica cifrada como a da Apify. A busca devolve até 20 empresas por página e as empresas entram na campanha pelo mesmo caminho de sempre, com avaliação de site e prévia. O passo a passo está em `docs/features/prospeccao-nativa.md`.

Nada muda para quem não escolheu: a Apify continua sendo o provedor padrão, e nenhuma variável nova é necessária na VPS.

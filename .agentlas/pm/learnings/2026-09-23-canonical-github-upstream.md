# GitHub oficial como fonte canônica

- O checkout de contribuição usa `origin=https://github.com/saraivabr/DeskcommCRM.git` apenas para publicar branches e `upstream=https://github.com/melgarafael/DeskcommCRM.git` como fonte canônica.
- O remote Git direto da VM de produção foi removido do checkout para impedir que a VM continue funcionando como repositório de origem.
- A consolidação histórica da Saraiva.AI foi publicada no PR `melgarafael/DeskcommCRM#1544`, branch `feat/saraiva-ai-consolidacao`, preservando 72 commits até `64dddfcd0`.
- O pré-voo mediu 2.400 commits de atraso e um merge de ensaio encontrou 58 conflitos; a reconciliação precisa preservar os commits e usar edição por mantenedores, sem rebase ou force-push.

---
impacto: nada_mudou
secao: corrigido
titulo: Duas atualizações não rodam mais ao mesmo tempo — o update.sh do terminal passou a respeitar o cadeado que o botão do painel já usava
---

Atualizar pelo botão "Atualizar agora" e, ao mesmo tempo, rodar `bash hostgator-setup-kit/update.sh` no terminal deixava as duas execuções aplicarem o `supabase/baseline.sql` no mesmo banco em paralelo. Como o baseline é DDL, uma aplicação derrubava o que a outra acabara de criar, e o banco terminava sem a regra — sem erro na tela. Foi o par `cannot change name of input parameter` do incidente 1.118 → 1.119, medido em duas aplicações defasadas em 2,75–3,5 s.

O `agent.sh` já segurava o `.update.lock`; o `update.sh` rodado pelo terminal não tomava cadeado nenhum. Agora ele toma: a ordem passou a ser cadeado → backup → código → banco, e quem chega depois **sai sem fazer nada** e diz por quê — "já há uma atualização em andamento pelo painel", com o caminho do log para acompanhar. Nada é parado, nenhum código é baixado, o backup e o banco não são tocados, e a saída é limpa.

O botão continua funcionando igual: ele chama o `update.sh` já segurando o cadeado, e o `update.sh` reconhece a trava herdada em vez de tentar tomá-la de novo (que faria o botão travar contra si mesmo). Nada a fazer na atualização. (#5052)

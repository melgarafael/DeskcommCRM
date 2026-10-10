---
impacto: capacidade_nova
secao: corrigido
titulo: Worker de IA parado deixa de responder "saudável" em silêncio
---

O processamento que transforma as mensagens recebidas em respostas da IA roda num laço dentro do serviço do worker. Se uma consulta ao banco travasse no meio de uma volta, o laço parava — as mensagens continuavam chegando, mas nenhuma resposta era enfileirada — e o healthz do serviço continuava respondendo "ok": foi assim que uma instalação real ficou dois dias sem a IA responder, com o aviso verde. Agora o worker carimba cada volta concluída, o healthz responde não saudável quando esse carimbo passa de cinco minutos, e a Central da equipe abre um aviso quando o laço fica parado (o aviso é gravado no mesmo banco, então depende de ele ainda atender). O aviso se resolve sozinho quando o processamento volta.

Você não precisa fazer nada. Quem acompanha o `docker compose ps` pode ver o worker como `unhealthy` enquanto o laço estiver parado; isso não reinicia o worker nem reverte uma atualização. O `/healthz` do worker ganhou o campo `ia_drain`.

Contribuição de @Tong-bit-art (#2691), a partir da issue #2505.

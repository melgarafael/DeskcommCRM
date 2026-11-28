---
impacto: nada_mudou
secao: corrigido
titulo: Reenviar a criação de um lead não cria mais um cartão duplicado
---

O "Novo Lead" e qualquer integração que criem negócio pela API agora honram o cabeçalho `Idempotency-Key`: a retentativa de rede ou o duplo clique que chegam com a mesma chave devolvem o MESMO negócio, em vez de abrir um segundo cartão para o mesmo contato no mesmo funil. Quem não manda o cabeçalho continua criando como antes. Nada a fazer na atualização.

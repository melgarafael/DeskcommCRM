---
impacto: capacidade_nova
secao: adicionado
titulo: Supabase próprio no mesmo servidor sobrevive às atualizações
---
Quem roda o Supabase no mesmo servidor do CRM, em outro compose, perdia a conexão com o banco a cada atualização: os contêineres eram recriados fora da rede do Supabase e o worker caía, o que podia até desfazer a atualização. Agora basta declarar `SUPABASE_DOCKER_NETWORK` (por exemplo `supabase_default`) no `.env` e o kit liga o CRM a essa rede em toda subida e atualização. Sem a variável, nada muda.

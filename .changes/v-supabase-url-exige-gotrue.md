---
impacto: nada_mudou
secao: corrigido
titulo: O instalador só aceita o endereço do Supabase quando quem responde é o Supabase
---

Ao conferir o endereço do Supabase, o instalador aceitava qualquer servidor que
respondesse. Numa VPS com o Coolify, o endereço do painel do Coolify teria sido
aceito como se fosse o Supabase. Agora ele exige a resposta do serviço de login
do Supabase e, se for outro servidor, avisa na hora qual endereço respondeu e
pede para conferir o endereço e a porta. O Supabase na nuvem e o Supabase que o
próprio kit instala na VPS continuam passando (conferido nos dois); não é preciso
fazer nada.

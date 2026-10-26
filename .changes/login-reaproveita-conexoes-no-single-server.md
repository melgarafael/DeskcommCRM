---
impacto: nada_mudou
secao: corrigido
titulo: Na instalação com o Supabase na mesma VPS, o login deixa de abrir uma conexão nova com o banco a cada consulta
---

O serviço de login do Supabase que vem pinado no instalador abre uma conexão nova com o banco a cada consulta quando o tamanho do pool não está configurado, e o compose oficial não o configura. Como o CRM confere o login duas a três vezes por tela, isso aparecia como espera em cada clique: numa instalação medida, a conferência do login levava de 74 a 185 ms na mediana e chegava a 1,6 s, e passou a 4 ms na mediana com o pool. Agora o serviço guarda até 10 conexões ociosas por 5 minutos, sem limite de conexões abertas. Quem instala ou atualiza recebe a mudança sozinho; para outro valor, defina `GOTRUE_DB_MAX_IDLE_POOL_SIZE` no `.env` do Supabase.

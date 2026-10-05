# O próximo passo da demanda nova no idioma de quem lê — prova em tela do PR #2040

Capturas de @jmpo, lastro da afirmação do PR #2040: o próximo passo que `fn_service_inbound` grava na demanda nova ("Responder à nova mensagem do cliente") aparece no idioma de quem lê, e o próximo passo escrito por uma pessoa sai como ela escreveu. Build de produção (`next build` + `next start`), Supabase local com o `baseline.sql` aplicado do zero, envs opcionais ausentes.

- `antes-painel-es-upstream-main.png` — antes, na `main`: usuário em espanhol, painel "Casos abiertos" mostrando o texto em português.
- `depois-01-painel-es.png` — depois: o mesmo painel em espanhol, "Responder al nuevo mensaje del cliente".
- `depois-01b-demandas-es.png` — a seção de demandas inteira, em espanhol.
- `depois-02-demandas-pt.png` — o mesmo painel com o usuário em português: o texto de sempre.
- `depois-03-escrito-por-pessoa.png` — próximo passo escrito por uma pessoa, usuário em espanhol: sai como foi escrito.

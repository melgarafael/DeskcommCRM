# Curso: aulas de "Ver tudo em CRM" e "Ver tudo em IA" e recaptura completa

**Data:** 01/11/2026 · **App fotografado:** `f13d26f6b00d65730f101e92fac50e3205b97211` (1.94.0 + 16 commits), `next start` com o build E2E

## O que foi feito

- 23 módulos novos, um por tela dos dois hubs, escritos por um agente e revisados por outro que
  conferiu cada frase contra o código e cada destaque contra a foto.
- Recaptura completa do curso nos dois idiomas, na bancada fresca (baseline + bootstrap-owner +
  base da Clínica Bem Viver, worker e scheduler parados): 84 módulos e 30 jornadas, 1.660 fotos em
  PT e 1.660 em ES. Nenhuma foto foi reaproveitada: todas têm versão 1.94.0 e o commit acima.
- Falhas da recaptura corrigidas na causa e recapturadas: Agenda (passo que nunca cabia na foto),
  Comandas e uma jornada (linhas de sementes antigas que vazavam), Inbox/Contatos/Extensões em ES
  (palavra solta no catálogo ES global), Webhooks em ES (trecho curto de alvo traduzido).

## Conferência pela tela (deskcomm-site em `next start`, Playwright)

| Medida | PT | EN | ES |
|---|---:|---:|---:|
| Lições novas abertas | 87 | 87 | 87 |
| Fotos quebradas | 0 | 0 | 0 |
| Foto do idioma errado | 0 | 0 | 0 |
| Lição sem anotação desenhada | 0 | 0 | 0 |
| Passos com o texto PT no lugar da tradução | — | 0 de 442 | 0 de 442 |
| Erros no console | 0 | 0 | 0 |
| Rolagem horizontal no celular (390 px) | não | não | não |

O simulador da lição "Conhecendo a tela de Produtos" foi percorrido clicando no alvo de cada
passo até "lição concluída", nos três idiomas. As capturas desta pasta são do site montado:
`*-licao-uso-e-orcamento.png` (leitura), `*-simulador-produtos.png` (fim do simulador),
`*-modulo-campanhas.png` (página do módulo), `*-jornadas.png` (Deskcomm em ação) e
`*-celular-produtos.png` (celular).

## O que não foi medido

- O deploy do site: a publicação acontece no merge do PR do `deskcomm-site`, e o recibo
  `curso/publicacao.json` só avança depois de conferir o site publicado.
- O curso em inglês não tem fotos próprias: usa as fotos em português, com o aviso no topo.

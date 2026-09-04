/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    // Tailwind v4: um plugin só. O `autoprefixer` saiu porque o v4 já faz o
    // prefixo por dentro (Lightning CSS) — mantê-lo aqui é trabalho repetido
    // sobre um CSS que já veio prefixado.
    "@tailwindcss/postcss": {},
  },
};

export default config;

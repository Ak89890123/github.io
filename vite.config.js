const pagesBase = '/github.io/';

export default ({ command }) => ({
  base: command === 'build' ? pagesBase : '/',
  plugins: command === 'build'
    ? [{
        name: 'github-pages-public-paths',
        enforce: 'pre',
        transform(code, id) {
          const cleanId = id.split('?')[0];
          if (!cleanId.includes('/src/') || !/\.(?:js|json)$/.test(cleanId) || !code.includes('/assets/')) return null;
          return code.replaceAll('/assets/', `${pagesBase}assets/`);
        },
      }]
    : [],
  build: {
    chunkSizeWarningLimit: 550,
  },
});

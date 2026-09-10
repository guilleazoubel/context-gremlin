const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['out/**', 'engine/**', 'node_modules/**', 'eslint.config.js'],
  },
  {
    // The stand-in for the engine bundle is, like the real one, a CommonJS artifact rather than a
    // source file: it is `require`d by absolute path at runtime and never compiled.
    files: ['test/support/fake-extension/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable' } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
);

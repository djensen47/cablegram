import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

// Boundary enforcement (ADR-005). The element map + rules below ARE the encoded
// architecture: shared modules can't import domain components, and every
// cross-element import must go through a component's `index.ts` facade.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/**/*'],
      'boundaries/elements': [
        // Entrypoints / app assembly: src/app.ts, src/server.ts, src/function.ts
        { type: 'app', mode: 'file', pattern: 'src/*.ts' },
        // Shared technical modules: src/shared/<module>/**
        { type: 'shared', mode: 'folder', pattern: 'src/shared/*', capture: ['module'] },
        // Domain components: src/<component>/**
        { type: 'component', mode: 'folder', pattern: 'src/*', capture: ['component'] },
      ],
    },
    rules: {
      // Dependency direction (ADR-005 rules 3 & 4): shared → shared only (never
      // a component); components → shared + other components; app → anything.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app', allow: ['app', 'shared', 'component'] },
            { from: 'shared', allow: ['shared'] },
            { from: 'component', allow: ['shared', 'component'] },
          ],
        },
      ],
      // Facade-only imports (ADR-005 rule 1): reach a shared module or component
      // only through its index.ts, never its internals.
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          rules: [
            { target: ['shared', 'component'], allow: 'index.ts' },
            { target: ['app'], allow: '**' },
          ],
        },
      ],
    },
  },

  // Tests may reach within their own module freely.
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    rules: {
      'boundaries/entry-point': 'off',
    },
  },
);

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

// Boundary enforcement (ADR-005). The element map + rules below ARE the encoded
// architecture — all four ADR-005 rules:
//   1. Facade-only imports  → `boundaries/entry-point` (index.ts only across a boundary)
//   2. Clean layer direction → `boundaries/element-types` (inward only, per component)
//   3. Cross-component via facades, along the ADR-011 DAG
//   4. shared/* are leaves (one sanctioned exception: the composition root, shared/di)
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      // boundaries resolves imports via eslint-module-utils; the TypeScript
      // resolver is what maps NodeNext `.js` specifiers to their `.ts` files —
      // without it every local import is "unresolved" and the rules below
      // silently never fire (ADR-005 would be cosmetic).
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
      'boundaries/include': ['src/**/*'],
      // Order matters: the FIRST matching element wins, so the most specific
      // patterns (tokens, then the Clean layers) precede the generic component.
      'boundaries/elements': [
        // Entrypoints / app assembly: src/app.ts, src/server.ts, src/function.ts
        { type: 'app', mode: 'file', pattern: 'src/*.ts' },
        // Shared technical modules: src/shared/<module>/**
        { type: 'shared', mode: 'folder', pattern: 'src/shared/*', capture: ['module'] },
        // A component's DI tokens file (pure Symbols; every layer may read it).
        { type: 'tokens', mode: 'file', pattern: 'src/*/types.ts', capture: ['component'] },
        // Clean layers nested inside a component (ADR-001).
        { type: 'domain', mode: 'folder', pattern: 'src/*/domain', capture: ['component'] },
        { type: 'application', mode: 'folder', pattern: 'src/*/application', capture: ['component'] },
        { type: 'infrastructure', mode: 'folder', pattern: 'src/*/infrastructure', capture: ['component'] },
        { type: 'presentation', mode: 'folder', pattern: 'src/*/presentation', capture: ['component'] },
        // The component facade itself (index.ts): src/<component>/**
        { type: 'component', mode: 'folder', pattern: 'src/*', capture: ['component'] },
      ],
    },
    rules: {
      // Dependency direction. `default: disallow` + last-match-wins: every legal
      // edge is named below; anything unnamed is blocked. `${from.component}`
      // pins a layer to its OWN component, so cross-component reach must go
      // through the facade (the `component` element), never a sibling's layer.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // App assembly wires shared modules and component facades together.
            { from: ['app'], allow: ['app', 'shared', 'component'] },

            // ADR-005 #4: shared modules are leaves — shared → shared only...
            { from: ['shared'], allow: ['shared'] },
            // ...with ONE sanctioned exception: the composition root (shared/di)
            // loads each component's ContainerModule (ADR-003).
            { from: [['shared', { module: 'di' }]], allow: ['shared', 'component'] },

            // Clean layer direction (ADR-005 #2), inward only and same-component:
            // domain is pure (shared utils only, e.g. ids).
            { from: ['domain'], allow: ['shared'] },
            {
              from: ['application'],
              allow: [
                ['domain', { component: '${from.component}' }],
                ['tokens', { component: '${from.component}' }],
                'shared',
              ],
            },
            {
              from: ['infrastructure'],
              allow: [
                ['domain', { component: '${from.component}' }],
                ['application', { component: '${from.component}' }],
                ['tokens', { component: '${from.component}' }],
                'shared',
              ],
            },
            {
              from: ['presentation'],
              allow: [
                ['domain', { component: '${from.component}' }],
                ['application', { component: '${from.component}' }],
                ['tokens', { component: '${from.component}' }],
                'shared',
              ],
            },
            // The facade re-exports from its own layers + tokens.
            {
              from: ['component'],
              allow: [
                ['domain', { component: '${from.component}' }],
                ['application', { component: '${from.component}' }],
                ['infrastructure', { component: '${from.component}' }],
                ['presentation', { component: '${from.component}' }],
                ['tokens', { component: '${from.component}' }],
                'shared',
              ],
            },

            // ADR-005 #3 + ADR-011 DAG: cross-component reach, facade-to-facade,
            // only along the allowed edges. A component's outer layers may import
            // another component's `index.ts`; deliverability & templates are leaves.
            {
              from: [
                ['application', { component: 'campaigns' }],
                ['infrastructure', { component: 'campaigns' }],
                ['presentation', { component: 'campaigns' }],
              ],
              allow: [
                ['component', { component: 'newsletters' }],
                ['component', { component: 'subscriptions' }],
                ['component', { component: 'deliverability' }],
                ['component', { component: 'templates' }],
              ],
            },
            {
              from: [
                ['application', { component: 'subscriptions' }],
                ['infrastructure', { component: 'subscriptions' }],
                ['presentation', { component: 'subscriptions' }],
              ],
              allow: [['component', { component: 'newsletters' }]],
            },
            {
              from: [
                ['application', { component: 'newsletters' }],
                ['infrastructure', { component: 'newsletters' }],
                ['presentation', { component: 'newsletters' }],
              ],
              allow: [['component', { component: 'templates' }]],
            },
          ],
        },
      ],
      // Facade-only imports (ADR-005 #1): reach a shared module or a component
      // only through its index.ts. A component's own layers/tokens are internal
      // files ('**'); element-types above is what stops cross-component reach
      // into them.
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          rules: [
            { target: ['shared', 'component'], allow: 'index.ts' },
            {
              target: ['tokens', 'domain', 'application', 'infrastructure', 'presentation', 'app'],
              allow: '**',
            },
          ],
        },
      ],
    },
  },

  // Tests compose the vertical (app + use cases + in-memory repositories) and
  // reach within modules freely — they are not production dependency edges.
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    rules: {
      'boundaries/element-types': 'off',
      'boundaries/entry-point': 'off',
    },
  },
);

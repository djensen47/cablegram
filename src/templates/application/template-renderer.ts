import type { Template } from '../domain/template.js';

/** The rendered output of a template against a model. */
export interface RenderedTemplate {
  html: string;
  text: string;
}

/**
 * Renders a template's bodies against a merge-field model. Lives in
 * `application/` next to its consumer (ADR-001) — a logic-limited engine is
 * bound behind it in `infrastructure/`; template source is untrusted input,
 * never arbitrary code (chunk decision: no `eval`, no sandboxed-JS engine).
 *
 * Contract every implementation must honor:
 * - **Pure and deterministic**: the same `(template, model)` pair always
 *   yields the same output. No IO, no clock, no randomness.
 * - **Missing variables** referenced by the template but absent from `model`
 *   render as an empty string — they never throw and never leave a literal
 *   placeholder in the output.
 * - **Malformed or unresolvable template source** (syntax the engine can't
 *   parse, or a construct like an unregistered helper invocation) throws
 *   `TemplateCompileError` (domain/errors.ts) — it never executes anything.
 * - **`text`** is `template.bodyText` rendered against `model` when present;
 *   otherwise it's derived from the rendered `html` by stripping markup, so
 *   callers always get a usable plain-text part.
 * - **Output is escaped by default** — a model value is inserted as literal
 *   text, HTML-escaped, so a value like `<script>` cannot inject markup
 *   (verified by the injection/escaping test in the default implementation).
 */
export interface TemplateRenderer {
  render(template: Template, model: Record<string, unknown>): RenderedTemplate;
}

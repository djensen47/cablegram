import { injectable } from 'inversify';
import Handlebars from 'handlebars';
import type { Template } from '../domain/template.js';
import { TemplateCompileError } from '../domain/errors.js';
import type { RenderedTemplate, TemplateRenderer } from '../application/template-renderer.js';
import { htmlToText } from './html-to-text.js';

// An isolated Handlebars environment (chunk decision: Handlebars over Eta —
// it is logic-limited by construction, not just by convention. No custom
// helpers or partials are registered on it, so template source can only
// interpolate variables and use the built-in `if`/`unless`/`each`/`with`
// block helpers; there is no `registerHelper`-free path to running arbitrary
// JS from template source, unlike Eta/EJS-style engines that eval `<% %>`.
const engine = Handlebars.create();

// `Handlebars.compile()` returns a delegate that parses lazily, on its first
// invocation — not at `compile()` time — so syntax/engine errors (malformed
// source, an unresolvable helper invocation) only surface once the template
// is actually called. `renderOne` compiles and invokes together so both
// failure modes are caught in the same place and mapped to one domain error.
function renderOne(source: string, model: Record<string, unknown>, field: 'bodyHtml' | 'bodyText'): string {
  try {
    // Defaults matter here: `noEscape: false` (interpolated values are
    // HTML-escaped — the injection/escaping guarantee) and `strict: false`
    // (a path missing from the model renders as '' instead of throwing —
    // the documented "missing variable" behavior).
    const delegate = engine.compile(source, { noEscape: false, strict: false });
    return delegate(model);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TemplateCompileError(field, reason);
  }
}

/**
 * The default `TemplateRenderer` (application/template-renderer.ts). Pure and
 * deterministic: compiling and rendering touch no IO, clock, or randomness, so
 * the same `(template, model)` always produces the same output.
 */
@injectable()
export class HandlebarsTemplateRenderer implements TemplateRenderer {
  render(template: Template, model: Record<string, unknown>): RenderedTemplate {
    const html = renderOne(template.bodyHtml, model, 'bodyHtml');
    const text =
      template.bodyText !== null ? renderOne(template.bodyText, model, 'bodyText') : htmlToText(html);
    return { html, text };
  }
}

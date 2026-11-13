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

type Program = hbs.AST.Program;
type Statement = hbs.AST.Statement;

/**
 * Block helpers that render their body against the **same** context. A
 * variable inside one still refers to the top-level model, so the pass-through
 * rule applies there too. Every other block (`each`, `with`, an unknown
 * section) changes what a bare name resolves to, so names inside it are left
 * to Handlebars rather than judged against the top-level model.
 */
const SAME_CONTEXT_BLOCKS = new Set(['if', 'unless']);

/**
 * Character offset of each line start, so a node's `loc` (1-based line,
 * 0-based column) can be turned back into the exact source text it came from.
 */
function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/**
 * Pass through every variable the model does not supply (ADR-033).
 *
 * cablegram renders campaign content before the provider sees it, and the
 * provider has template syntax of its own in the same `{{…}}` braces —
 * Postmark's `{{{ pm:unsubscribe }}}`, or a `{{FirstName}}` it fills per
 * recipient. Rendering those against a model that has no such key used to
 * blank them. Now a plain variable reference whose first name is **not** in
 * the model is turned back into literal text, exactly as written (braces,
 * spacing and triple-stash included), and reaches the provider untouched.
 *
 * Deliberately narrow, so Handlebars keeps every guarantee it had:
 *  - only a bare reference (`{{name}}`, `{{name.sub}}`, `{{{ name }}}`) — a
 *    helper call with arguments (`{{fmt date "x"}}`) still goes to Handlebars,
 *    which refuses an unknown helper instead of running anything;
 *  - only at the top level or inside `if`/`unless`, where a name means the
 *    top-level model — inside `each`/`with`/a section, Handlebars resolves it;
 *  - `this`, `@data` and parent (`../`) references are always Handlebars'.
 * A value the model *does* supply renders and is HTML-escaped as before.
 */
function passThroughUnsupplied(source: string, program: Program, model: Record<string, unknown>): void {
  const offsets = lineOffsets(source);
  const sourceOf = (loc: hbs.AST.SourceLocation): string =>
    source.slice(
      offsets[loc.start.line - 1]! + loc.start.column,
      offsets[loc.end.line - 1]! + loc.end.column,
    );

  const isUnsuppliedVariable = (node: hbs.AST.MustacheStatement): boolean => {
    if (node.path.type !== 'PathExpression') return false;
    const path = node.path as hbs.AST.PathExpression;
    if (node.params.length > 0 || (node.hash?.pairs.length ?? 0) > 0) return false;
    if (path.data || path.depth > 0 || path.parts.length === 0) return false;
    return !Object.prototype.hasOwnProperty.call(model, path.parts[0]!);
  };

  const visit = (body: Statement[]): void => {
    for (let i = 0; i < body.length; i += 1) {
      const node = body[i]!;
      if (node.type === 'MustacheStatement') {
        const mustache = node as hbs.AST.MustacheStatement;
        if (isUnsuppliedVariable(mustache)) {
          const text = sourceOf(mustache.loc);
          body[i] = { type: 'ContentStatement', value: text, original: text, loc: mustache.loc } as Statement;
        }
      } else if (node.type === 'BlockStatement') {
        const block = node as hbs.AST.BlockStatement;
        const name = block.path.type === 'PathExpression' ? (block.path as hbs.AST.PathExpression).original : '';
        if (SAME_CONTEXT_BLOCKS.has(name)) {
          if (block.program) visit(block.program.body);
          if (block.inverse) visit(block.inverse.body);
        }
      }
    }
  };

  visit(program.body);
}

// `Handlebars.compile()` returns a delegate that parses lazily, on its first
// invocation — not at `compile()` time — so syntax/engine errors (malformed
// source, an unresolvable helper invocation) only surface once the template
// is actually called. `renderOne` parses, compiles and invokes together so
// every failure mode is caught in the same place and mapped to one domain error.
function renderOne(source: string, model: Record<string, unknown>, field: 'bodyHtml' | 'bodyText'): string {
  try {
    const program = engine.parse(source);
    passThroughUnsupplied(source, program, model);
    // `noEscape: false`: interpolated model values are HTML-escaped — the
    // injection/escaping guarantee. Passed-through variables are not values;
    // they are the author's own source text, emitted verbatim.
    const delegate = engine.compile(program, { noEscape: false, strict: false });
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

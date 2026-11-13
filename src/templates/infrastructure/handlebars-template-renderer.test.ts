import { describe, expect, it } from 'vitest';
import { Template } from '../domain/template.js';
import { TemplateCompileError } from '../domain/errors.js';
import { HandlebarsTemplateRenderer } from './handlebars-template-renderer.js';

function makeTemplate(overrides: {
  bodyHtml?: string;
  bodyText?: string | null;
  subject?: string;
}): Template {
  return Template.create({
    id: 't1',
    name: 'Test template',
    subject: overrides.subject ?? 'Subject',
    bodyHtml: overrides.bodyHtml ?? '<p>Hi {{firstName}}</p>',
    bodyText: overrides.bodyText,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
}

describe('HandlebarsTemplateRenderer', () => {
  const renderer = new HandlebarsTemplateRenderer();

  it('interpolates model values into the html body', () => {
    const template = makeTemplate({ bodyHtml: '<p>Hi {{firstName}}, welcome to {{listName}}.</p>' });
    const { html } = renderer.render(template, { firstName: 'Ada', listName: 'The Dispatch' });
    expect(html).toBe('<p>Hi Ada, welcome to The Dispatch.</p>');
  });

  it('renders bodyText separately when present', () => {
    const template = makeTemplate({
      bodyHtml: '<p>Hi {{firstName}}</p>',
      bodyText: 'Hi {{firstName}}, plain text version.',
    });
    const { text } = renderer.render(template, { firstName: 'Ada' });
    expect(text).toBe('Hi Ada, plain text version.');
  });

  it('derives text from html by stripping tags when bodyText is absent', () => {
    const template = makeTemplate({
      bodyHtml: '<h1>Digest</h1><p>Hi {{firstName}}.</p><p>Second line.</p>',
      bodyText: null,
    });
    const { text } = renderer.render(template, { firstName: 'Ada' });
    expect(text).toBe('Digest\nHi Ada.\nSecond line.');
  });

  describe('passes through variables the model does not supply (ADR-033)', () => {
    it("leaves Postmark's own placeholder exactly as written", () => {
      const source = '<a href="{{{ pm:unsubscribe }}}">Unsubscribe</a>';
      const { html } = renderer.render(makeTemplate({ bodyHtml: source }), {});
      expect(html).toBe(source);
    });

    it('leaves a variable the provider fills, with its spacing, braces and casing', () => {
      const source = '<p>Hi {{ FirstName }}, {{Company.Name}} / {{{RawHtml}}}</p>';
      const { html } = renderer.render(makeTemplate({ bodyHtml: source }), {});
      expect(html).toBe(source);
    });

    it('renders the variables the model supplies, and passes the rest through', () => {
      const template = makeTemplate({ bodyHtml: '<p>Hi {{firstName}}, id={{missing}}.</p>' });
      const { html } = renderer.render(template, { firstName: 'Ada' });
      expect(html).toBe('<p>Hi Ada, id={{missing}}.</p>');
    });

    it('keeps exact positions across lines', () => {
      const source = '<p>one</p>\n<p>{{ A }}</p>\n\n  <p>{{{ pm:unsubscribe }}} {{b}}</p>';
      const { html } = renderer.render(makeTemplate({ bodyHtml: source }), { b: 'B' });
      expect(html).toBe('<p>one</p>\n<p>{{ A }}</p>\n\n  <p>{{{ pm:unsubscribe }}} B</p>');
    });

    it('applies inside if/unless, which keep the top-level context', () => {
      const source = '{{#if show}}<p>{{FirstName}}</p>{{else}}<p>{{Other}}</p>{{/if}}';
      expect(renderer.render(makeTemplate({ bodyHtml: source }), { show: true }).html).toBe(
        '<p>{{FirstName}}</p>',
      );
      expect(renderer.render(makeTemplate({ bodyHtml: source }), { show: false }).html).toBe(
        '<p>{{Other}}</p>',
      );
    });

    it('leaves names inside each/with to Handlebars, where they mean the item', () => {
      const template = makeTemplate({ bodyHtml: '<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>' });
      const { html } = renderer.render(template, { items: [{ name: 'a' }, { name: 'b' }] });
      expect(html).toBe('<ul><li>a</li><li>b</li></ul>');
    });

    it('still escapes a supplied value, while a passed-through name is the author\'s own text', () => {
      const template = makeTemplate({ bodyHtml: '<p>{{name}} {{Unsupplied}}</p>' });
      const { html } = renderer.render(template, { name: '<b>x</b>' });
      expect(html).toBe('<p>&lt;b&gt;x&lt;/b&gt; {{Unsupplied}}</p>');
    });

    it('passes through in a separate text body too', () => {
      const template = makeTemplate({
        bodyHtml: '<p>x</p>',
        bodyText: 'Hi {{FirstName}}. Unsubscribe: {{{ pm:unsubscribe }}}',
      });
      expect(renderer.render(template, {}).text).toBe('Hi {{FirstName}}. Unsubscribe: {{{ pm:unsubscribe }}}');
    });
  });

  it('escapes HTML-significant characters in model values (injection case)', () => {
    const template = makeTemplate({ bodyHtml: '<p>Hi {{firstName}}</p>' });
    const { html } = renderer.render(template, {
      firstName: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes a quote/attribute-breaking injection attempt', () => {
    const template = makeTemplate({ bodyHtml: '<p>{{name}}</p>' });
    const { html } = renderer.render(template, { name: '"><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('cannot execute arbitrary JS from template source (logic-limited engine)', () => {
    const template = makeTemplate({
      bodyHtml: "<p>{{constructor.constructor 'return process.env'}}</p>",
    });
    // No helper by that name is registered on the engine, and Handlebars does
    // not fall back to invoking an arbitrary resolved path as a function —
    // it refuses with "Missing helper" (mapped to `TemplateCompileError`)
    // instead of executing anything. There is no route from template source
    // to running code.
    expect(() => renderer.render(template, {})).toThrow(TemplateCompileError);
  });

  it('is pure and deterministic: same template + model yields the same output every time', () => {
    const template = makeTemplate({ bodyHtml: '<p>Hi {{firstName}}, {{n}}</p>' });
    const model = { firstName: 'Ada', n: 42 };
    const first = renderer.render(template, model);
    const second = renderer.render(template, model);
    expect(second).toEqual(first);
  });

  it('throws TemplateCompileError for malformed html template syntax', () => {
    const template = makeTemplate({ bodyHtml: '<p>{{#if unterminated</p>' });
    expect(() => renderer.render(template, {})).toThrow(TemplateCompileError);
  });

  it('throws TemplateCompileError for malformed text template syntax', () => {
    const template = makeTemplate({
      bodyHtml: '<p>ok</p>',
      bodyText: '{{#each items}}unterminated',
    });
    expect(() => renderer.render(template, {})).toThrow(TemplateCompileError);
  });

  it('supports the built-in block helpers (if/each) without custom registration', () => {
    const template = makeTemplate({
      bodyHtml: '<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>{{#if empty}}none{{/if}}',
    });
    const { html } = renderer.render(template, { items: ['a', 'b'], empty: false });
    expect(html).toBe('<ul><li>a</li><li>b</li></ul>');
  });
});

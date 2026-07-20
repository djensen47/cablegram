import { inject, injectable } from 'inversify';
import {
  GetTemplate,
  Template,
  TEMPLATE_TYPES,
  TemplateError,
  type TemplateRenderer,
} from '../../templates/index.js';
import type { CampaignContentRef } from '../domain/campaign.js';
import { CampaignContentError } from '../domain/errors.js';
import type { MessageRenderer, RenderedCampaignMessage } from '../application/message-renderer.js';

// Transient timestamp for an inline, never-persisted `Template` — rendering is
// pure, so the value is irrelevant (kept off the clock deliberately).
const INLINE_EPOCH = new Date(0);

/**
 * The adapter fulfilling the `MessageRenderer` port over the `templates` facade
 * (ADR-005 #3 + the ADR-011 DAG edge `campaigns → templates`). It resolves the
 * campaign's content — a `templateId` reference (via `GetTemplate`) or an inline
 * body built into a transient `Template` — and renders it with the bound
 * `TemplateRenderer`. Any templates-context failure (missing template,
 * unrenderable/empty source) is translated into a `CampaignContentError` so the
 * send path speaks only its own vocabulary.
 *
 * The subject is taken from the resolved template/inline content verbatim: a
 * broadcast is one shared message, rendered against an empty model, so
 * per-recipient subject merge is intentionally not applied here.
 */
@injectable()
export class FacadeMessageRenderer implements MessageRenderer {
  constructor(
    @inject(TEMPLATE_TYPES.GetTemplate) private readonly getTemplate: GetTemplate,
    @inject(TEMPLATE_TYPES.TemplateRenderer) private readonly renderer: TemplateRenderer,
  ) {}

  async render(
    content: CampaignContentRef,
    model: Record<string, unknown>,
  ): Promise<RenderedCampaignMessage> {
    try {
      const template = await this.resolve(content);
      const rendered = this.renderer.render(template, model);
      return {
        subject: template.subject,
        htmlBody: rendered.html,
        textBody: rendered.text,
      };
    } catch (err) {
      if (err instanceof TemplateError) {
        throw new CampaignContentError(err.message);
      }
      throw err;
    }
  }

  private async resolve(content: CampaignContentRef): Promise<Template> {
    if (content.templateId !== null) {
      return this.getTemplate.execute(content.templateId);
    }
    if (content.subject === null || content.bodyHtml === null) {
      throw new CampaignContentError('campaign has no template reference or inline content');
    }
    return Template.create({
      id: 'inline',
      name: 'inline',
      subject: content.subject,
      bodyHtml: content.bodyHtml,
      bodyText: content.bodyText,
      now: INLINE_EPOCH,
    });
  }
}

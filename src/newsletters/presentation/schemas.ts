import { z } from '@hono/zod-openapi';
import { BadRequestError, listResponseSchema } from '../../shared/http/index.js';
import type { Newsletter } from '../domain/newsletter.js';

/**
 * zod-OpenAPI schemas for the newsletters API. These are the single source of
 * truth for both edge validation (ADR-006) and the generated OpenAPI spec
 * (ADR-004) — the contract is the product. Named via `.openapi(name)` so they
 * surface as reusable `#/components/schemas` entries.
 */

const emailField = z.string().trim().email().max(320);

// Mirrors the domain's loose check: a provider-chosen identifier (for Postmark,
// a message stream ID), so only whitespace and length are refused.
const channelField = z
  .string()
  .trim()
  .regex(/^\S{1,100}$/, 'must be 1-100 characters with no whitespace');

const CAMPAIGN_CHANNEL_DESCRIPTION =
  'The provider channel this newsletter\u2019s campaigns go through (ADR-030). For Postmark, ' +
  'the ID of a Broadcasts-type message stream \u2014 one per newsletter keeps each ' +
  'newsletter\u2019s opt-outs separate.';

const CONFIRMATION_CHANNEL_DESCRIPTION =
  'The provider channel this newsletter\u2019s subscription confirmations go through (ADR-031). ' +
  'For Postmark, the ID of a Transactional-type message stream. Kept apart from the campaign ' +
  'channel because Postmark suppresses per stream: on the campaign stream, someone who once ' +
  'unsubscribed could never receive a re-signup\u2019s confirmation.';

const DOUBLE_OPT_IN_DESCRIPTION =
  'Whether signups to this newsletter must be confirmed by email (ADR-032). `false` \u2014 single ' +
  'opt-in, subscribed immediately \u2014 is the default. A signup request can override it.';

const LEGACY_SENDING_CHANNEL_DESCRIPTION =
  'Deprecated alias for `campaignChannel` (its name in 3.1.0), still accepted. Pass one or the ' +
  'other; passing both with different values is a 400.';

export const NewsletterSchema = z
  .object({
    id: z.string().openapi({ example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33' }),
    name: z.string().openapi({ example: 'The Weekly Dispatch' }),
    fromName: z.string().openapi({ example: 'Dispatch Editors' }),
    fromEmail: z.string().email().openapi({ example: 'editors@dispatch.example' }),
    replyTo: z.string().email().nullable().openapi({ example: 'replies@dispatch.example' }),
    sendingDomain: z.string().nullable().openapi({ example: 'mail.dispatch.example' }),
    dkimIdentifier: z.string().nullable().openapi({ example: 'pm' }),
    campaignChannel: z.string().nullable().openapi({
      description:
        `${CAMPAIGN_CHANNEL_DESCRIPTION} \`null\` only on a newsletter created before the field ` +
        'existed; it cannot send a campaign until one is set.',
      example: 'weekly-dispatch',
    }),
    confirmationChannel: z.string().nullable().openapi({
      description:
        `${CONFIRMATION_CHANNEL_DESCRIPTION} \`null\` on a newsletter created before the field ` +
        'existed; double opt-in signups to it are refused until one is set.',
      example: 'weekly-dispatch-confirmations',
    }),
    doubleOptIn: z.boolean().openapi({ description: DOUBLE_OPT_IN_DESCRIPTION, example: false }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Newsletter');

export const CreateNewsletterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ example: 'The Weekly Dispatch' }),
    fromName: z.string().trim().min(1).max(200).openapi({ example: 'Dispatch Editors' }),
    fromEmail: emailField.openapi({ example: 'editors@dispatch.example' }),
    replyTo: emailField.nullish().openapi({ example: 'replies@dispatch.example' }),
    sendingDomain: z.string().trim().max(253).nullish().openapi({ example: 'mail.dispatch.example' }),
    dkimIdentifier: z.string().trim().max(64).nullish().openapi({ example: 'pm' }),
    // Required — as `campaignChannel`, or its deprecated alias `sendingChannel`.
    // Which one was given is resolved in the handler (`resolveCampaignChannel`),
    // so the schema stays a plain object the OpenAPI generator renders as-is.
    campaignChannel: channelField.optional().openapi({
      description: `${CAMPAIGN_CHANNEL_DESCRIPTION} Required (or \`sendingChannel\`); there is no default.`,
      example: 'weekly-dispatch',
    }),
    sendingChannel: channelField.optional().openapi({
      description: LEGACY_SENDING_CHANNEL_DESCRIPTION,
      deprecated: true,
    }),
    confirmationChannel: channelField.openapi({
      description: `${CONFIRMATION_CHANNEL_DESCRIPTION} Required; there is no default.`,
      example: 'weekly-dispatch-confirmations',
    }),
    doubleOptIn: z.boolean().optional().openapi({ description: DOUBLE_OPT_IN_DESCRIPTION, example: false }),
  })
  .openapi('CreateNewsletter');

export const UpdateNewsletterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    fromName: z.string().trim().min(1).max(200).optional(),
    fromEmail: emailField.optional(),
    replyTo: emailField.nullish(),
    sendingDomain: z.string().trim().max(253).nullish(),
    dkimIdentifier: z.string().trim().max(64).nullish(),
    // Changeable, never clearable: a newsletter without one cannot send.
    campaignChannel: channelField.optional().openapi({
      description: `${CAMPAIGN_CHANNEL_DESCRIPTION} Can be changed but not cleared.`,
      example: 'weekly-dispatch',
    }),
    sendingChannel: channelField.optional().openapi({
      description: LEGACY_SENDING_CHANNEL_DESCRIPTION,
      deprecated: true,
    }),
    confirmationChannel: channelField.optional().openapi({
      description: `${CONFIRMATION_CHANNEL_DESCRIPTION} Can be changed but not cleared.`,
      example: 'weekly-dispatch-confirmations',
    }),
    doubleOptIn: z.boolean().optional().openapi({ description: DOUBLE_OPT_IN_DESCRIPTION, example: false }),
  })
  .openapi('UpdateNewsletter');

export const NewsletterListSchema = listResponseSchema(NewsletterSchema, 'NewsletterList');

export const NewsletterIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '4a7f2c1e-6b1a-4c9d-9f21-2b0e5d8a1c33',
    }),
});

export type NewsletterResponse = z.infer<typeof NewsletterSchema>;

type ChannelAliases = { campaignChannel?: string; sendingChannel?: string };

/**
 * Split a request body into its campaign channel and everything else, accepting
 * the 3.1.0 name `sendingChannel` as well as `campaignChannel` (ADR-031 keeps
 * the old name working). Either is fine; both with different values is
 * ambiguous, so it is refused rather than guessed. `campaignChannel` is
 * `undefined` when neither was given.
 */
export function splitCampaignChannel<T extends ChannelAliases>(
  body: T,
): { campaignChannel: string | undefined; rest: Omit<T, keyof ChannelAliases> } {
  const { campaignChannel, sendingChannel } = body;
  if (campaignChannel !== undefined && sendingChannel !== undefined && campaignChannel !== sendingChannel) {
    throw new BadRequestError(
      'campaignChannel and sendingChannel (its deprecated alias) disagree; pass only campaignChannel',
    );
  }
  const rest: Partial<T> = { ...body };
  delete rest.campaignChannel;
  delete rest.sendingChannel;
  return { campaignChannel: campaignChannel ?? sendingChannel, rest: rest as Omit<T, keyof ChannelAliases> };
}

/** Maps a domain aggregate to its wire DTO — entities are never serialized directly (ADR-004). */
export function toNewsletterResponse(newsletter: Newsletter): NewsletterResponse {
  return {
    id: newsletter.id,
    name: newsletter.name,
    fromName: newsletter.fromName,
    fromEmail: newsletter.fromEmail.value,
    replyTo: newsletter.replyTo?.value ?? null,
    sendingDomain: newsletter.sendingDomain,
    dkimIdentifier: newsletter.dkimIdentifier,
    campaignChannel: newsletter.campaignChannel,
    confirmationChannel: newsletter.confirmationChannel,
    doubleOptIn: newsletter.doubleOptIn,
    createdAt: newsletter.createdAt.toISOString(),
    updatedAt: newsletter.updatedAt.toISOString(),
  };
}

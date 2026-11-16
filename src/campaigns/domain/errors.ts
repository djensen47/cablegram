/**
 * Campaign domain errors. Pure — they carry no HTTP status or framework type
 * (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004). Each is a distinct class so the mapping is a `switch`, not string
 * matching.
 */
export abstract class CampaignError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A campaign field violates an invariant (empty name, missing content source, …). */
export class InvalidCampaignError extends CampaignError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid campaign ${field}: ${reason}`);
  }
}

/** No campaign exists for the given id. */
export class CampaignNotFoundError extends CampaignError {
  constructor(readonly id: string) {
    super(`Campaign not found: ${id}`);
  }
}

/**
 * The newsletter a campaign targets does not exist. Distinct from
 * `CampaignNotFoundError` so the edge can point the 404 at the *newsletter*.
 */
export class CampaignNewsletterNotFoundError extends CampaignError {
  constructor(readonly newsletterId: string) {
    super(`Newsletter not found: ${newsletterId}`);
  }
}

/**
 * The campaign's newsletter has no campaign channel (ADR-030/031) — it was
 * created before the field existed. Raised before anything is written or sent,
 * so the campaign is untouched and can be sent once the newsletter is updated.
 */
export class CampaignChannelMissingError extends CampaignError {
  constructor(readonly newsletterId: string) {
    super(`Newsletter ${newsletterId} has no campaign channel set`);
  }
}

/** A requested state transition is not legal for the campaign's current status. */
export class CampaignStateError extends CampaignError {
  constructor(reason: string) {
    super(`Invalid campaign state transition: ${reason}`);
  }
}

/**
 * The campaign's content could not be resolved/rendered at send time — a
 * missing template reference or unrenderable template source. Raised at the
 * `MessageRenderer` boundary and surfaced as a bad-request at the edge.
 */
export class CampaignContentError extends CampaignError {
  constructor(reason: string) {
    super(`Campaign content could not be rendered: ${reason}`);
  }
}

/** No send record exists for the campaign yet (it has never been sent). */
export class SendNotFoundError extends CampaignError {
  constructor(readonly campaignId: string) {
    super(`No send record for campaign: ${campaignId}`);
  }
}

/**
 * The provider refused the submission, so nothing was sent. The campaign is
 * `failed` and may be sent again once the cause is fixed (ADR-035). `reason` is
 * the provider's own answer — it is what says what to fix.
 */
export class CampaignSendRejectedError extends CampaignError {
  constructor(
    readonly campaignId: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`The provider refused the send for campaign ${campaignId}: ${reason}`, options);
  }
}

/**
 * The submission ended without a definite answer: the provider may or may not
 * hold the broadcast. The campaign stays `sending` and is not retried, because
 * a retry could mail the list twice (ADR-035).
 */
export class CampaignSendOutcomeUnknownError extends CampaignError {
  constructor(
    readonly campaignId: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`The outcome of the send for campaign ${campaignId} is unknown: ${reason}`, options);
  }
}

/**
 * A send was started for this campaign and never confirmed either way: it may
 * still be running, the process may have died, or the provider's answer was
 * lost. Another send must not start until that one is settled (ADR-035).
 */
export class CampaignSendUnresolvedError extends CampaignError {
  constructor(
    readonly campaignId: string,
    readonly startedAt: Date,
  ) {
    super(
      `Campaign ${campaignId} has a send that was started at ${startedAt.toISOString()} ` +
        `and never confirmed`,
    );
  }
}

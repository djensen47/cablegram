/**
 * Campaign domain errors. Pure — they carry no HTTP status or framework type
 * (ADR-001); the presentation layer maps them onto `AppError`s at the edge
 * (ADR-004). Each is a distinct class so the mapping is a `switch`, not string
 * matching.
 */
export abstract class CampaignError extends Error {
  constructor(message: string) {
    super(message);
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
export class SendRecordNotFoundError extends CampaignError {
  constructor(readonly campaignId: string) {
    super(`No send record for campaign: ${campaignId}`);
  }
}

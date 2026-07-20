// Facade for the email module (ADR-002/005): import only from here. This is the
// anti-corruption layer over Postmark (ADR-008) — a shared technical leaf that
// imports no domain component.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
// Tokens are exported *before* the module: `module.js` reaches through the
// Postmark gateway into `shared/di` → the composition root → every component,
// which forms an import cycle back to this facade. Exporting `EMAIL_TYPES`
// first guarantees a consumer that `@inject`s it (e.g. subscriptions) still
// sees a defined token if it is evaluated mid-cycle.
export { EMAIL_TYPES } from './types.js';
export { emailModule } from './module.js';

// The send gateway: interface (inject this) + its two bindings.
export type {
  DeliveryGateway,
  BulkMessage,
  RenderedMessage,
  SenderIdentity,
  EmailRecipient,
  SendAcknowledgment,
} from './delivery-gateway.js';
export { PostmarkDeliveryGateway } from './postmark-delivery-gateway.js';
export { InMemoryDeliveryGateway } from './in-memory-delivery-gateway.js';

// Provider webhook normalization.
export { parseProviderEvent } from './provider-event.js';
export type { DeliveryEvent, DeliveryEventType } from './provider-event.js';

// Gateway failure type.
export { EmailDeliveryError } from './errors.js';

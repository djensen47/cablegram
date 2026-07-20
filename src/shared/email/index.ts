// Facade for the email module (ADR-002/005): import only from here. This is the
// anti-corruption layer over Postmark (ADR-008) — a shared technical leaf that
// imports no domain component.

// DI wiring + tokens (loaded by the composition root; rebindable in tests).
export { emailModule } from './module.js';
export { EMAIL_TYPES } from './types.js';

// The send gateway: interface (inject this) + its two bindings.
export type {
  DeliveryGateway,
  BulkMessage,
  RenderedMessage,
  SenderIdentity,
  EmailRecipient,
  DeliveryResult,
} from './delivery-gateway.js';
export { PostmarkDeliveryGateway } from './postmark-delivery-gateway.js';
export { InMemoryDeliveryGateway } from './in-memory-delivery-gateway.js';

// Provider webhook normalization.
export { parseProviderEvent } from './provider-event.js';
export type { DeliveryEvent, DeliveryEventType } from './provider-event.js';

// Gateway failure type.
export { EmailDeliveryError } from './errors.js';

import { ContainerModule } from 'inversify';
import { EMAIL_TYPES } from './types.js';
import type { DeliveryGateway } from './delivery-gateway.js';
import { PostmarkDeliveryGateway } from './postmark-delivery-gateway.js';

/**
 * The email module's DI wiring (ADR-003), loaded by the composition root. The
 * canonical gateway is Postmark-backed here; tests rebind
 * `EMAIL_TYPES.DeliveryGateway` to `InMemoryDeliveryGateway`. Interfaces only
 * are injected — never a concrete class.
 */
export const emailModule = new ContainerModule((bind) => {
  bind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).to(PostmarkDeliveryGateway);
});

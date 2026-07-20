/**
 * DI tokens for the email module (ADR-003). Co-located like a component's
 * `types.ts`: the `ContainerModule` binds these and tests rebind
 * `DeliveryGateway` to the in-memory double. Consumers (`campaigns`) inject the
 * `DeliveryGateway` interface via this token, never a concrete class.
 */
export const EMAIL_TYPES = {
  DeliveryGateway: Symbol.for('DeliveryGateway'),
} as const;

import 'reflect-metadata';
import { Container } from 'inversify';
import { MongoClient, type Db } from 'mongodb';
import { loadConfig, type AppConfig } from '../config/index.js';
import { DefaultClock, type Clock } from '../clock/index.js';
import { InMemoryIdempotencyStore, type IdempotencyStore } from '../http/index.js';
import { emailModule } from '../email/index.js';
import { authModule } from '../auth/index.js';
import { accountsModule } from '../../accounts/index.js';
import { newsletterModule } from '../../newsletters/index.js';
import { subscriptionModule } from '../../subscriptions/index.js';
import { deliverabilityModule } from '../../deliverability/index.js';
import { templateModule } from '../../templates/index.js';
import { campaignModule } from '../../campaigns/index.js';
import { TYPES } from './types.js';

/**
 * The single composition root (ADR-003). Built once at module scope by each
 * entrypoint so warm serverless invocations reuse it (ADR-009). Concrete
 * implementations are named only here.
 *
 * This is the one deliberate exception to the "shared modules are leaves" rule
 * (ADR-005 #4): the composition root — and only it — imports domain components,
 * to load each one's `ContainerModule`. Every other `shared/*` module stays a
 * true leaf. The exception is encoded surgically in `eslint.config.js`.
 */
export function buildContainer(env: NodeJS.ProcessEnv = process.env): Container {
  const container = new Container({ defaultScope: 'Singleton' });
  const config = loadConfig(env);

  container.bind<AppConfig>(TYPES.Config).toConstantValue(config);
  container.bind<Clock>(TYPES.Clock).to(DefaultClock);
  container.bind<IdempotencyStore>(TYPES.IdempotencyStore).to(InMemoryIdempotencyStore);

  // The Mongo pool (native driver, ADR-012), created lazily so a container
  // built only to rebind repositories in tests never constructs a client or
  // connects. `new MongoClient(...)` does not open a socket — the pool connects
  // on the first operation (or an explicit `connect()` at startup, ADR-009).
  // One client, one derived `Db` handle (the db name comes from DATABASE_URL),
  // shared by every component's Mongo repository.
  container
    .bind<MongoClient>(TYPES.MongoClient)
    .toDynamicValue(() => new MongoClient(config.databaseUrl))
    .inSingletonScope();
  container
    .bind<Db>(TYPES.MongoDb)
    .toDynamicValue((ctx) => ctx.container.get<MongoClient>(TYPES.MongoClient).db())
    .inSingletonScope();

  // Shared technical modules with their own DI wiring. `email` binds the
  // Postmark-backed delivery gateway (ADR-008); tests rebind it to an in-memory
  // double. `auth` binds the `jose` access-token service (ADR-013). Both stay
  // leaves — they import no domain component.
  container.load(emailModule);
  container.load(authModule);

  // Domain component modules (ADR-011). Each names its own concrete repositories
  // and use cases; tests rebind the repository token to an in-memory double.
  // `accounts` (user accounts + auth, ADR-013) depends only on shared modules.
  container.load(accountsModule);
  container.load(newsletterModule);
  container.load(subscriptionModule);
  container.load(deliverabilityModule);
  container.load(templateModule);
  // The integrator (ADR-011): loaded last, it resolves cross-context ports over
  // the facades of every module above.
  container.load(campaignModule);

  return container;
}

import 'reflect-metadata';
import { Container } from 'inversify';
import { PrismaClient } from '@prisma/client';
import { loadConfig, type AppConfig } from '../config/index.js';
import { DefaultClock, type Clock } from '../clock/index.js';
import { emailModule } from '../email/index.js';
import { newsletterModule } from '../../newsletters/index.js';
import { deliverabilityModule } from '../../deliverability/index.js';
import { templateModule } from '../../templates/index.js';
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

  // The Mongo pool, created lazily so a container built only to rebind
  // repositories in tests never connects (ADR-007).
  container
    .bind<PrismaClient>(TYPES.PrismaClient)
    .toDynamicValue(() => new PrismaClient({ datasourceUrl: config.databaseUrl }))
    .inSingletonScope();

  // Shared technical modules with their own DI wiring. `email` binds the
  // Postmark-backed delivery gateway (ADR-008); tests rebind it to an in-memory
  // double. Still a leaf — it imports no domain component.
  container.load(emailModule);

  // Domain component modules (ADR-011). Each names its own concrete repositories
  // and use cases; tests rebind the repository token to an in-memory double.
  container.load(newsletterModule);
  container.load(deliverabilityModule);
  container.load(templateModule);

  return container;
}

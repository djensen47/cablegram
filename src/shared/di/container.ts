import 'reflect-metadata';
import { Container } from 'inversify';
import { loadConfig, type AppConfig } from '../config/index.js';
import { DefaultClock, type Clock } from '../clock/index.js';
import { TYPES } from './types.js';

/**
 * The single composition root (ADR-003). Built once at module scope by each
 * entrypoint so warm serverless invocations reuse it (ADR-009). Concrete
 * implementations are named only here.
 *
 * As domain components are added, load their `ContainerModule`s here.
 */
export function buildContainer(env: NodeJS.ProcessEnv = process.env): Container {
  const container = new Container({ defaultScope: 'Singleton' });

  container.bind<AppConfig>(TYPES.Config).toConstantValue(loadConfig(env));
  container.bind<Clock>(TYPES.Clock).to(DefaultClock);

  return container;
}

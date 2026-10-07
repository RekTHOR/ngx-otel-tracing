import {
  EnvironmentProviders,
  ErrorHandler,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer
} from '@angular/core';
import {RouterTracingService} from './router-tracing.service';
import {TracingErrorHandler} from './tracing-error-handler';
import {DEFAULT_FEATURES, TRACING_CONFIG, TracingConfig} from './tracing-config';
import {TracingService} from './tracing.service';

/**
 * Starts browser tracing for the app.
 *
 * ```ts
 * provideTracing({
 *   serviceName: 'my-app',
 *   collectorUrl: 'https://collector.example.com/v1/traces',
 *   propagateTraceTo: ['https://api.example.com/'],
 * })
 * ```
 */
export function provideTracing(config: TracingConfig): EnvironmentProviders {
  const features = {...DEFAULT_FEATURES, ...config.features};

  return makeEnvironmentProviders([
    {provide: TRACING_CONFIG, useValue: config},
    provideAppInitializer(() => {
      const tracing = inject(TracingService);
      if (tracing.enabled && features.router) {
        inject(RouterTracingService);
      }
    }),
    ...(features.errors ? [{provide: ErrorHandler, useClass: TracingErrorHandler}] : []),
  ]);
}

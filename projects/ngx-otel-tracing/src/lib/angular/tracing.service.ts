import {inject, Injectable, NgZone} from '@angular/core';
import {BatchSpanProcessor, ParentBasedSampler, Sampler, WebTracerProvider} from '@opentelemetry/sdk-trace-web';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {registerInstrumentations} from '@opentelemetry/instrumentation';
import {getWebAutoInstrumentations} from '@opentelemetry/auto-instrumentations-web';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {ROOT_CONTEXT, SpanStatusCode, trace, Tracer} from '@opentelemetry/api';
import {FinishReason, PageTrace, PageTraceKind} from '../core/page-trace';
import {INSTRUMENTATION_SCOPE} from '../core/instrumentation-scope';
import {PageTraceContextManager} from '../core/page-trace-context-manager';
import {startWebPerformanceTracing} from '../core/web-performance-tracing';
import {SessionAttributesProcessor, SessionRatioSampler, TraceSession} from '../core/trace-session';
import {ScrubbingSpanExporter, sanitizeErrorMessage, scrubUrl} from '../core/trace-privacy';
import {NoiseFilteringSpanExporter} from '../core/trace-noise-filter';
import {describeClickTarget} from '../core/trace-element';
import {DEFAULT_FEATURES, TRACING_CONFIG, TracingFeatures} from './tracing-config';

@Injectable({providedIn: 'root'})
export class TracingService {
  private readonly config = inject(TRACING_CONFIG);
  private readonly ngZone = inject(NgZone);
  private readonly session = new TraceSession();
  private provider: WebTracerProvider | null = null;
  private tracer: Tracer = trace.getTracer(INSTRUMENTATION_SCOPE);

  public readonly features: TracingFeatures = {...DEFAULT_FEATURES, ...this.config.features};
  public readonly enabled = this.config.enabled !== false && (this.config.sampleRate ?? 1) > 0;
  public readonly pageTrace = new PageTrace(fn => this.ngZone.runOutsideAngular(fn));

  constructor() {
    if (this.enabled) {
      this.initialize();
    }
  }

  /** Records an unhandled error as an `error` span inside the running or most recent page trace. */
  public recordError(error: unknown): void {
    if (!this.enabled) {
      return;
    }
    const message = TracingService.messageOf(error);
    const exception = error instanceof Error ? error : message;
    const span = this.tracer.startSpan('error', {
      attributes: {'page.path': location.pathname},
    }, this.pageTrace.activeContext ?? ROOT_CONTEXT);
    span.recordException(exception);
    span.setStatus({code: SpanStatusCode.ERROR, message});
    span.end();
    this.pageTrace.rootSpan?.setStatus({code: SpanStatusCode.ERROR, message});
  }

  /** Errors that are not `Error` instances (e.g. HttpErrorResponse) still carry a `message`. */
  private static messageOf(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    const message = (error as { message?: unknown } | null)?.message;
    return typeof message === 'string' ? message : String(error);
  }

  public getTracer(): Tracer {
    return this.tracer;
  }

  public shutdown(): Promise<void> {
    return this.provider?.shutdown() ?? Promise.resolve();
  }

  private initialize(): void {
    const {config} = this;
    const privacy = config.privacy ?? {};

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.serviceVersion ? {[ATTR_SERVICE_VERSION]: config.serviceVersion} : {}),
      ...(config.environment ? {[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment} : {}),
    });

    const exporter = new NoiseFilteringSpanExporter(new ScrubbingSpanExporter(
      new OTLPTraceExporter({url: config.collectorUrl, headers: config.headers}),
      {
        sanitizeUrl: privacy.sanitizeUrl ?? scrubUrl,
        sanitizeErrorMessage: privacy.sanitizeErrorMessage ?? sanitizeErrorMessage,
      },
    ));

    this.provider = new WebTracerProvider({
      resource,
      sampler: this.createSampler(),
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
        }),
        new SessionAttributesProcessor(this.session),
        this.pageTrace,
      ],
    });

    this.provider.register({contextManager: new PageTraceContextManager(this.pageTrace)});

    this.tracer = this.provider.getTracer(INSTRUMENTATION_SCOPE);
    this.pageTrace.setTracer(this.tracer);
    // Root of the page load trace; started before the instrumentations so document-load spans attach to it.
    this.pageTrace.begin(PageTraceKind.PageLoad, {'page.url': location.href}, performance.timeOrigin);

    this.registerInstrumentations();
    startWebPerformanceTracing(this.tracer, this.pageTrace, fn => this.ngZone.runOutsideAngular(fn), {
      webVitals: this.features.webVitals,
      longTasks: this.features.longTasks,
    });
    this.registerFlushHandlers();
  }

  private createSampler(): Sampler | undefined {
    const rate = this.config.sampleRate ?? 1;
    return rate >= 1 ? undefined : new ParentBasedSampler({root: new SessionRatioSampler(rate, this.session)});
  }

  private registerInstrumentations(): void {
    const {config} = this;
    const readButtonText = config.privacy?.clickLabels === 'button-text';
    const propagate = config.propagateTraceTo ?? [];

    registerInstrumentations({
      instrumentations: [
        getWebAutoInstrumentations({
          '@opentelemetry/instrumentation-document-load': {enabled: true},
          '@opentelemetry/instrumentation-fetch': {
            ignoreUrls: [config.collectorUrl],
            propagateTraceHeaderCorsUrls: propagate,
            clearTimingResources: true,
          },
          '@opentelemetry/instrumentation-xml-http-request': {
            ignoreUrls: [config.collectorUrl],
            propagateTraceHeaderCorsUrls: propagate,
          },
          '@opentelemetry/instrumentation-user-interaction': {
            enabled: this.features.interactions,
            eventNames: ['click', 'submit'],
            shouldPreventSpanCreation: (_event, element, span) => {
              describeClickTarget(element, span, {readButtonText});
            },
          },
        }),
      ],
    });
  }

  private registerFlushHandlers(): void {
    const flush = () => {
      this.pageTrace.finish(FinishReason.PageHidden);
      void this.provider?.forceFlush().catch(() => undefined);
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    });
    window.addEventListener('pagehide', flush);
  }
}

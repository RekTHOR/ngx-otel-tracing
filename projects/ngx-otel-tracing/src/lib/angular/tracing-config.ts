import {InjectionToken} from '@angular/core';

export interface TracingFeatures {
  /** Router phases (navigation, lazy load, guards, resolvers) and page-trace naming. */
  router: boolean;
  /** Replaces Angular's ErrorHandler to record unhandled errors as spans. */
  errors: boolean;
  /** Core Web Vitals (LCP, CLS, INP, FCP, TTFB). */
  webVitals: boolean;
  /** Long tasks / long animation frames. */
  longTasks: boolean;
  /** Click and submit spans. */
  interactions: boolean;
}

export interface TracingPrivacy {
  /**
   * Applied to every URL attribute before export. Defaults to `scrubUrl`: drops the fragment, redacts
   * query values, replaces UUID and all-digit path segments with `:id`.
   */
  sanitizeUrl?: (url: string) => string;
  /** Applied to `exception.message` before export. Defaults to scrubbing URLs inside the text (like `sanitizeUrl`) and truncating to 200 characters. */
  sanitizeErrorMessage?: (message: string) => string;
  /**
   * What names a click span. `'explicit'` (default) uses only `data-trace-label` / `data-testid`;
   * `'button-text'` also reads the text of `<button>` elements. `data-trace-ignore` is always honored.
   */
  clickLabels?: 'explicit' | 'button-text';
}

export interface TracingConfig {
  serviceName: string;
  /** OTLP/HTTP traces endpoint, e.g. `https://collector.example.com/v1/traces`. */
  collectorUrl: string;
  serviceVersion?: string;
  /** Reported as `deployment.environment.name`. */
  environment?: string;
  /** Share of sessions to record, 0 to 1. Defaults to 1. */
  sampleRate?: number;
  /**
   * URLs that receive the `traceparent` header (their CORS policy must allow it). A string matches every URL
   * that starts with it, a RegExp is tested as is. Same-origin requests always get the header. Defaults to none.
   */
  propagateTraceTo?: (string | RegExp)[];
  /** Defaults to true. When false, nothing is started. */
  enabled?: boolean;
  /** Extra headers for the OTLP exporter. Visible in the browser, so only for public ingest keys. */
  headers?: Record<string, string>;
  features?: Partial<TracingFeatures>;
  privacy?: TracingPrivacy;
}

export const DEFAULT_FEATURES: TracingFeatures = {
  router: true,
  errors: true,
  webVitals: true,
  longTasks: true,
  interactions: true,
};

export const TRACING_CONFIG = new InjectionToken<TracingConfig>('NGX_OTEL_TRACING_CONFIG');

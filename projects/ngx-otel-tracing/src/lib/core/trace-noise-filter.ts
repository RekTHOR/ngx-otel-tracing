import {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-web';

const INTERACTION_SCOPE = 'instrumentation-user-interaction';
const MIN_INTERACTION_DURATION_MS = 50;

/**
 * Drops user-interaction spans that did no work: they finished almost instantly and nothing was
 * started under them (no request, no timer-driven follow-up). These are the bulk of `click` spans
 * (row selection, focus, toggles) and only clutter the trace.
 */
export class NoiseFilteringSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    const parentIds = new Set(
      spans.map(span => span.parentSpanContext?.spanId).filter((id): id is string => !!id),
    );
    const kept = spans.filter(span => !NoiseFilteringSpanExporter.isIdleInteraction(span, parentIds));

    if (kept.length === 0) {
      // ExportResultCode.SUCCESS
      resultCallback({code: 0});
      return;
    }
    this.inner.export(kept, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  private static isIdleInteraction(span: ReadableSpan, parentIds: Set<string>): boolean {
    if (!span.instrumentationScope.name.includes(INTERACTION_SCOPE)) {
      return false;
    }
    const durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6;
    return durationMs < MIN_INTERACTION_DURATION_MS && !parentIds.has(span.spanContext().spanId);
  }
}

import {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-web';
import {NoiseFilteringSpanExporter} from './trace-noise-filter';

function span(options: { scope?: string; durationMs: number; spanId: string; parentId?: string }): ReadableSpan {
  return {
    instrumentationScope: {name: options.scope ?? '@opentelemetry/instrumentation-user-interaction'},
    duration: [Math.floor(options.durationMs / 1000), (options.durationMs % 1000) * 1e6],
    spanContext: () => ({spanId: options.spanId}),
    parentSpanContext: options.parentId ? {spanId: options.parentId} : undefined,
  } as unknown as ReadableSpan;
}

describe('NoiseFilteringSpanExporter', () => {
  let inner: jasmine.SpyObj<SpanExporter>;
  let exporter: NoiseFilteringSpanExporter;

  beforeEach(() => {
    inner = jasmine.createSpyObj<SpanExporter>('inner', ['export', 'shutdown', 'forceFlush']);
    exporter = new NoiseFilteringSpanExporter(inner);
  });

  function exported(): ReadableSpan[] {
    return inner.export.calls.mostRecent().args[0];
  }

  it('drops short interaction spans that have no children', () => {
    const idleClick = span({durationMs: 0.1, spanId: 'a'});
    const http = span({scope: '@opentelemetry/instrumentation-xml-http-request', durationMs: 5, spanId: 'b'});
    exporter.export([idleClick, http], () => undefined);
    expect(exported()).toEqual([http]);
  });

  it('keeps a short interaction span when another span in the batch is its child', () => {
    const click = span({durationMs: 10, spanId: 'click'});
    const child = span({scope: 'x', durationMs: 5, spanId: 'child', parentId: 'click'});
    exporter.export([click, child], () => undefined);
    expect(exported()).toEqual([click, child]);
  });

  it('keeps interaction spans that took long enough to matter', () => {
    const slow = span({durationMs: 120, spanId: 'slow'});
    exporter.export([slow], () => undefined);
    expect(exported()).toEqual([slow]);
  });

  it('reports success without calling the inner exporter when nothing is left', () => {
    const callback = jasmine.createSpy('callback');
    exporter.export([span({durationMs: 1, spanId: 'only'})], callback);
    expect(inner.export).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({code: 0});
  });
});

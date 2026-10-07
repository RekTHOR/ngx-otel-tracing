import {InMemorySpanExporter, ReadableSpan, SimpleSpanProcessor, WebTracerProvider} from '@opentelemetry/sdk-trace-web';
import {SpanStatusCode} from '@opentelemetry/api';
import {FinishReason, PageTrace, PageTraceKind} from './page-trace';

describe('PageTrace', () => {
  let exporter: InMemorySpanExporter;
  let pageTrace: PageTrace;
  let provider: WebTracerProvider;

  function createPageTrace(): PageTrace {
    const instance = new PageTrace(fn => fn());
    provider = new WebTracerProvider({spanProcessors: [new SimpleSpanProcessor(exporter), instance]});
    instance.setTracer(provider.getTracer('test'));
    return instance;
  }

  function finished(name?: string): ReadableSpan[] {
    return exporter.getFinishedSpans().filter(span => !name || span.name === name);
  }

  function finishReason(span: ReadableSpan): unknown {
    return span.attributes['idle_span.finish_reason'];
  }

  beforeEach(() => {
    sessionStorage.removeItem('otel.previous_trace');
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date());
    exporter = new InMemorySpanExporter();
    pageTrace = createPageTrace();
  });

  afterEach(() => {
    pageTrace.finish();
    jasmine.clock().uninstall();
  });

  describe('root lifecycle', () => {
    it('opens a root span with an active context', () => {
      pageTrace.begin(PageTraceKind.PageLoad);
      expect(pageTrace.rootSpan).not.toBeNull();
      expect(pageTrace.context).not.toBeNull();
    });

    it('stays open while the navigation is pending', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      jasmine.clock().tick(5000);
      expect(pageTrace.rootSpan).not.toBeNull();
    });

    it('closes one second after the navigation completed, with reason idle', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.completeNavigation();

      jasmine.clock().tick(999);
      expect(pageTrace.rootSpan).not.toBeNull();

      jasmine.clock().tick(2);
      expect(pageTrace.rootSpan).toBeNull();
      expect(finishReason(finished(PageTraceKind.Navigation)[0])).toBe(FinishReason.Idle);
    });

    it('is kept open by a running child and goes idle again once it ends', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.completeNavigation();
      const child = provider.getTracer('test').startSpan('child', {}, pageTrace.context!);

      jasmine.clock().tick(5000);
      expect(pageTrace.rootSpan).not.toBeNull();

      child.end();
      jasmine.clock().tick(1001);
      expect(pageTrace.rootSpan).toBeNull();
    });

    it('is closed with child_timeout when a child never ends', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.completeNavigation();
      provider.getTracer('test').startSpan('stuck', {}, pageTrace.context!);

      jasmine.clock().tick(15_001);
      expect(pageTrace.rootSpan).toBeNull();
      expect(finishReason(finished(PageTraceKind.Navigation)[0])).toBe(FinishReason.ChildTimeout);
    });

    it('is closed with final_timeout after 30 seconds at the latest', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      jasmine.clock().tick(30_001);
      expect(finishReason(finished(PageTraceKind.Navigation)[0])).toBe(FinishReason.FinalTimeout);
    });

    it('records page_hidden when finished explicitly', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.finish(FinishReason.PageHidden);
      expect(finishReason(finished(PageTraceKind.Navigation)[0])).toBe(FinishReason.PageHidden);
    });

    it('waits for the window load event before a pageload may go idle', () => {
      spyOnProperty(document, 'readyState').and.returnValue('loading');
      pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.completeNavigation();

      jasmine.clock().tick(5000);
      expect(pageTrace.rootSpan).not.toBeNull();

      window.dispatchEvent(new Event('load'));
      jasmine.clock().tick(1001);
      expect(pageTrace.rootSpan).toBeNull();
    });

    it('renames the root after its kind and the route template', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.renameRoot('/admin/users/:id');
      pageTrace.finish();
      expect(finished()[0].name).toBe('navigation /admin/users/:id');
    });

    it('marks the root as failed with the exception', () => {
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.failRoot(new Error('route exploded'));
      pageTrace.finish();

      const root = finished(PageTraceKind.Navigation)[0];
      expect(root.status.code).toBe(SpanStatusCode.ERROR);
      expect(root.events.some(event => event.name === 'exception')).toBeTrue();
    });
  });

  describe('trace pinning', () => {
    it('keeps the closed trace active for later spans, then lets it expire', () => {
      const root = pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.finish();

      expect(pageTrace.context).toBeNull();
      expect(pageTrace.activeContext).not.toBeNull();

      const late = provider.getTracer('test').startSpan('late', {}, pageTrace.activeContext!);
      expect(late.spanContext().traceId).toBe(root.spanContext().traceId);
      late.end();

      jasmine.clock().tick(5 * 60_000 + 1);
      expect(pageTrace.activeContext).toBeNull();
    });
  });

  describe('links to the previous trace', () => {
    it('links a new root to the one that just closed', () => {
      const first = pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.finish();

      const second = finished(PageTraceKind.Navigation)[0];
      expect(second.links[0].context.traceId).toBe(first.spanContext().traceId);
      expect(second.links[0].attributes?.['link.type']).toBe('previous_trace');
      expect(second.attributes['previous_trace_id']).toBe(first.spanContext().traceId);
    });

    it('does not link the very first root', () => {
      pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.finish();
      expect(finished(PageTraceKind.PageLoad)[0].links.length).toBe(0);
    });

    it('survives a full page load through sessionStorage', () => {
      const before = pageTrace.begin(PageTraceKind.Navigation);
      pageTrace.finish();

      const reloaded = createPageTrace();
      reloaded.begin(PageTraceKind.PageLoad);
      reloaded.finish();

      const root = finished(PageTraceKind.PageLoad)[0];
      expect(root.links[0].context.traceId).toBe(before.spanContext().traceId);
      expect(root.attributes['previous_trace_id']).toBe(before.spanContext().traceId);
    });

    it('ignores corrupt persisted data', () => {
      sessionStorage.setItem('otel.previous_trace', '{not json');
      pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.finish();
      expect(finished(PageTraceKind.PageLoad)[0].links.length).toBe(0);
    });
  });

  describe('navigations', () => {
    it('lets the first navigation continue the pageload trace', () => {
      const root = pageTrace.begin(PageTraceKind.PageLoad);
      const span = pageTrace.beginNavigation({'route.id': 1});
      expect(span).toBe(root);
      expect(pageTrace.rootSpan).toBe(root);
    });

    it('treats a navigation right after another without user input as a redirect child', () => {
      const root = pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.beginNavigation({'route.id': 1});
      jasmine.clock().tick(100);

      const redirect = pageTrace.beginNavigation({'route.id': 2});
      expect(pageTrace.rootSpan).toBe(root);

      pageTrace.completeNavigation();
      const redirectSpan = finished('navigation.redirect')[0];
      expect(redirectSpan.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(redirect.spanContext().traceId).toBe(root.spanContext().traceId);
    });

    it('starts a new trace for a navigation caused by user input', () => {
      const root = pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.beginNavigation({'route.id': 1});
      jasmine.clock().tick(100);
      document.dispatchEvent(new Event('click'));
      jasmine.clock().tick(100);

      pageTrace.beginNavigation({'route.id': 2});
      expect(pageTrace.rootSpan).not.toBe(root);
      expect(pageTrace.rootSpan!.spanContext().traceId).not.toBe(root.spanContext().traceId);
    });

    it('starts a new trace once the redirect window has passed', () => {
      const root = pageTrace.begin(PageTraceKind.PageLoad);
      pageTrace.beginNavigation({'route.id': 1});
      jasmine.clock().tick(2000);

      pageTrace.beginNavigation({'route.id': 2});
      expect(pageTrace.rootSpan!.spanContext().traceId).not.toBe(root.spanContext().traceId);
    });
  });
});

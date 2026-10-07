import {
  Attributes,
  Context,
  Link,
  ROOT_CONTEXT,
  Span,
  SpanContext,
  SpanStatusCode,
  trace,
  Tracer
} from '@opentelemetry/api';
import {ReadableSpan, Span as SdkSpan, SpanProcessor} from '@opentelemetry/sdk-trace-web';
import {INSTRUMENTATION_SCOPE} from './instrumentation-scope';

export enum PageTraceKind {
  PageLoad = 'pageload',
  Navigation = 'navigation'
}

export enum FinishReason {
  Idle = 'idle',
  FinalTimeout = 'final_timeout',
  ChildTimeout = 'child_timeout',
  NextNavigation = 'next_navigation',
  PageHidden = 'page_hidden',
  Shutdown = 'shutdown'
}

const PREVIOUS_TRACE_KEY = 'otel.previous_trace';

interface FinishedRoot {
  spanContext: SpanContext;
  context: Context;
  endedAt: number;
}

/**
 * Keeps one "idle" root span open per page load / navigation, like a browser performance monitor's
 * pageload/navigation transaction.
 *
 * - Every span started while it is open (HTTP calls, clicks, router phases) joins its trace.
 * - It closes after IDLE_TIMEOUT_MS without running child spans (end time = last activity), after
 *   CHILD_TIMEOUT_MS since the last child started (stuck child), or after MAX_DURATION_MS at the latest.
 * - Once closed, its trace id stays "pinned" for PIN_TTL_MS: later activity (late requests, errors,
 *   web vitals) still lands in that trace until the next navigation starts a new one.
 * - A new navigation trace carries a link (and attribute) to the previous trace.
 * - A navigation right after another one without any user input is a redirect, and becomes a child
 *   span instead of a new trace.
 */
export class PageTrace implements SpanProcessor {
  private static readonly IDLE_TIMEOUT_MS = 1000;
  private static readonly CHILD_TIMEOUT_MS = 15_000;
  private static readonly MAX_DURATION_MS = 30_000;
  private static readonly REDIRECT_WINDOW_MS = 1500;
  private static readonly PIN_TTL_MS = 5 * 60_000;
  private static readonly PREVIOUS_LINK_MAX_AGE_MS = 60 * 60_000;

  private tracer: Tracer = trace.getTracer(INSTRUMENTATION_SCOPE);
  private root: Span | null = null;
  private rootContext: Context | null = null;
  private traceId: string | null = null;
  private kind: PageTraceKind = PageTraceKind.PageLoad;
  private previous: FinishedRoot | null = null;
  private redirectSpan: Span | null = null;
  private readonly openSpanIds = new Set<string>();
  private initialNavigationClaimed = false;
  private navigationPending = false;
  private loadPending = false;
  private listening = false;
  private lastActivity = 0;
  private rootStartedAt = 0;
  private navigationStartedAt = 0;
  private lastInteractionAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private childTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timers must not trigger Angular change detection, so they are scheduled outside the Angular zone. */
  constructor(private readonly runOutsideAngular: <T>(fn: () => T) => T) {
  }

  /** Context of the open root span, if any. */
  public get context(): Context | null {
    return this.rootContext;
  }

  /** The open root's context, or else the pinned context of the most recently closed trace. */
  public get activeContext(): Context | null {
    if (this.rootContext) {
      return this.rootContext;
    }
    const previous = this.previous;
    return previous && Date.now() - previous.endedAt < PageTrace.PIN_TTL_MS ? previous.context : null;
  }

  /** Epoch ms at which the open root span started. */
  public get startedAt(): number {
    return this.rootStartedAt;
  }

  public get rootSpan(): Span | null {
    return this.root;
  }

  public setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  /** Starts a new root span in a fresh trace, closing the previous one. */
  public begin(kind: PageTraceKind, attributes: Attributes = {}, startTime?: number): Span {
    this.ensureInteractionListeners();
    this.finish(FinishReason.NextNavigation);
    this.previous ??= PageTrace.readPersistedPrevious();

    const previous = this.previous;
    const linked = previous !== null && Date.now() - previous.endedAt < PageTrace.PREVIOUS_LINK_MAX_AGE_MS;
    const links: Link[] = linked
      ? [{context: previous.spanContext, attributes: {'link.type': 'previous_trace'}}]
      : [];

    const span = this.tracer.startSpan(kind, {
      attributes: linked ? {...attributes, 'previous_trace_id': previous.spanContext.traceId} : attributes,
      links,
      startTime,
    }, ROOT_CONTEXT);

    const now = Date.now();
    this.root = span;
    this.rootContext = trace.setSpan(ROOT_CONTEXT, span);
    this.traceId = span.spanContext().traceId;
    this.kind = kind;
    this.initialNavigationClaimed = false;
    this.openSpanIds.clear();
    this.navigationPending = true;
    this.loadPending = kind === PageTraceKind.PageLoad && document.readyState !== 'complete';
    this.lastActivity = now;
    this.rootStartedAt = startTime ?? now;
    this.navigationStartedAt = now;
    this.maxTimer = this.schedule(() => this.finish(FinishReason.FinalTimeout), PageTrace.MAX_DURATION_MS);

    if (this.loadPending) {
      window.addEventListener('load', () => this.onWindowLoad(span), {once: true});
    }
    return span;
  }

  /**
   * Called for a router NavigationStart. The first one continues the pageload trace, a redirect becomes
   * a child span of the running root, anything else starts a new trace.
   */
  public beginNavigation(attributes: Attributes): Span {
    if (this.root && this.kind === PageTraceKind.PageLoad && !this.initialNavigationClaimed) {
      this.initialNavigationClaimed = true;
      this.navigationStartedAt = Date.now();
      this.root.setAttributes(attributes);
      return this.root;
    }
    if (this.root && this.rootContext && this.isRedirect()) {
      return this.beginRedirect(this.rootContext, attributes);
    }
    return this.begin(PageTraceKind.Navigation, attributes);
  }

  /** The router is done (end / cancel / error): the root may now go idle. */
  public completeNavigation(): void {
    this.endRedirectSpan();
    this.navigationPending = false;
    this.lastActivity = Date.now();
    this.armIdleTimer();
  }

  public renameRoot(routeTemplate: string): void {
    this.root?.updateName(`${this.kind} ${routeTemplate}`);
  }

  public failRoot(error: unknown): void {
    if (!this.root) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.root.recordException(error instanceof Error ? error : message);
    this.root.setStatus({code: SpanStatusCode.ERROR, message});
  }

  public finish(reason: FinishReason = FinishReason.Shutdown): void {
    this.clearTimers();
    this.endRedirectSpan();
    const root = this.root;
    if (!root) {
      return;
    }

    const spanContext = root.spanContext();
    this.previous = {
      spanContext,
      context: trace.setSpanContext(ROOT_CONTEXT, spanContext),
      endedAt: Date.now(),
    };
    PageTrace.persistPrevious(this.previous);
    this.root = null;
    this.rootContext = null;
    this.traceId = null;
    this.navigationPending = false;
    this.loadPending = false;
    this.openSpanIds.clear();

    root.setAttribute('idle_span.finish_reason', reason);
    root.end(Math.max(this.lastActivity, this.rootStartedAt));
  }

  onStart(span: SdkSpan): void {
    if (!this.belongsToRoot(span)) {
      return;
    }
    this.openSpanIds.add(span.spanContext().spanId);
    this.clearIdleTimer();
    this.restartChildTimer();
  }

  onEnd(span: ReadableSpan): void {
    if (!this.belongsToRoot(span)) {
      return;
    }
    this.openSpanIds.delete(span.spanContext().spanId);
    this.lastActivity = Date.now();
    if (this.openSpanIds.size === 0) {
      this.clearChildTimer();
    }
    this.armIdleTimer();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.finish(FinishReason.Shutdown);
    return Promise.resolve();
  }

  /** Survives full page loads (reload, org switch), so the new pageload links back to the last trace. */
  private static persistPrevious(previous: FinishedRoot): void {
    try {
      const {traceId, spanId, traceFlags} = previous.spanContext;
      sessionStorage.setItem(PREVIOUS_TRACE_KEY, JSON.stringify({
        traceId,
        spanId,
        traceFlags,
        endedAt: previous.endedAt
      }));
    } catch {
      // storage unavailable: the link is simply not carried across page loads
    }
  }

  private static readPersistedPrevious(): FinishedRoot | null {
    try {
      const stored = JSON.parse(sessionStorage.getItem(PREVIOUS_TRACE_KEY) ?? 'null');
      if (!stored?.traceId || !stored?.spanId || typeof stored.endedAt !== 'number') {
        return null;
      }
      const spanContext: SpanContext = {
        traceId: stored.traceId,
        spanId: stored.spanId,
        traceFlags: stored.traceFlags ?? 0,
        isRemote: true,
      };
      return {spanContext, context: trace.setSpanContext(ROOT_CONTEXT, spanContext), endedAt: stored.endedAt};
    } catch {
      return null;
    }
  }

  private isRedirect(): boolean {
    return Date.now() - this.navigationStartedAt < PageTrace.REDIRECT_WINDOW_MS
      && this.lastInteractionAt < this.navigationStartedAt;
  }

  private beginRedirect(parent: Context, attributes: Attributes): Span {
    this.endRedirectSpan();
    this.navigationPending = true;
    this.navigationStartedAt = Date.now();
    this.clearIdleTimer();
    this.redirectSpan = this.tracer.startSpan('navigation.redirect', {attributes}, parent);
    return this.redirectSpan;
  }

  private endRedirectSpan(): void {
    this.redirectSpan?.end();
    this.redirectSpan = null;
  }

  private onWindowLoad(rootAtRegistration: Span): void {
    if (this.root !== rootAtRegistration) {
      return;
    }
    this.loadPending = false;
    this.lastActivity = Date.now();
    this.armIdleTimer();
  }

  private ensureInteractionListeners(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.runOutsideAngular(() => {
      const markInteraction = () => {
        this.lastInteractionAt = Date.now();
      };
      document.addEventListener('click', markInteraction, {capture: true, passive: true});
      document.addEventListener('keydown', markInteraction, {capture: true, passive: true});
    });
  }

  private belongsToRoot(span: ReadableSpan | SdkSpan): boolean {
    return this.root !== null && span.spanContext().traceId === this.traceId;
  }

  private armIdleTimer(): void {
    if (!this.root || this.navigationPending || this.loadPending || this.openSpanIds.size > 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = this.schedule(() => this.finish(FinishReason.Idle), PageTrace.IDLE_TIMEOUT_MS);
  }

  private restartChildTimer(): void {
    this.clearChildTimer();
    this.childTimer = this.schedule(() => this.finish(FinishReason.ChildTimeout), PageTrace.CHILD_TIMEOUT_MS);
  }

  private schedule(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
    return this.runOutsideAngular(() => setTimeout(fn, delay));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearChildTimer(): void {
    if (this.childTimer) {
      clearTimeout(this.childTimer);
      this.childTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    this.clearChildTimer();
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }
}

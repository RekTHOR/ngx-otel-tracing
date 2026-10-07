import {inject, Injectable} from '@angular/core';
import {ActivatedRouteSnapshot, Event, EventType, Route, Router,} from '@angular/router';
import {context, Span, SpanStatusCode} from '@opentelemetry/api';
import {PageTrace} from '../core/page-trace';
import {TracingService} from './tracing.service';

@Injectable({providedIn: 'root'})
export class RouterTracingService {
  private readonly router = inject(Router);
  private readonly tracingService = inject(TracingService);
  private readonly pageTrace: PageTrace = this.tracingService.pageTrace;
  private readonly phaseSpans = new Map<string, Span>();
  private currentNavigationId: number | null = null;

  constructor() {
    if (this.tracingService.enabled) {
      this.router.events.subscribe(event => this.onRouterEvent(event));
    }
  }

  private onRouterEvent(event: Event): void {
    switch (event.type) {
      case EventType.NavigationStart:
        this.endPhaseSpans();
        this.currentNavigationId = event.id;
        this.pageTrace.beginNavigation({
          'route.id': event.id,
          'navigation.trigger': event.navigationTrigger,
        });
        this.startPhase('navigation', 'route.navigation');
        break;
      case EventType.RouteConfigLoadStart:
        this.startPhase(`config:${RouterTracingService.routeKey(event.route)}`, 'route.load_config', {
          'route.path': event.route.path ?? '',
        });
        break;
      case EventType.RouteConfigLoadEnd:
        this.endPhase(`config:${RouterTracingService.routeKey(event.route)}`);
        break;
      case EventType.GuardsCheckStart:
        this.startPhase('guards', 'route.guards');
        break;
      case EventType.GuardsCheckEnd:
        this.endPhase('guards', {'route.guards_passed': event.shouldActivate});
        break;
      case EventType.ResolveStart:
        this.startPhase('resolve', 'route.resolve');
        break;
      case EventType.ResolveEnd:
        this.endPhase('resolve');
        this.pageTrace.renameRoot(RouterTracingService.routeTemplate(event.state.root));
        break;
      case EventType.NavigationEnd:
        this.completeNavigation(event.id, root => {
          const template = RouterTracingService.routeTemplate(this.router.routerState.snapshot.root);
          root.setAttribute('route.template', template);
          this.pageTrace.renameRoot(template);
        });
        break;
      case EventType.NavigationError:
        this.completeNavigation(event.id, () => {
          this.pageTrace.failRoot(event.error);
          this.phaseSpans.get('navigation')?.setStatus({code: SpanStatusCode.ERROR, message: event.error?.message});
        });
        break;
      case EventType.NavigationCancel:
        this.completeNavigation(event.id, root => {
          root.setAttribute('navigation.cancel_reason', event.reason);
        });
        break;
    }
  }

  /** Ignores late events of a superseded navigation: its root span is already closed. */
  private completeNavigation(navigationId: number, decorate: (root: Span) => void): void {
    if (navigationId !== this.currentNavigationId) {
      return;
    }
    const root = this.pageTrace.rootSpan;
    if (root) {
      decorate(root);
    }
    this.endPhaseSpans();
    this.pageTrace.completeNavigation();
  }

  private startPhase(key: string, name: string, attributes: Record<string, string | number | boolean> = {}): void {
    if (this.phaseSpans.has(key)) {
      return;
    }
    const parent = this.pageTrace.context ?? context.active();
    this.phaseSpans.set(key, this.tracingService.getTracer().startSpan(name, {attributes}, parent));
  }

  private endPhase(key: string, attributes: Record<string, string | number | boolean> = {}): void {
    const span = this.phaseSpans.get(key);
    if (!span) {
      return;
    }
    span.setAttributes(attributes);
    span.end();
    this.phaseSpans.delete(key);
  }

  /** Spans left open (cancelled/failed navigation) would otherwise keep the root from going idle. */
  private endPhaseSpans(): void {
    this.phaseSpans.forEach(span => span.end());
    this.phaseSpans.clear();
  }

  /** Route path with parameter placeholders (e.g. /admin/users/:id) so traces can be aggregated. */
  private static routeTemplate(root: ActivatedRouteSnapshot): string {
    const segments: string[] = [];
    let snapshot: ActivatedRouteSnapshot | null = root;
    while (snapshot) {
      const path = snapshot.routeConfig?.path;
      if (path) {
        segments.push(path);
      }
      snapshot = snapshot.firstChild;
    }
    return '/' + segments.join('/');
  }

  private static routeKey(route: Route): string {
    return route.path ?? '';
  }
}

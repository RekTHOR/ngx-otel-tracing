import {Context, trace} from '@opentelemetry/api';
import {ZoneContextManager} from '@opentelemetry/context-zone';
import {PageTrace} from './page-trace';

/**
 * ZoneContextManager that falls back to the page trace (the open root, else the pinned trace of the
 * last one) when the zone carries no span, so spans from untracked async chains still join a trace.
 */
export class PageTraceContextManager extends ZoneContextManager {
  constructor(private readonly pageTrace: PageTrace) {
    super();
  }

  override active(): Context {
    const context = super.active();
    return trace.getSpan(context) ? context : (this.pageTrace.activeContext ?? context);
  }
}
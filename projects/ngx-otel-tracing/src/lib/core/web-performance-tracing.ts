import {ROOT_CONTEXT, Tracer} from '@opentelemetry/api';
import {onCLS, onFCP, onINP, onLCP, onTTFB, Metric} from 'web-vitals';
import {PageTrace} from './page-trace';

const LONG_TASK_MIN_DURATION_MS = 100;

/**
 * Reports long tasks / long animation frames and Core Web Vitals as spans. Long entries attach to the
 * open page/navigation root (and are dropped otherwise). Web vitals attach to the open root or the
 * pinned trace of the last one, since CLS/INP are only finalized late, and fall back to their own trace.
 */
export function startWebPerformanceTracing(
  tracer: Tracer,
  pageTrace: PageTrace,
  runOutsideAngular: <T>(fn: () => T) => T,
  options: { webVitals: boolean; longTasks: boolean },
): void {
  runOutsideAngular(() => {
    if (options.longTasks) {
      observeLongTasks(tracer, pageTrace);
    }
    if (options.webVitals) {
      observeWebVitals(tracer, pageTrace);
    }
  });
}

interface AnimationFrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  scripts?: { invoker?: string; sourceURL?: string; sourceFunctionName?: string }[];
}

/**
 * Long animation frames (Chromium) carry script attribution and are preferred; plain long tasks are the
 * fallback. Only entries inside the open root are reported, as its children with their real timing.
 */
function observeLongTasks(tracer: Tracer, pageTrace: PageTrace): void {
  if (typeof PerformanceObserver === 'undefined') {
    return;
  }
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const entryType = supported.includes('long-animation-frame') ? 'long-animation-frame'
    : supported.includes('longtask') ? 'longtask' : null;
  if (!entryType) {
    return;
  }

  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as AnimationFrameEntry[]) {
      const parent = pageTrace.context;
      const start = performance.timeOrigin + entry.startTime;
      if (entry.duration < LONG_TASK_MIN_DURATION_MS || !parent || start < pageTrace.startedAt) {
        continue;
      }
      const script = entry.scripts?.[0];
      tracer
        .startSpan(entryType === 'longtask' ? 'long_task' : 'long_animation_frame', {
          startTime: start,
          attributes: {
            'long_task.duration_ms': Math.round(entry.duration),
            'long_task.blocking_duration_ms': entry.blockingDuration === undefined ? undefined : Math.round(entry.blockingDuration),
            'long_task.script.invoker': script?.invoker,
            'long_task.script.source_url': script?.sourceURL,
            'long_task.script.function': script?.sourceFunctionName,
          },
        }, parent)
        .end(start + entry.duration);
    }
  }).observe({type: entryType, buffered: true});
}

function observeWebVitals(tracer: Tracer, pageTrace: PageTrace): void {
  const report = (metric: Metric) => {
    tracer
      .startSpan(`web_vital.${metric.name}`, {
        attributes: {
          'web_vital.name': metric.name,
          'web_vital.value': metric.value,
          'web_vital.unit': metric.name === 'CLS' ? 'score' : 'ms',
          'web_vital.rating': metric.rating,
          'web_vital.navigation_type': metric.navigationType,
          'page.path': location.pathname,
        },
      }, pageTrace.activeContext ?? ROOT_CONTEXT)
      .end();
  };

  onLCP(report);
  onCLS(report);
  onINP(report);
  onFCP(report);
  onTTFB(report);
}
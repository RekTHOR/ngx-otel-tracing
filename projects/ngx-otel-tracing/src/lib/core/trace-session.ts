import {
  Sampler,
  SamplingDecision,
  SamplingResult,
  Span as SdkSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-web';

const STORAGE_KEY = 'otel.session';
const EXPIRY_MS = 30 * 60_000;
const PERSIST_INTERVAL_MS = 10_000;

/** Browser session id, kept in sessionStorage and renewed after 30 minutes of inactivity. */
export class TraceSession {
  private id: string | null = null;
  private lastActivity = 0;
  private lastPersist = 0;

  public current(): string {
    const now = Date.now();
    if (!this.id) {
      this.restore();
    }
    if (!this.id || now - this.lastActivity > EXPIRY_MS) {
      this.id = TraceSession.newId();
      this.lastPersist = 0;
    }
    this.lastActivity = now;
    if (now - this.lastPersist > PERSIST_INTERVAL_MS) {
      this.persist(now);
    }
    return this.id;
  }

  private restore(): void {
    try {
      const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
      if (typeof stored?.id === 'string' && typeof stored?.lastActivity === 'number') {
        this.id = stored.id;
        this.lastActivity = stored.lastActivity;
      }
    } catch {
      // storage unavailable: a fresh in-memory session is used
    }
  }

  private persist(now: number): void {
    this.lastPersist = now;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({id: this.id, lastActivity: now}));
    } catch {
      // storage unavailable: the session just lives in memory
    }
  }

  private static newId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Adds `session.id` to every span. */
export class SessionAttributesProcessor implements SpanProcessor {
  constructor(private readonly session: TraceSession) {
  }

  onStart(span: SdkSpan): void {
    span.setAttribute('session.id', this.session.current());
  }

  onEnd(): void {
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Head sampler that decides per session instead of per trace, so a sampled session is recorded
 * completely rather than as scattered fragments. Meant to be wrapped in a ParentBasedSampler.
 */
export class SessionRatioSampler implements Sampler {
  constructor(private readonly ratio: number, private readonly session: TraceSession) {
  }

  shouldSample(): SamplingResult {
    const keep = SessionRatioSampler.hashToUnit(this.session.current()) < this.ratio;
    return {decision: keep ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD};
  }

  toString(): string {
    return `SessionRatioSampler{${this.ratio}}`;
  }

  /** FNV-1a hash mapped to [0, 1). */
  private static hashToUnit(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x100000000;
  }
}
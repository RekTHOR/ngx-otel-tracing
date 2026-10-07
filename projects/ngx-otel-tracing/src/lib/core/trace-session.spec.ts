import {Span as SdkSpan} from '@opentelemetry/sdk-trace-web';
import {SamplingDecision} from '@opentelemetry/sdk-trace-web';
import {SessionAttributesProcessor, SessionRatioSampler, TraceSession} from './trace-session';

describe('TraceSession', () => {
  beforeEach(() => sessionStorage.removeItem('otel.session'));
  afterEach(() => jasmine.clock().uninstall());

  it('returns the same id while the session is active', () => {
    const session = new TraceSession();
    expect(session.current()).toBe(session.current());
  });

  it('persists the id so a new instance in the same tab continues the session', () => {
    const id = new TraceSession().current();
    expect(new TraceSession().current()).toBe(id);
  });

  it('starts a new session after 30 minutes of inactivity', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(2026, 0, 1, 10, 0, 0));
    const session = new TraceSession();
    const first = session.current();

    jasmine.clock().tick(29 * 60_000);
    expect(session.current()).toBe(first);

    jasmine.clock().tick(31 * 60_000);
    expect(session.current()).not.toBe(first);
  });

  it('works when sessionStorage is unavailable', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    const session = new TraceSession();
    expect(session.current()).toBeTruthy();
  });
});

describe('SessionRatioSampler', () => {
  beforeEach(() => sessionStorage.removeItem('otel.session'));

  it('samples everything at ratio 1 and nothing at ratio 0', () => {
    const session = new TraceSession();
    expect(new SessionRatioSampler(1, session).shouldSample().decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(new SessionRatioSampler(0, session).shouldSample().decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it('decides per session: the same session always gets the same decision', () => {
    const sampler = new SessionRatioSampler(0.5, new TraceSession());
    const first = sampler.shouldSample().decision;
    for (let i = 0; i < 20; i++) {
      expect(sampler.shouldSample().decision).toBe(first);
    }
  });

  it('roughly follows the ratio across many sessions', () => {
    let sampled = 0;
    const total = 400;
    for (let i = 0; i < total; i++) {
      sessionStorage.removeItem('otel.session');
      if (new SessionRatioSampler(0.25, new TraceSession()).shouldSample().decision === SamplingDecision.RECORD_AND_SAMPLED) {
        sampled++;
      }
    }
    expect(sampled / total).toBeGreaterThan(0.15);
    expect(sampled / total).toBeLessThan(0.35);
  });
});

describe('SessionAttributesProcessor', () => {
  it('adds session.id to started spans', () => {
    sessionStorage.removeItem('otel.session');
    const session = new TraceSession();
    const span = jasmine.createSpyObj<SdkSpan>('span', ['setAttribute']);
    new SessionAttributesProcessor(session).onStart(span);
    expect(span.setAttribute).toHaveBeenCalledWith('session.id', session.current());
  });
});

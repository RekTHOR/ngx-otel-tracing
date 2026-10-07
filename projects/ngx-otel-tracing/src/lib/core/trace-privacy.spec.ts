import {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-web';
import {sanitizeErrorMessage, ScrubbingSpanExporter, scrubUrl} from './trace-privacy';

describe('scrubUrl', () => {
  it('redacts query values but keeps the keys', () => {
    expect(scrubUrl('https://api.test/items?email=a@b.hu&page=2')).toBe('https://api.test/items?email=[redacted]&page=[redacted]');
  });

  it('drops the fragment', () => {
    expect(scrubUrl('https://app.test/list#section-3')).toBe('https://app.test/list');
  });

  it('replaces UUID and numeric path segments with :id', () => {
    expect(scrubUrl('https://api.test/users/9f1c2b7e-4d3a-4e5f-8a6b-1c2d3e4f5a6b/orders/12345'))
      .toBe('https://api.test/users/:id/orders/:id');
  });

  it('keeps hosts with ports, IPs and regular segments untouched', () => {
    expect(scrubUrl('http://localhost:5287/api/Currency/picker')).toBe('http://localhost:5287/api/Currency/picker');
    expect(scrubUrl('http://127.0.0.1/api/x')).toBe('http://127.0.0.1/api/x');
  });

  it('leaves a url without query or ids unchanged', () => {
    expect(scrubUrl('/admin/dashboard')).toBe('/admin/dashboard');
  });
});

describe('sanitizeErrorMessage', () => {
  it('keeps short messages', () => {
    expect(sanitizeErrorMessage('boom')).toBe('boom');
  });

  it('truncates long messages to 200 characters plus an ellipsis', () => {
    const result = sanitizeErrorMessage('x'.repeat(500));
    expect(result.length).toBe(201);
    expect(result.endsWith('…')).toBeTrue();
  });

  it('scrubs URLs inside the message', () => {
    expect(sanitizeErrorMessage('Http failure response for https://api.test/users/42?email=a@b.hu: 500 Server Error'))
      .toBe('Http failure response for https://api.test/users/:id?email=[redacted]: 500 Server Error');
  });
});

describe('ScrubbingSpanExporter', () => {
  function fakeSpan(attributes: Record<string, unknown>, events: {
    name: string;
    attributes?: Record<string, unknown>
  }[] = []): ReadableSpan {
    return {attributes, events} as unknown as ReadableSpan;
  }

  function exporterWith(inner: SpanExporter) {
    return new ScrubbingSpanExporter(inner, {
      sanitizeUrl: url => `SAN(${url})`,
      sanitizeErrorMessage: message => `ERR(${message})`,
    });
  }

  let inner: jasmine.SpyObj<SpanExporter>;

  beforeEach(() => {
    inner = jasmine.createSpyObj<SpanExporter>('inner', ['export', 'shutdown', 'forceFlush']);
  });

  it('sanitizes url attributes and leaves other attributes alone', () => {
    const span = fakeSpan({'http.url': '/a?b=1', 'url.full': '/c', 'other': '/d?e=1'});
    exporterWith(inner).export([span], () => undefined);

    expect(span.attributes['http.url']).toBe('SAN(/a?b=1)');
    expect(span.attributes['url.full']).toBe('SAN(/c)');
    expect(span.attributes['other']).toBe('/d?e=1');
    expect(inner.export).toHaveBeenCalledTimes(1);
  });

  it('redacts url.query entirely', () => {
    const span = fakeSpan({'url.query': 'token=abc&x=1'});
    exporterWith(inner).export([span], () => undefined);
    expect(span.attributes['url.query']).toBe('token=[redacted]&x=[redacted]');
  });

  it('sanitizes the message of exception events only', () => {
    const exception = {name: 'exception', attributes: {'exception.message': 'secret', 'exception.type': 'Error'}};
    const other = {name: 'log', attributes: {'exception.message': 'keep'}};
    exporterWith(inner).export([fakeSpan({}, [exception, other])], () => undefined);

    expect(exception.attributes['exception.message']).toBe('ERR(secret)');
    expect(exception.attributes['exception.type']).toBe('Error');
    expect(other.attributes['exception.message']).toBe('keep');
  });
});

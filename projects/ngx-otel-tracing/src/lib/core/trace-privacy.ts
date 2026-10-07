import {Attributes} from '@opentelemetry/api';
import {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-web';

export const DEFAULT_MAX_ERROR_MESSAGE_LENGTH = 200;

const URL_ATTRIBUTES = [
  'http.url',
  'url.full',
  'http.target',
  'http.referrer',
  'document.referrer',
  'page.url',
];
const QUERY_ATTRIBUTE = 'url.query';
const EXCEPTION_EVENT = 'exception';
const EXCEPTION_MESSAGE = 'exception.message';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;

export interface PrivacyOptions {
  /** Applied to every URL attribute before export. */
  sanitizeUrl: (url: string) => string;
  /** Applied to `exception.message` of recorded exceptions before export. */
  sanitizeErrorMessage: (message: string) => string;
}

/**
 * Default URL sanitizer: drops the fragment, replaces query values with a placeholder (keys stay) and
 * replaces UUID and all-digit path segments with `:id`.
 */
export function scrubUrl(value: string): string {
  const withoutFragment = value.split('#')[0];
  const queryStart = withoutFragment.indexOf('?');
  const path = queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const query = queryStart === -1 ? null : withoutFragment.slice(queryStart + 1);

  const scrubbedPath = path
    .split('/')
    .map(segment => (UUID.test(segment) || NUMERIC.test(segment) ? ':id' : segment))
    .join('/');
  return query === null ? scrubbedPath : `${scrubbedPath}?${redactQuery(query)}`;
}

/** Default error message sanitizer: scrubs URLs inside the text, then truncates it. */
export function sanitizeErrorMessage(message: string): string {
  const scrubbed = message.replace(/https?:\/\/[^\s)'"]*[^\s)'".,:;!?]/g, url => scrubUrl(url));
  return scrubbed.length > DEFAULT_MAX_ERROR_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, DEFAULT_MAX_ERROR_MESSAGE_LENGTH)}…`
    : scrubbed;
}

function redactQuery(query: string): string {
  return query
    .split('&')
    .filter(Boolean)
    .map(pair => `${pair.split('=')[0]}=[redacted]`)
    .join('&');
}

/** Sanitizes URL attributes and exception messages right before spans leave the browser. */
export class ScrubbingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly options: PrivacyOptions,
  ) {
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    spans.forEach(span => this.scrub(span));
    this.inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  private scrub(span: ReadableSpan): void {
    const attributes = span.attributes as Attributes;
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === 'string') {
        attributes[key] = this.options.sanitizeUrl(value);
      }
    }
    const query = attributes[QUERY_ATTRIBUTE];
    if (typeof query === 'string') {
      attributes[QUERY_ATTRIBUTE] = redactQuery(query);
    }

    for (const event of span.events) {
      const message = event.attributes?.[EXCEPTION_MESSAGE];
      if (event.name === EXCEPTION_EVENT && typeof message === 'string') {
        (event.attributes as Attributes)[EXCEPTION_MESSAGE] = this.options.sanitizeErrorMessage(message);
      }
    }
  }
}
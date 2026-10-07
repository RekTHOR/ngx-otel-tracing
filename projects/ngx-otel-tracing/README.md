# @rekthor/ngx-otel-tracing

Browser tracing for Angular on [OpenTelemetry](https://opentelemetry.io/). One call in `app.config.ts` gives you
structured traces per page load and navigation, in the shape of a browser performance monitor:

- one **root span per page load / navigation**; requests, clicks and router phases are its children,
- **router phases** as spans (lazy load, guards, resolvers) and root names like `navigation /admin/users/:id`,
- a **`session.id`** on every span and **session-based sampling**,
- **web vitals** and **long tasks / long animation frames**,
- **errors** recorded as spans inside the trace they happened in,
- **privacy-safe export**: URL and error message sanitizing, no visible text read from the page,
- **links between traces**: a new trace links to the previous one, also across full page loads.

Requires Angular 20 with `zone.js`. Zoneless applications are not supported.

## Install

```bash
npm install @rekthor/ngx-otel-tracing \
  @opentelemetry/api @opentelemetry/auto-instrumentations-web @opentelemetry/context-zone \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation @opentelemetry/resources \
  @opentelemetry/sdk-trace-web @opentelemetry/semantic-conventions web-vitals
```

`@rekthor/ngx-otel-tracing` has **no dependencies of its own**. Everything it builds on is a peer dependency that your
app installs and versions itself:

| Package | Why |
|---|---|
| `@angular/core`, `@angular/common`, `@angular/router` | Angular 20 |
| `zone.js` | context propagation (zoneless apps are not supported) |
| `@opentelemetry/*` (the eight packages above) | tracing SDK, OTLP export, browser instrumentations |
| `web-vitals` | Core Web Vitals. Required even with `features.webVitals` off, because the library imports it. |

npm 7+ installs missing peer dependencies automatically. With yarn or pnpm, or when npm reports a peer conflict,
install them explicitly as shown above.

## Use

```ts
// app.config.ts
import {provideTracing} from '@rekthor/ngx-otel-tracing';

export const appConfig: ApplicationConfig = {
  providers: [
    provideTracing({
      serviceName: 'my-app',
      serviceVersion: environment.version,
      environment: environment.name,
      collectorUrl: 'https://collector.example.com/v1/traces',
      sampleRate: 0.1,
      propagateTraceTo: ['https://api.example.com/'],
      enabled: environment.production,
    }),
  ],
};
```

### Options

| Option | Required | Default | Description |
|---|---|---|---|
| `serviceName` | yes | | `service.name` |
| `collectorUrl` | yes | | OTLP/HTTP traces endpoint |
| `serviceVersion`, `environment` | no | | `service.version`, `deployment.environment.name` |
| `sampleRate` | no | `1` | Share of **sessions** recorded (0 to 1) |
| `propagateTraceTo` | no | `[]` | URLs (string or RegExp) that receive the `traceparent` header. Their CORS policy must allow it. |
| `enabled` | no | `true` | When `false`, nothing is started |
| `headers` | no | | Extra OTLP headers. Visible in the browser: public ingest keys only. |
| `features` | no | all `true` | `router`, `errors`, `webVitals`, `longTasks`, `interactions` |
| `privacy` | no | see below | Sanitizing hooks |

`features.errors` replaces Angular's `ErrorHandler`. If your app has its own, set it to `false` and call
`inject(TracingService).recordError(error)` from yours.

### Privacy

Sanitizing runs on the spans right before they are exported.

```ts
privacy: {
  sanitizeUrl: url => url,                 // default: scrubUrl
  sanitizeErrorMessage: message => message, // default: scrub URLs in the text, truncate to 200 characters
  clickLabels: 'explicit',                 // or 'button-text'
}
```

- **`sanitizeUrl`** is applied to every URL attribute. The default (`scrubUrl`, also exported) drops the fragment,
  redacts query values and replaces UUID and all-digit path segments with `:id`.
- **`sanitizeErrorMessage`** is applied to the message of recorded exceptions.
- **`clickLabels`**: click spans are named from `data-trace-label` or `data-testid`. With `'button-text'`,
  the text of `<button>` elements is used too. Links, inputs and other content are never read. Put
  `data-trace-ignore` on an element (or an ancestor) to keep its text out in any case.
- The raw route URL is not sent, only the route template (e.g. `/admin/users/:id`).

The library adds no user attributes. A `session.id` is a random identifier kept in `sessionStorage`
for the tab and renewed after 30 minutes of inactivity.

### Naming clicks

Without help a click span is just `click`. Name it from your templates, so the trace shows what was clicked
without reading anything the user typed or sees:

```html
<!-- named "click Save order" -->
<button data-trace-label="Save order" (click)="save()">Mentés</button>

<!-- falls back to data-testid: named "click open-menu" -->
<button data-testid="open-menu" (click)="toggle()">…</button>
```

Use `data-trace-label` for a fixed, non-personal label. Never bind a value that comes from user data to it.

With `clickLabels: 'button-text'`, the text of every `<button>` becomes the name. This is fine when buttons carry
fixed UI strings, but not when a button shows a name or other personal data. Mark those with
`data-trace-ignore`: the element and everything inside it is then never read, even with `'button-text'`:

```html
<!-- the label shows the user's name: keep it out of the trace -->
<button data-trace-ignore (click)="toggleMenu()">{{ userName() }}</button>

<!-- also works on a container -->
<ul data-trace-ignore>
  @for (org of organizations(); track org.id) {
    <li><button (click)="switchTo(org)">{{ org.name }}</button></li>
  }
</ul>
```

Besides the name, every click span carries the clicked element's tag, `id`, `type`, `name` and
`data-testid`, plus the enclosing components (e.g. `ui.component_path = app-layout > app-page > app-button`).

## Programmatic use

`TracingService` has two methods for what automatic tracing cannot know about.

### Your own spans: `getTracer()`

Wrap a business operation (export, save, import) in a span to see how long it took and whether it failed.
The span joins the running page / navigation trace, or the `click` span that started it.

```ts
private readonly tracer = inject(TracingService).getTracer();

exportInvoices() {
  const span = this.tracer.startSpan('invoices.export', {
    attributes: {'export.format': 'xlsx'},
  });
  return this.api.export().pipe(
    tap({error: err => span.recordException(err)}),
    finalize(() => span.end()),
  );
}
```

HTTP requests made inside appear next to your span in the same trace. To nest them under it, start them
inside `context.with(trace.setSpan(context.active(), span), () => ...)` from `@opentelemetry/api`.

Attribute values are exported as given. Only URL attributes and exception messages are sanitized, so never put
names, e-mail addresses or other personal data into them.

### Errors you catch yourself: `recordError(error)`

Errors that you handle never reach Angular's `ErrorHandler`, so they are not recorded on their own. Report them
explicitly:

```ts
this.api.save(data).subscribe({
  error: err => {
    this.tracing.recordError(err);
    this.toast.error('Saving failed');
  },
});
```

A common place for this is an HTTP interceptor that turns errors into toasts. Recording server errors there
puts every failed API call into the trace without touching the call sites:

```ts
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const tracing = inject(TracingService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status >= 500) {
        tracing.recordError(err);
      }
      return throwError(() => err);
    }),
  );
};
```

If your app has its own `ErrorHandler`, set `features.errors` to `false` and call `recordError` from yours.

## How traces are structured

- A page load or navigation opens a root span that closes after one second without running child spans
  (at the latest after 30 seconds, or 15 seconds after the last child started).
- After it closes, its trace stays active for five minutes: late requests, errors and web vitals still land
  in it until the next navigation starts a new trace.
- A navigation that follows another within 1.5 seconds without user input is a redirect and becomes a child
  span instead of a new trace.
- Every root carries `idle_span.finish_reason`, and navigation roots carry a `previous_trace` link and a
  `previous_trace_id` attribute.

## License

MIT
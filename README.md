# ngx-otel-tracing (workspace)

Source repository of the `@rekthor/ngx-otel-tracing` Angular library. Usage and options are documented in
[`projects/ngx-otel-tracing/README.md`](projects/ngx-otel-tracing/README.md), which is also the npm page.

```bash
npm ci
npm test            # watch mode
npm run test:ci     # single run, headless Chrome
npm run build       # output in dist/ngx-otel-tracing
```

## Layout

- `projects/ngx-otel-tracing/src/lib/core` framework-free logic (page trace, session, sampling, privacy, noise filter).
- `projects/ngx-otel-tracing/src/lib/angular` Angular layer (`provideTracing`, router tracing, error handler).
- Only what `src/public-api.ts` exports is public.

## Release

1. Raise `version` in `projects/ngx-otel-tracing/package.json`.
2. Push a matching tag, e.g. `v0.1.0`. The `Publish` workflow tests, builds and publishes to npm.
3. Needs an `NPM_TOKEN` secret in the GitHub repository.
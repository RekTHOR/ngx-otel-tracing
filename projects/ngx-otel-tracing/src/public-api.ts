/*
 * Public API Surface of ngx-otel-tracing
 */

export {provideTracing} from './lib/angular/provide-tracing';
export {TracingService} from './lib/angular/tracing.service';
export type {TracingConfig, TracingFeatures, TracingPrivacy} from './lib/angular/tracing-config';
export {scrubUrl} from './lib/core/trace-privacy';

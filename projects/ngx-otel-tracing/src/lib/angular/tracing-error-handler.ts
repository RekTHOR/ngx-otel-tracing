import {ErrorHandler, inject, Injectable} from '@angular/core';
import {TracingService} from './tracing.service';

@Injectable()
export class TracingErrorHandler implements ErrorHandler {
  private readonly tracingService = inject(TracingService);

  handleError(error: unknown): void {
    console.error(error);
    this.tracingService.recordError(error);
  }
}

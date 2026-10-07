import {Attributes, Span} from '@opentelemetry/api';

const MAX_COMPONENT_PATH_DEPTH = 3;
const MAX_LABEL_LENGTH = 60;

export interface ClickTargetOptions {
  /**
   * Use the text of `<button>` elements as the label when no `data-trace-label` is set. Only enable it
   * when buttons carry fixed UI strings; links, inputs and other content are never read. An element
   * (or ancestor) with `data-trace-ignore` is never read.
   */
  readButtonText?: boolean;
}

/**
 * Describes a clicked element. A readable name comes from what the developer provides
 * (`data-trace-label`, then `data-testid`), optionally from button text, plus the chain of enclosing
 * custom elements (e.g. `app-login > app-button`). Other visible text is never read.
 */
export function describeClickTarget(element: HTMLElement, span: Span, options: ClickTargetOptions = {}): void {
  const control = element.closest<HTMLElement>('button, a, [role="button"]') ?? element;
  const explicit = element.closest<HTMLElement>('[data-trace-label]')?.dataset['traceLabel'];
  const label = (explicit ?? buttonText(control, options))?.slice(0, MAX_LABEL_LENGTH);

  const attributes: Attributes = {
    'ui.element.tag': control.tagName.toLowerCase(),
    'ui.element.id': control.id || undefined,
    'ui.element.type': control.getAttribute('type') ?? undefined,
    'ui.element.name': control.getAttribute('name') ?? control.getAttribute('formcontrolname') ?? undefined,
    'ui.element.test_id': element.closest<HTMLElement>('[data-testid]')?.dataset['testid'],
    'ui.element.label': label,
    'ui.component_path': componentPath(element),
  };
  span.setAttributes(attributes);

  const readable = label ?? (attributes['ui.element.test_id'] as string | undefined);
  if (readable) {
    span.updateName(`click ${readable}`);
  }
}

function buttonText(control: HTMLElement, options: ClickTargetOptions): string | undefined {
  if (!options.readButtonText || control.tagName !== 'BUTTON' || control.closest('[data-trace-ignore]')) {
    return undefined;
  }
  return control.textContent?.replace(/\s+/g, ' ').trim() || undefined;
}

/** Nearest enclosing custom elements (Angular component hosts), outermost first. */
function componentPath(element: HTMLElement): string {
  const hosts: string[] = [];
  for (let node: HTMLElement | null = element; node && hosts.length < MAX_COMPONENT_PATH_DEPTH; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (tag.includes('-') && tag !== 'app-root') {
      hosts.unshift(tag);
    }
  }
  return hosts.join(' > ');
}

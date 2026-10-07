import {Span} from '@opentelemetry/api';
import {describeClickTarget} from './trace-element';

describe('describeClickTarget', () => {
  let host: HTMLElement;
  let span: jasmine.SpyObj<Span>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    span = jasmine.createSpyObj<Span>('span', ['setAttributes', 'updateName']);
  });

  afterEach(() => host.remove());

  function render(html: string): HTMLElement {
    host.innerHTML = html;
    return host.querySelector('[data-target]') as HTMLElement;
  }

  function attributes(): Record<string, unknown> {
    return span.setAttributes.calls.mostRecent().args[0] as Record<string, unknown>;
  }

  it('names the span from data-trace-label', () => {
    const el = render('<button data-target data-trace-label="Save order" type="submit">Mentés</button>');
    describeClickTarget(el, span);
    expect(span.updateName).toHaveBeenCalledWith('click Save order');
    expect(attributes()['ui.element.label']).toBe('Save order');
    expect(attributes()['ui.element.type']).toBe('submit');
  });

  it('falls back to data-testid for the name', () => {
    const el = render('<div data-testid="open-menu"><button data-target>x</button></div>');
    describeClickTarget(el, span);
    expect(span.updateName).toHaveBeenCalledWith('click open-menu');
  });

  it('does not read button text by default', () => {
    const el = render('<button data-target>Kovács János</button>');
    describeClickTarget(el, span);
    expect(span.updateName).not.toHaveBeenCalled();
    expect(attributes()['ui.element.label']).toBeUndefined();
  });

  it('reads button text when enabled, collapsing whitespace', () => {
    const el = render('<button data-target>  Bejelentkezés \n  </button>');
    describeClickTarget(el, span, {readButtonText: true});
    expect(span.updateName).toHaveBeenCalledWith('click Bejelentkezés');
  });

  it('never reads text of links or non-button elements', () => {
    const link = render('<a data-target>Partner Kft.</a>');
    describeClickTarget(link, span, {readButtonText: true});
    expect(span.updateName).not.toHaveBeenCalled();
  });

  it('honors data-trace-ignore even with text reading enabled', () => {
    const el = render('<div data-trace-ignore><button data-target>Secret Name</button></div>');
    describeClickTarget(el, span, {readButtonText: true});
    expect(span.updateName).not.toHaveBeenCalled();
  });

  it('describes the enclosing component hosts, outermost first, skipping app-root', () => {
    const el = render(`
      <app-root><app-layout><app-page><app-button><button data-target>x</button></app-button></app-page></app-layout></app-root>`);
    describeClickTarget(el, span);
    expect(attributes()['ui.component_path']).toBe('app-layout > app-page > app-button');
  });
});

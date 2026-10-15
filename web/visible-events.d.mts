export interface VisibleEventOptions {
  document?: Document;
  window?: Window;
  EventSource?: typeof EventSource;
  keepInBackground?: boolean;
}

export type VisibleEventHandlers = Record<string, (event: MessageEvent<string>) => void>;

export function visibleEvents(
  url: string,
  handlers: VisibleEventHandlers,
  options?: VisibleEventOptions,
): { close(): void };

import { z } from 'zod';
import { visibleEvents, type VisibleEventOptions } from '../visible-events.mjs';

type EventSchemas = Record<string, z.ZodType>;
type EventHandlers<S extends EventSchemas> = {
  [K in keyof S]?: (payload: z.infer<S[K]>) => void;
};

/** Subscribe to named SSE events and validate each JSON payload before dispatch. */
export function subscribeEvents<S extends EventSchemas>(
  url: string,
  schemas: S,
  handlers: EventHandlers<S>,
  options: VisibleEventOptions = {},
): { close(): void } {
  const eventHandlers: Record<string, (event: MessageEvent<string>) => void> = {};
  function register<K extends keyof S & string>(name: K) {
    const schema: S[K] = schemas[name];
    const handler = handlers[name];
    if (!handler) return;
    eventHandlers[name] = event => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        console.error(`Invalid JSON in SSE event "${name}"`, event.data);
        return;
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        console.error(`Invalid payload in SSE event "${name}"`, z.treeifyError(parsed.error));
        return;
      }
      handler(parsed.data);
    };
  }
  for (const name in schemas) {
    if (Object.hasOwn(schemas, name)) register(name);
  }
  return visibleEvents(url, eventHandlers, options);
}

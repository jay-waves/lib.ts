// Shared transport only; each page owns its rendering and document state.
export function createClient() {
    const pageUrl = new URL(location.href);
    const base = new URL('.', pageUrl);
    const sessionId = pageUrl.searchParams.get('session') || 'default';
    const url = path => {
        const target = new URL(path.replace(/^\//, ''), base);
        target.searchParams.set('session', sessionId);
        return target.href;
    };
    const request = (input, options = {}) => {
        const headers = new Headers(options.headers || {});
        headers.set('X-Preview-Session', sessionId);
        return fetch(input, { ...options, headers });
    };
    return {
        url,
        fetch: request,
        async get(path) {
            const response = await request(url(path), { cache: 'no-store' });
            if (!response.ok) {
                const error = new Error(`Preview: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return response.json();
        },
        send(event, data) {
            return request(url(`/__live/event?event=${encodeURIComponent(event)}&data=${encodeURIComponent(JSON.stringify(data))}`),
                { cache: 'no-store', keepalive: true });
        },
        connect({ events, closeEvent, onClose, onOpen, onError }) {
            let closed = false;
            let controller;
            const close = () => { closed = true; controller?.abort(); };
            const connect = async () => {
                while (!closed) {
                    controller = new AbortController();
                    try {
                        const response = await request(url('/__live/events'), {
                            cache: 'no-store', headers: { accept: 'text/event-stream' }, signal: controller.signal,
                        });
                        if (!response.ok || !response.body) throw new Error(`Preview: HTTP ${response.status}`);
                        onOpen?.();
                        const reader = response.body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = '';
                        while (!closed) {
                            const { value, done } = await reader.read();
                            if (done) break;
                            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                            let split;
                            while ((split = buffer.indexOf('\n\n')) >= 0) {
                                const frame = buffer.slice(0, split);
                                buffer = buffer.slice(split + 2);
                                let name = 'message', data = '';
                                for (const line of frame.split('\n')) {
                                    if (line.startsWith('event:')) name = line.slice(6).trim();
                                    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
                                }
                                let value;
                                try { value = JSON.parse(data || '{}'); } catch (_) { continue; }
                                if (name === closeEvent) { close(); onClose?.(); return; }
                                events[name]?.(value);
                            }
                        }
                    } catch (error) {
                        if (closed) return;
                        onError?.(error);
                    }
                    if (!closed) await new Promise(resolve => setTimeout(resolve, 1000));
                }
            };
            void connect();
            return close;
        },
    };
}

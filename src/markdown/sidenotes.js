// Move markdown-it-footnote's collected definitions beside their first reference.
// The original footnote renderer still supplies reference links and back links.
export function sidenotes(md) {
        md.core.ruler.after('footnote_tail', 'sidenotes', state => {
            const tokens = state.tokens;
            const start = tokens.findIndex(token => token.type === 'footnote_block_open');
            if (start < 0) return;
            const end = tokens.findIndex((token, index) =>
                index > start && token.type === 'footnote_block_close');
            if (end < 0) return;

            const notes = new Map();
            let id = null;
            let body = [];
            for (let i = start + 1; i < end; i += 1) {
                const token = tokens[i];
                if (token.type === 'footnote_open') {
                    id = token.meta.id;
                    body = [];
                } else if (token.type === 'footnote_close') {
                    notes.set(id, body);
                    id = null;
                } else if (id !== null) {
                    body.push(token);
                }
            }
            tokens.splice(start, end - start + 1);

            const makeToken = (type, nesting, noteId) => {
                const token = new state.Token(type, 'aside', nesting);
                token.block = true;
                if (nesting === 1) {
                    token.attrSet('id', `fn${noteId + 1}`);
                    token.attrSet('role', 'doc-footnote');
                }
                return token;
            };
            const pending = [];
            const placed = new Set();
            const result = [];
            for (const token of tokens) {
                result.push(token);
                if (token.type === 'inline') {
                    for (const child of token.children || []) {
                        if (child.type === 'footnote_ref' && notes.has(child.meta.id)
                            && !placed.has(child.meta.id)) {
                            pending.push(child.meta.id);
                            placed.add(child.meta.id);
                        }
                    }
                }
                // Finish the containing top-level block before inserting an aside.
                if (pending.length && token.nesting === -1 && token.level === 0) {
                    for (const noteId of pending.splice(0)) {
                        result.push(makeToken('sidenote_open', 1, noteId),
                            ...notes.get(noteId), makeToken('sidenote_close', -1, noteId));
                    }
                }
            }
            state.tokens = result;
        });
}

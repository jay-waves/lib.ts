use rquickjs::{CatchResultExt, Context, Function, Object, Runtime};
use std::cell::OnceCell;

#[derive(Default)]
pub struct Engine(OnceCell<Result<Renderer, String>>);

struct Renderer {
    context: Context,
    _runtime: Runtime,
}

impl Renderer {
    fn new() -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(256 * 1024 * 1024);
        runtime.set_max_stack_size(4 * 1024 * 1024);
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|ctx| {
            ctx.eval::<(), _>(include_str!("../generated/render.js"))
                .catch(&ctx)
                .map_err(|e| format!("cannot initialize embedded renderers: {e}"))
        })?;
        Ok(Self {
            context,
            _runtime: runtime,
        })
    }

    fn render(
        &self,
        kind: &str,
        source: &str,
        language: &str,
        index: usize,
    ) -> Result<Option<String>, String> {
        let (error, html) = self.context.with(|ctx| {
            let result = (|| -> rquickjs::Result<_> {
                let function: Function = ctx.globals().get("renderFragment")?;
                let result: Object = function.call((kind, source, language, index as u32))?;
                Ok((
                    result.get::<_, Option<String>>("error")?,
                    result.get::<_, Option<String>>("html")?,
                ))
            })();
            result
                .catch(&ctx)
                .map_err(|e| format!("embedded JavaScript execution failed: {e}"))
        })?;
        error.map_or(Ok(html), Err)
    }
}

impl Engine {
    pub fn render(
        &self,
        kind: &str,
        source: &str,
        language: &str,
        index: usize,
    ) -> Result<Option<String>, String> {
        self.0
            .get_or_init(Renderer::new)
            .as_ref()
            .map_err(Clone::clone)?
            .render(kind, source, language, index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_is_initialized_on_demand() {
        let engine = Engine::default();
        let temp = tempfile::tempdir().unwrap();
        let attachments = crate::document::Attachments::new(
            &temp.path().join("a.md"),
            &temp.path().join("a.html"),
            temp.path().to_owned(),
            crate::cli::Images::Reference,
            false,
        )
        .unwrap();
        let html =
            crate::document::render("# Hello\n\n```\n<plain>\n```", &engine, &attachments).unwrap();
        assert!(html.contains("&lt;plain&gt;"));
        assert!(engine.0.get().is_none());
        engine.render("math", "x", "", 0).unwrap();
        assert!(matches!(engine.0.get(), Some(Ok(_))));
    }

    #[test]
    fn real_renderers_work_without_dom_or_node() {
        let engine = Engine::default();
        assert!(
            engine
                .render("math", "x^2", "", 0)
                .unwrap()
                .unwrap()
                .contains("katex")
        );
        assert!(
            engine
                .render("code", "const x = 1;", "js", 0)
                .unwrap()
                .unwrap()
                .contains("hljs-keyword")
        );
        let svg = engine
            .render(
                "diagram",
                "flowchart LR\n accTitle: Example\n A[Start] --> B[End]",
                "",
                1,
            )
            .unwrap()
            .unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("diagram-1"));
        assert!(engine.render("math", "\\unknowncommand", "", 0).is_err());
        assert!(engine.render("diagram", "not a diagram", "", 0).is_err());
        assert_eq!(
            engine.render("code", "hi", "unknown-language", 0).unwrap(),
            None
        );
    }
}

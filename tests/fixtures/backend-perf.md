---
title: Backend performance fixture
tags: [rust, markdown, benchmark]
---

# Rendering and parsing fixture

This shared document exercises **emphasis**, ~~strikethrough~~, `inline code`, [links](https://example.com), and math $a^2 + b^2 = c^2$.

## Tables and lists

| Name | Value | Notes |
|:-----|------:|:------|
| alpha | 1 | first row |
| beta | 2 | second row |

- [x] completed item
- [ ] pending item
  - nested item

> A block quote with enough text to exercise wrapping and source positions.

```rust
fn main() {
    println!("shared benchmark fixture");
}
```

## Repeated content

The quick brown fox jumps over the lazy dog. 0123456789. Markdown parsing should produce stable heading anchors and source line metadata.

## Another section

Footnote reference[^note].

[^note]: A footnote shared by all benchmark implementations.

#set page(width: 595pt, height: 842pt, margin: 48pt)
#set text(size: 10pt)

= Backend performance fixture

This shared Typst source exercises parsing, layout, navigation extraction, and SVG page export.

#table(
  columns: (1fr, 1fr, 2fr),
  [*Name*], [*Value*], [*Notes*],
  [alpha], [1], [first row],
  [beta], [2], [second row],
)

== Repeated content

#for i in range(80) [
  The quick brown fox jumps over the lazy dog. This line exercises text shaping and paragraph layout.
  #linebreak()
]

== Math and code

$ sum_(i=1)^n i = (n(n+1))/2 $

```rust
fn main() {
    println!("shared benchmark fixture");
}
```

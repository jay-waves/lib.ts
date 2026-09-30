if vim.g.loaded_markdown_preview then return end
vim.g.loaded_markdown_preview = true

local preview = require("node_preview")

vim.api.nvim_create_user_command("MarkdownPreview", function() preview.start("markdown") end,
    { desc = "Start or focus the Markdown preview" })
vim.api.nvim_create_user_command("MarkdownStop", function() preview.stop("markdown") end,
    { desc = "Stop the Markdown preview" })
vim.api.nvim_create_user_command("TypstPreview", function() preview.start("typst") end,
    { desc = "Start or focus the experimental JavaScript/WASM Typst preview" })
vim.api.nvim_create_user_command("TypstStop", function() preview.stop("typst") end,
    { desc = "Stop the experimental JavaScript/WASM Typst preview" })

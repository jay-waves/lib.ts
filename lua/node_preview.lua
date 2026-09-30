local M = {}
local config = { server_url = "http://127.0.0.1:49191", markdown = {}, typst = {} }
local typst_diagnostics = vim.api.nvim_create_namespace("node_preview_typst")
local owner
local pumpHttp

local function notify(message, level, kind)
    vim.notify(message, level or vim.log.levels.ERROR, { title = kind == "typst" and "Typst Preview" or "Markdown Preview" })
end

local function kind_for(buf)
    if not vim.api.nvim_buf_is_valid(buf) then return end
    local file = vim.api.nvim_buf_get_name(buf):lower()
    if file:match("%.md$") then return "markdown" end
    if file:match("%.typ$") then return "typst" end
end

local function snapshot(buf, kind, method)
    if not vim.api.nvim_buf_is_valid(buf) then return end
    local file = vim.api.nvim_buf_get_name(buf)
    if kind_for(buf) ~= kind then return end
    local value = {
        kind = kind, method = method, file = file, cwd = vim.fn.getcwd(), buffer = buf,
        revision = vim.api.nvim_buf_get_changedtick(buf),
        line = vim.api.nvim_get_current_buf() == buf and vim.api.nvim_win_get_cursor(0)[1] or 1,
    }
    if kind == "markdown" then
        local opts = config.markdown
        value.options = {
            click_to_nvim = opts.click_to_nvim, allow_raw_html = opts.allow_raw_html,
            custom_css = {},
        }
        local css = opts.custom_css or {}
        for _, path in ipairs(type(css) == "string" and { css } or css) do
            if path ~= "" then table.insert(value.options.custom_css, vim.fn.fnamemodify(vim.fn.expand(path), ":p")) end
        end
    end
    return value
end

local function send(ownerValue, value)
    if owner ~= ownerValue or not ownerValue.connected then return end
    local message = vim.tbl_extend("force", {}, value, { callbackUrl = ownerValue.callbackUrl })
    local ok = pcall(vim.json.encode, message)
    if not ok then return end
    ownerValue.http_queue = ownerValue.http_queue or {}
    if value.method == "cursor" or value.method == "dirty" then
        local index = #ownerValue.http_queue
        local queued = ownerValue.http_queue[index]
        if queued and queued.method == value.method and queued.kind == value.kind then
            ownerValue.http_queue[index] = message
            if pumpHttp then pumpHttp(ownerValue) end
            return
        end
    end
    ownerValue.http_queue[#ownerValue.http_queue + 1] = message
    if pumpHttp then pumpHttp(ownerValue) end
end

local function closeCallback(ownerValue)
    local server = ownerValue.callbackServer
    if server then
        ownerValue.callbackServer = nil
        pcall(server.close, server)
    end
end

local function options(kind)
    return vim.tbl_extend("force", config, config[kind] or {})
end

local function setTypstDiagnostics(event)
    local buf = event.buffer
    if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
    if vim.bo[buf].modified or vim.fs.normalize(vim.api.nvim_buf_get_name(buf)):lower()
        ~= vim.fs.normalize(event.file):lower() then return end
    local main_file = vim.fs.normalize(vim.api.nvim_buf_get_name(buf)):lower()
    local levels = { error = vim.diagnostic.severity.ERROR, warning = vim.diagnostic.severity.WARN,
        info = vim.diagnostic.severity.INFO, hint = vim.diagnostic.severity.HINT }
    local entries = {}
    for _, item in ipairs(event.diagnostics or {}) do
        local file = type(item.file) == "string" and item.file or event.file
        local same_file = type(file) == "string" and vim.fs.normalize(file):lower() == main_file
        local row, col, end_row, end_col
        if same_file and type(item.range) == "string" then
            row, col, end_row, end_col = item.range:match("^(%d+):(%d+)%-(%d+):(%d+)$")
        end
        local message = tostring(item.message or "Typst compilation failed")
        if not same_file and file then message = file .. ": " .. message end
        entries[#entries + 1] = { lnum = tonumber(row) or 0, col = tonumber(col) or 0,
            end_lnum = tonumber(end_row) or tonumber(row) or 0,
            end_col = tonumber(end_col) or tonumber(col) or 0,
            severity = levels[item.severity] or vim.diagnostic.severity.ERROR,
            message = message, source = "Typst" }
    end
    vim.diagnostic.reset(typst_diagnostics)
    vim.diagnostic.set(typst_diagnostics, buf, entries)
end

local function openBrowser(kind, url)
    local opts = options(kind)
    if opts.hooks and not opts.started then
        opts.started = true
        if opts.hooks.on_start then pcall(opts.hooks.on_start, url) end
    end
    if opts.open_browser == false then return end
    if opts.open_url then return opts.open_url(url) end
    if opts.browser then
        local command = type(opts.browser) == "table" and vim.deepcopy(opts.browser)
            or vim.fn.has("mac") == 1 and { "open", "-a", opts.browser } or { opts.browser }
        table.insert(command, url)
        if vim.fn.jobstart(command, { detach = true }) <= 0 then notify("Could not open browser: " .. url, nil, kind) end
    else
        vim.ui.open(url)
    end
end

local function clean(ownerValue)
    vim.diagnostic.reset(typst_diagnostics)
    if ownerValue.group then pcall(vim.api.nvim_del_augroup_by_id, ownerValue.group) end
    for _, timer in pairs(ownerValue.timers or {}) do
        timer:stop()
        timer:close()
    end
    for kind in pairs(ownerValue.views or {}) do
        local opts = options(kind)
        if opts.hooks and opts.hooks.on_stop then pcall(opts.hooks.on_stop) end
        opts.started = nil
    end
end

local function parseOutput(ownerValue, lines)
    local function receive(line)
        if line == "" then return end
        local ok, event = pcall(vim.json.decode, line)
        if not ok or type(event) ~= "table" then return end
        local kind = event.kind
        if event.event == "ready" then
            ownerValue.baseUrl = event.baseUrl
            if pumpHttp then pumpHttp(ownerValue) end
        elseif event.event == "open" and kind and ownerValue.views[kind] then
            ownerValue.urls[kind] = event.url
            openBrowser(kind, event.url)
        elseif event.event == "jump" and kind and ownerValue.views[kind] then
            if kind == "typst" and ownerValue.typst_failed then return end
            local buf = event.buffer or ownerValue.buffers[kind]
            if vim.api.nvim_buf_is_valid(buf) and not vim.bo[buf].modified
                and vim.fs.normalize(vim.api.nvim_buf_get_name(buf)):lower() == vim.fs.normalize(event.file):lower() then
                local line = math.max(1, math.min(event.line or 1, vim.api.nvim_buf_line_count(buf)))
                local win = vim.fn.win_findbuf(buf)[1]
                if win then
                    vim.api.nvim_win_set_cursor(win, { line, 0 })
                    vim.api.nvim_win_call(win, function() vim.cmd("normal! zz") end)
                end
            end
        elseif event.event == "theme" and kind then
            local opts = options(kind)
            if opts.on_theme_change then pcall(opts.on_theme_change, event.theme, event.file) end
        elseif event.event == "diagnostics" and kind == "typst" and ownerValue.views.typst
            and event.buffer == ownerValue.buffers.typst then
            ownerValue.typst_failed = false
            for _, item in ipairs(event.diagnostics or {}) do
                if item.severity == "error" then ownerValue.typst_failed = true; break end
            end
            setTypstDiagnostics(event)
        elseif event.event == "memory" then
            vim.notify(string.format("%s: RSS %.1f MiB · heap %.1f · external %.1f · buffers %.1f",
                event.stage, event.rssMiB, event.heapMiB, event.externalMiB, event.arrayBuffersMiB),
                vim.log.levels.INFO, { title = "Typst WASM Memory" })
        elseif event.event == "notice" then
            notify(event.message or "Preview error", nil, kind)
        elseif event.event == "stopped" and kind then
            ownerValue.views[kind] = nil
            if kind == "typst" then
                ownerValue.typst_failed = false
                vim.diagnostic.reset(typst_diagnostics)
            end
        end
    end

    for index, line in ipairs(lines) do
        line = (index == 1 and ownerValue.pending or "") .. line
        if index < #lines then receive(line) else ownerValue.pending = line end
    end
end

local function startCallback(ownerValue)
    local uv = vim.uv or vim.loop
    local server = uv.new_tcp()
    local ok, errorMessage = pcall(function()
        server:bind("127.0.0.1", 0)
        server:listen(32, function(err)
            if err then return end
            local client = uv.new_tcp()
            server:accept(client)
            local raw, handled = "", false
            local function respond(status)
                if handled then return end
                handled = true
                pcall(client.read_stop, client)
                pcall(client.write, client, "HTTP/1.1 " .. status .. "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                vim.defer_fn(function() pcall(client.close, client) end, 20)
            end
            client:read_start(function(readErr, data)
                if handled then return end
                if readErr then return respond("400 Bad Request") end
                if not data then return respond("400 Bad Request") end
                raw = raw .. data
                local boundary = raw:find("\r\n\r\n", 1, true)
                if not boundary then return end
                local headers = raw:sub(1, boundary - 1):lower()
                local bodyStart = boundary + 4
                local length = tonumber(headers:match("content%-length:%s*(%d+)"))
                local body
                if length then
                    if #raw < bodyStart + length - 1 then return end
                    body = raw:sub(bodyStart, bodyStart + length - 1)
                elseif headers:find("transfer%-encoding:%s*chunked") then
                    local chunks, position = {}, bodyStart
                    while true do
                        local lineEnd = raw:find("\r\n", position, true)
                        if not lineEnd then return end
                        local size = tonumber(raw:sub(position, lineEnd - 1):match("^%s*([%da-fA-F]+)"), 16)
                        if not size then return respond("400 Bad Request") end
                        if size == 0 then body = table.concat(chunks); break end
                        local chunkStart, chunkEnd = lineEnd + 2, lineEnd + 1 + size
                        if #raw < chunkEnd + 2 then return end
                        chunks[#chunks + 1] = raw:sub(chunkStart, chunkEnd)
                        position = chunkEnd + 3
                    end
                else
                    return
                end
                local decoded, event = pcall(vim.json.decode, body)
                if decoded and type(event) == "table" then
                    vim.schedule(function()
                        if owner == ownerValue then parseOutput(ownerValue, { vim.json.encode(event), "" }) end
                    end)
                    respond("204 No Content")
                else
                    respond("400 Bad Request")
                end
            end)
        end)
    end)
    if not ok then
        pcall(server.close, server)
        notify("Could not open the local preview callback: " .. tostring(errorMessage))
        return false
    end
    local address = server:getsockname()
    ownerValue.callbackServer = server
    ownerValue.callbackUrl = "http://127.0.0.1:" .. address.port .. "/"
    return true
end

pumpHttp = function(ownerValue)
    if (owner ~= ownerValue and not ownerValue.stopping) or ownerValue.http_busy or not ownerValue.baseUrl then return end
    local value = table.remove(ownerValue.http_queue or {}, 1)
    if not value then return end
    local encodedOk, body = pcall(vim.json.encode, value)
    if not encodedOk then notify("Could not encode preview request"); return end
    local port = ownerValue.baseUrl:match("^http://127%.0%.0%.1:(%d+)$")
    if not port then notify("Invalid preview service URL"); return end
    local uv = vim.uv or vim.loop
    local client = uv.new_tcp()
    ownerValue.http_busy = true
    local chunks, completed = {}, false
    local function finish(errorMessage, status, responseBody)
        if completed then return end
        completed = true
        pcall(client.read_stop, client)
        pcall(client.close, client)
        vim.schedule(function()
            ownerValue.http_busy = false
            if errorMessage and owner == ownerValue and not ownerValue.stopping then
                notify("Preview HTTP request failed: " .. errorMessage)
            elseif status and status >= 400 and owner == ownerValue and not ownerValue.stopping then
                local ok, result = pcall(vim.json.decode, responseBody or "")
                notify(ok and result.error or ("Preview service returned HTTP " .. status))
            end
            if (errorMessage or (status and status >= 400)) and owner == ownerValue then
                owner = nil
                ownerValue.http_queue = {}
                clean(ownerValue)
                closeCallback(ownerValue)
                return
            end
            if pumpHttp then pumpHttp(ownerValue) end
        end)
    end
    client:connect("127.0.0.1", tonumber(port), function(err)
        if err then return finish(tostring(err)) end
        client:read_start(function(readErr, data)
            if readErr then return finish(tostring(readErr)) end
            if data then chunks[#chunks + 1] = data; return end
            local response = table.concat(chunks)
            local boundary = response:find("\r\n\r\n", 1, true)
            local status = tonumber(response:match("^HTTP/%d%.%d%s+(%d+)"))
            finish(nil, status, boundary and response:sub(boundary + 4) or "")
        end)
        local request = table.concat({
            "POST /__control HTTP/1.1\r\n",
            "Host: 127.0.0.1:" .. port .. "\r\n",
            "X-Preview-Session: " .. ownerValue.sessionId .. "\r\n",
            "Content-Type: application/json\r\n",
            "Content-Length: " .. #body .. "\r\n",
            "Connection: close\r\n\r\n",
            body,
        })
        client:write(request, function(writeErr)
            if writeErr then finish(tostring(writeErr)) end
        end)
    end)
end

local function sendSnapshot(kind, buf, method)
    if not vim.api.nvim_buf_is_valid(buf) then return end
    if kind == "markdown" and method == "dirty" then
        send(owner, { kind = kind, method = method, file = vim.api.nvim_buf_get_name(buf), cwd = vim.fn.getcwd(),
            modified = vim.bo[buf].modified })
        return
    end
    local value = snapshot(buf, kind, method)
    if not value then return end
    if kind == "typst" then
        if vim.bo[buf].modified or vim.fn.filereadable(value.file) ~= 1 then return end
        value.method = "open"
    end
    send(owner, value)
end

local function connectService()
    local baseUrl = tostring(config.server_url or ""):gsub("/+$", "")
    if not baseUrl:match("^http://127%.0%.0%.1:%d+$") then
        notify("server_url must use http://127.0.0.1:<port>")
        return false
    end
    local uv = vim.uv or vim.loop
    local random = ""
    if uv.random then
        local ok, value = pcall(uv.random, 32)
        if ok then random = value end
    end
    if random == "" then random = tostring(uv.hrtime()) .. tostring({}) .. tostring(math.random()) end
    local sessionId = vim.fn.sha256(random .. tostring(vim.fn.getpid()) .. tostring({}))
    local current = { connected = true, baseUrl = baseUrl, sessionId = sessionId, pending = "", views = {}, buffers = {}, urls = {}, timers = {}, typst_failed = false,
        http_queue = {} }
    owner = current
    if not startCallback(current) then owner = nil; return false end
    current.group = vim.api.nvim_create_augroup("NodePreview", { clear = true })
    local function sendFor(args, method)
        if owner ~= current then return end
        local kind = kind_for(args.buf)
        if kind and current.views[kind] and current.buffers[kind] == args.buf then sendSnapshot(kind, args.buf, method) end
    end
    vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufModifiedSet" }, {
        group = current.group, pattern = { "*.[mM][dD]" }, callback = function(args)
            sendFor(args, "dirty")
        end,
    })
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
        group = current.group, pattern = { "*.[mM][dD]", "*.[tT][yY][pP]" }, callback = function(args)
            if owner ~= current then return end
            local kind = kind_for(args.buf)
            if kind and current.views[kind] and current.buffers[kind] == args.buf then
                send(current, { method = "cursor", kind = kind, file = vim.api.nvim_buf_get_name(args.buf),
                    cwd = vim.fn.getcwd(), line = vim.api.nvim_win_get_cursor(0)[1] })
            end
        end,
    })
    vim.api.nvim_create_autocmd("BufEnter", {
        group = current.group, pattern = { "*.[mM][dD]", "*.[tT][yY][pP]" }, callback = function(args)
            vim.schedule(function()
                if owner ~= current or vim.api.nvim_get_current_buf() ~= args.buf then return end
                local kind = kind_for(args.buf)
                if kind and current.views[kind] then
                    current.buffers[kind] = args.buf
                    sendSnapshot(kind, args.buf, "activate")
                end
            end)
        end,
    })
    vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout" }, {
        group = current.group, pattern = { "*.[mM][dD]", "*.[tT][yY][pP]" }, callback = function(args)
            if owner ~= current then return end
            local kind = kind_for(args.buf)
            if kind and current.views[kind] and current.buffers[kind] == args.buf then M.stop(kind) end
        end,
    })
    vim.api.nvim_create_autocmd("VimLeavePre", { group = current.group, once = true, callback = function() M.shutdown(true) end })
    return true
end

function M.setup(opts)
    opts = opts or {}
    config = vim.tbl_deep_extend("force", config, opts)
end

function M.setup_markdown(opts)
    config.markdown = vim.tbl_deep_extend("force", config.markdown or {}, opts or {})
end

function M.setup_typst(opts)
    config.typst = vim.tbl_deep_extend("force", config.typst or {}, opts or {})
end

function M.start(kind)
    kind = kind or "typst"
    local buf = vim.api.nvim_get_current_buf()
    local doc = snapshot(buf, kind, "open")
    if not doc then return notify(kind == "typst" and "Open a named .typ buffer first" or "Open a named .md buffer first", nil, kind) end
    if kind == "typst" and (vim.bo[buf].modified or vim.fn.filereadable(doc.file) ~= 1) then
        return notify("Open a saved, unmodified .typ buffer before starting Typst WASM preview", nil, kind)
    end
    if owner and owner.views[kind] then
        send(owner, { method = "focus", kind = kind, cwd = vim.fn.getcwd(), file = doc.file })
        return
    end
    if kind == "typst" then vim.diagnostic.reset(typst_diagnostics) end
    if not owner and not connectService() then return end
    owner.views[kind] = true
    if kind == "typst" then owner.typst_failed = false end
    owner.buffers[kind] = buf
    doc.method = "open"
    send(owner, doc)
end

function M.stop(kind, exiting)
    kind = kind or "typst"
    local current = owner
    if not current or not current.views[kind] then return end
    current.views[kind] = nil
    if kind == "typst" then
        current.typst_failed = false
        vim.diagnostic.reset(typst_diagnostics)
    end
    current.buffers[kind] = nil
    local timer = current.timers[kind]
    if timer then timer:stop(); timer:close(); current.timers[kind] = nil end
    send(current, { method = "stop", kind = kind })
    local opts = options(kind)
    if opts.hooks and opts.hooks.on_stop then pcall(opts.hooks.on_stop) end
    opts.started = nil
    if not next(current.views) then
        current.stopping = true
        send(current, { method = "detach" })
        owner = nil
        clean(current)
        closeCallback(current)
    end
end

function M.shutdown(exiting)
    local current = owner
    if not current then return end
    current.stopping = true
    for kind in pairs(current.views) do send(current, { method = "stop", kind = kind }) end
    send(current, { method = "detach" })
    owner = nil
    clean(current)
    closeCallback(current)
end

return M

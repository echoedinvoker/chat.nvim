local M = {}

local job_id = nil
local pending = {} -- id -> {callback, created_at}
local next_id = 1
local partial_line = ""
local restart_count = 0
local MAX_RESTARTS = 3
local PENDING_TIMEOUT_SEC = 10

local notification_handler = nil -- fn(method, params)

local function get_sidecar_path()
  local source = debug.getinfo(1, "S").source:sub(2)
  local plugin_root = vim.fn.fnamemodify(source, ":h:h:h")
  return plugin_root .. "/sidecar/src/index.ts"
end

local function flush_pending_on_exit()
  for id, entry in pairs(pending) do
    if entry.callback then
      entry.callback(nil, "sidecar_exited")
    end
  end
  pending = {}
end

local function sweep_stale_pending()
  local now = vim.loop.now() / 1000
  local stale = {}
  for id, entry in pairs(pending) do
    if now - entry.created_at > PENDING_TIMEOUT_SEC then
      table.insert(stale, id)
    end
  end
  for _, id in ipairs(stale) do
    local entry = pending[id]
    pending[id] = nil
    if entry.callback then
      entry.callback(nil, "timeout")
    end
  end
end

local function is_notification(obj)
  -- JSON null decodes to vim.NIL, not Lua nil
  return obj.id == nil or obj.id == vim.NIL
end

local function dispatch_message(obj)
  if is_notification(obj) then
    if notification_handler and obj.method then
      notification_handler(obj.method, obj.params or {})
    end
  else
    -- Response to a request (id is a non-null integer)
    sweep_stale_pending()
    local entry = pending[obj.id]
    if entry then
      pending[obj.id] = nil
      if obj.error then
        entry.callback(nil, obj.error.message or "unknown error")
      else
        entry.callback(obj.result, nil)
      end
    end
  end
end

local function on_stdout(_, data, _)
  -- data is an array of strings split on \n by nvim.
  -- Last element is "" if the chunk ended with \n, otherwise it's a partial line.
  if not data then return end

  for i, chunk in ipairs(data) do
    if i == 1 then
      chunk = partial_line .. chunk
      partial_line = ""
    end

    if i == #data then
      -- Last element: if not empty, it's a partial (line didn't end with \n yet)
      if chunk ~= "" then
        partial_line = chunk
      end
    else
      -- Complete line
      if chunk ~= "" then
        local ok, obj = pcall(vim.json.decode, chunk)
        if ok and type(obj) == "table" then
          dispatch_message(obj)
        end
      end
    end
  end
end

local function on_stderr(_, data, _)
  if not data then return end
  for _, line in ipairs(data) do
    if line ~= "" then
      -- stderr goes to nvim's message log for debugging
      -- But we must NOT use vim.notify/print (cmdline pollution).
      -- Log to a file instead.
      local logfile = vim.fn.stdpath("log") .. "/chat-nvim.log"
      local f = io.open(logfile, "a")
      if f then
        f:write(os.date("%H:%M:%S") .. " [sidecar] " .. line .. "\n")
        f:close()
      end
    end
  end
end

local function on_exit(_, code, _)
  vim.schedule(function()
    flush_pending_on_exit()
    job_id = nil
    partial_line = ""

    if notification_handler then
      notification_handler("disconnected", { reason = "sidecar exited with code " .. code })
    end

    -- Auto-restart with exponential backoff
    if code ~= 0 and restart_count < MAX_RESTARTS then
      restart_count = restart_count + 1
      local delay_ms = 1000 * (2 ^ (restart_count - 1)) -- 1s, 2s, 4s
      vim.defer_fn(function()
        M.start()
      end, delay_ms)
    end
  end)
end

function M.start()
  if job_id then return end

  local sidecar_path = get_sidecar_path()
  job_id = vim.fn.jobstart({ "bun", "run", sidecar_path }, {
    on_stdout = on_stdout,
    on_stderr = on_stderr,
    on_exit = on_exit,
    stdout_buffered = false,
  })

  if job_id <= 0 then
    job_id = nil
    return false
  end

  restart_count = 0
  return true
end

function M.stop()
  if not job_id then return end
  vim.fn.jobstop(job_id)
  -- on_exit callback will clean up
end

function M.send(method, params, callback)
  if not job_id then
    if callback then callback(nil, "sidecar not running") end
    return
  end

  local id = next_id
  next_id = next_id + 1

  if callback then
    pending[id] = {
      callback = callback,
      created_at = vim.loop.now() / 1000,
    }
  end

  local msg = vim.json.encode({ id = id, method = method, params = params or {} })
  vim.fn.chansend(job_id, msg .. "\n")
end

function M.set_notification_handler(handler)
  notification_handler = handler
end

function M.is_running()
  return job_id ~= nil
end

return M

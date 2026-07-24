-- chatmux nvim consumer UX spike (throwaway)
-- Usage: :source /tmp/claude-1000/.../scratchpad/chatmux-spike.lua
--        :ChatOpen line:u0000000000000000000000000000000f
--        c  → floating composer → type → Esc → Enter to send
--        :ChatClose

local SCRATCHPAD = '/tmp/claude-1000/-home-matt-zettelkasten/3e783028-ec3e-41d1-80a2-a53dfd4ddb16/scratchpad'
local SIDECAR = SCRATCHPAD .. '/chatmux-sidecar.ts'
local SEND_SCRIPT = SCRATCHPAD .. '/chatmux-send.ts'

local job_id = nil
local buf = nil
local messages = {}
local chat_id = nil

local function status(_) end
local function status_echo(msg)
  vim.api.nvim_echo({ { msg, 'Comment' } }, false, {})
end

local function format_message(msg)
  local lines = {}
  local sender = (msg.sender and msg.sender.display_name) or 'Unknown'
  local text = ''
  if msg.content then
    if msg.content.type == 'text' then
      text = msg.content.text or ''
    else
      text = '[' .. (msg.content.type or 'unknown') .. ']'
    end
  end
  local ts = msg.timestamp and os.date('%H:%M', msg.timestamp / 1000) or '??:??'
  table.insert(lines, '')
  table.insert(lines, '## ' .. sender .. '  ' .. ts)
  for line in (text .. '\n'):gmatch('(.-)\n') do
    table.insert(lines, line)
  end
  return lines
end

local function render_messages(msgs)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  messages = msgs
  local lines = { '# chatmux — ' .. (chat_id or '?') }
  for _, msg in ipairs(msgs) do
    for _, l in ipairs(format_message(msg)) do
      table.insert(lines, l)
    end
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  local win = vim.fn.bufwinid(buf)
  if win ~= -1 then
    vim.api.nvim_win_set_cursor(win, { #lines, 0 })
  end
end

local function append_messages(new_msgs)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  local existing = {}
  for _, m in ipairs(messages) do existing[m.id] = true end

  local to_add = {}
  for _, m in ipairs(new_msgs) do
    if not existing[m.id] then
      table.insert(to_add, m)
      table.insert(messages, m)
    end
  end
  if #to_add == 0 then return end

  -- H2: save cursor
  local current_win = vim.api.nvim_get_current_win()
  local cursor, at_bottom = nil, false
  if vim.api.nvim_win_get_buf(current_win) == buf then
    cursor = vim.api.nvim_win_get_cursor(current_win)
    at_bottom = cursor[1] >= vim.api.nvim_buf_line_count(buf) - 2
  end

  local lines = {}
  for _, msg in ipairs(to_add) do
    for _, l in ipairs(format_message(msg)) do
      table.insert(lines, l)
    end
  end

  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, -1, -1, false, lines)
  vim.bo[buf].modifiable = false

  -- H2: only auto-scroll if user was at bottom
  if at_bottom then
    vim.api.nvim_win_set_cursor(current_win, { vim.api.nvim_buf_line_count(buf), 0 })
  elseif cursor then
    pcall(vim.api.nvim_win_set_cursor, current_win, cursor)
  end
end

local function handle_event(event)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  if event.type == 'init' then
    render_messages(event.data.messages or {})
    status('[chatmux] loaded ' .. #(event.data.messages or {}) .. ' messages')
  elseif event.type == 'update' then
    append_messages(event.data.messages or {})
    status('[chatmux] new message')
  end
end

local function send_message(text)
  status_echo '[chatmux] sending...'
  vim.system({ 'bun', 'run', SEND_SCRIPT, chat_id, text }, {}, function(result)
    vim.schedule(function()
      if result.code == 0 then
        status_echo '[chatmux] sent'
      else
        status_echo('[chatmux] SEND FAILED: ' .. (result.stderr or ''))
      end
    end)
  end)
end

local function compose()
  if not chat_id then
    status '[chatmux] no chat open'
    return
  end
  local width = math.floor(vim.o.columns * 0.6)
  local height = 5
  local row = vim.o.lines - height - 4
  local col = math.floor((vim.o.columns - width) / 2)

  local cbuf = vim.api.nvim_create_buf(false, true)
  vim.bo[cbuf].buftype = 'nofile'
  vim.bo[cbuf].filetype = 'markdown'

  local cwin = vim.api.nvim_open_win(cbuf, true, {
    relative = 'editor',
    width = width,
    height = height,
    row = row,
    col = col,
    style = 'minimal',
    border = 'rounded',
    title = ' compose ',
    title_pos = 'center',
  })
  vim.cmd 'startinsert'

  local function do_send()
    local lines = vim.api.nvim_buf_get_lines(cbuf, 0, -1, false)
    local text = vim.fn.trim(table.concat(lines, '\n'))
    if text == '' then return end
    if vim.api.nvim_win_is_valid(cwin) then vim.api.nvim_win_close(cwin, true) end
    send_message(text)
  end

  local function cancel()
    if vim.api.nvim_win_is_valid(cwin) then vim.api.nvim_win_close(cwin, true) end
  end

  vim.keymap.set('n', '<CR>', do_send, { buffer = cbuf })
  vim.keymap.set('n', 'q', cancel, { buffer = cbuf })
  vim.keymap.set('n', '<Esc>', cancel, { buffer = cbuf })
  vim.keymap.set('i', '<C-CR>', function()
    vim.cmd 'stopinsert'
    do_send()
  end, { buffer = cbuf })
end

local function start_sidecar(id)
  job_id = vim.fn.jobstart({ 'bun', 'run', SIDECAR, id }, {
    on_stdout = function(_, data, _)
      for _, line in ipairs(data) do
        if line ~= '' then
          local ok, event = pcall(vim.json.decode, line)
          if ok then vim.schedule(function() handle_event(event) end) end
        end
      end
    end,
    on_stderr = function() end,
    on_exit = function(_, code, _)
      vim.schedule(function()
        status('[chatmux] sidecar exited: ' .. code)
      end)
    end,
    stdout_buffered = false,
  })
end

local function chat_open(id)
  chat_id = id
  buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].modifiable = false
  vim.api.nvim_buf_set_name(buf, 'chatmux://' .. id)
  vim.api.nvim_set_current_buf(buf)
  vim.keymap.set('n', 'c', compose, { buffer = buf, desc = 'Compose message' })
  start_sidecar(id)
end

local function chat_close()
  if job_id then vim.fn.jobstop(job_id); job_id = nil end
  if buf and vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_delete(buf, { force = true })
  end
  buf, chat_id, messages = nil, nil, {}
end

vim.api.nvim_create_user_command('ChatOpen', function(opts) chat_open(opts.args) end,
  { nargs = 1, desc = 'Open chatmux chat buffer' })
vim.api.nvim_create_user_command('ChatClose', function() chat_close() end,
  { desc = 'Close chatmux chat buffer' })
vim.api.nvim_create_user_command('ChatCompose', compose,
  { desc = 'Open floating composer' })

status '[chatmux-spike] loaded. :ChatOpen <chat_id> to start'

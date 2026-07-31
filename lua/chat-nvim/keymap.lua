local M = {}

function M.set_chat_list_keymaps(bufnr)
  local opts = { buffer = bufnr, nowait = true, silent = true }

  vim.keymap.set("n", "<CR>", function()
    local state = require("chat-nvim.state")
    local line = vim.api.nvim_win_get_cursor(0)[1]
    if line >= 1 and line <= #state.chats then
      require("chat-nvim.ui.messages").open(state.chats[line].id)
    end
  end, opts)

  vim.keymap.set("n", "q", function()
    require("chat-nvim").close_ui()
  end, opts)

  vim.keymap.set("n", "R", function()
    require("chat-nvim").refresh_chats()
  end, opts)
end

function M.set_messages_keymaps(bufnr)
  local opts = { buffer = bufnr, nowait = true, silent = true }

  vim.keymap.set("n", "c", function()
    require("chat-nvim.ui.composer").open()
  end, opts)

  vim.keymap.set("n", "q", function()
    require("chat-nvim.ui.messages").close()
  end, opts)

  -- `o` is open-line in vim, but this buffer is modifiable = false, so the built-in only
  -- ever beeped here. Overwriting it takes nothing away.
  vim.keymap.set("n", "o", function()
    require("chat-nvim.ui.attachment").open_at_cursor()
  end, opts)

  -- `[` is a built-in prefix ([[, [m, ...), so without the nowait already in opts Neovim
  -- would sit out timeoutlen waiting to see if a second key follows.
  vim.keymap.set("n", "[", function()
    local state = require("chat-nvim.state")
    if state.current_chat then
      require("chat-nvim.ui.messages").load_older(state.current_chat)
    end
  end, opts)
end

function M.set_search_keymaps(bufnr)
  local opts = { buffer = bufnr, nowait = true, silent = true }

  vim.keymap.set("n", "<CR>", function()
    require("chat-nvim.ui.search").jump(vim.api.nvim_win_get_cursor(0)[1])
  end, opts)

  local function close()
    require("chat-nvim.ui.search").close()
  end
  vim.keymap.set("n", "q", close, opts)
  vim.keymap.set("n", "<Esc>", close, opts)
end

function M.set_composer_keymaps(bufnr, on_send, on_cancel)
  local opts = { buffer = bufnr, nowait = true, silent = true }

  vim.keymap.set("n", "<CR>", on_send, opts)
  vim.keymap.set("n", "<Esc>", on_cancel, opts)
end

return M

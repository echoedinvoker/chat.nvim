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
end

function M.set_composer_keymaps(bufnr, on_send, on_cancel)
  local opts = { buffer = bufnr, nowait = true, silent = true }

  vim.keymap.set("n", "<CR>", on_send, opts)
  vim.keymap.set("n", "<Esc>", on_cancel, opts)
end

return M

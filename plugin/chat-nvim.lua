if vim.g.loaded_chat_nvim then
  return
end
vim.g.loaded_chat_nvim = true

require("chat-nvim").setup()

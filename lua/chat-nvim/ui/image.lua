--- The one place chat.nvim touches image.nvim.
---
--- Everything above this file deals in specs — plain tables of `{ id, path, row, height }`
--- — and nothing above it knows that image.nvim exists. That is what makes the placement
--- logic testable without a terminal: `M.plan` is pure, and `M.set_renderer` lets a
--- headless check swap the real renderer for one that only records what it was asked to
--- draw (see scripts/f35-image-spec-check.lua).
---
--- Signatures here are pinned against the installed source, not the README
--- (image.nvim @ 88351f1f, lua/image/image.lua and lua/types.lua):
---
---   * `y` is a 0-based buffer row — it is handed straight to nvim_buf_set_extmark
---     (image.lua:134). The README's `y = 1` example is the second line, not the top.
---   * `width`/`height` are in terminal cells, not pixels (renderer.lua:46-47).
---   * `with_virtual_padding = true` implies `inline = true` (image.lua:309), but not the
---     other way round: passing `inline` alone reserves no virtual lines, so the image
---     lands on top of the text below it. That is the R9 misalignment, at its source.

local M = {}

--- Rendered height in terminal cells, by content type. Fixed rather than derived from the
--- image's own dimensions so that a page's line count is knowable before any image has
--- been measured — Lua has to reserve the space while `magick` is still working.
local HEIGHT = {
  sticker = 6,
  image = 12,
}

--- Default renderer: a thin adapter over image.nvim. Swapped out in tests.
local default_renderer = {
  create = function(spec, bufnr, winnr)
    local ok, api = pcall(require, "image")
    if not ok then return nil end
    return api.from_file(spec.path, {
      id = spec.id,
      window = winnr,
      buffer = bufnr,
      with_virtual_padding = true,
      x = 0,
      y = spec.row,
      height = spec.height,
    })
  end,
  render = function(img) img:render() end,
  clear = function(img) img:clear() end,
}

local renderer = default_renderer
local live = {}   -- spec id -> image handle, so a redraw can clear what it replaces

function M.set_renderer(r)
  renderer = r or default_renderer
end

function M.height_for(content_type)
  return HEIGHT[content_type]
end

--- Where every ready image goes, given the lines format_messages produced.
---
--- Pure: takes the messages and the row each one's header landed on, returns specs. No
--- buffer, no window, no image.nvim. `rows[i]` is the 0-based buffer row of message i's
--- `## sender time` header, so the image sits one line below it — the same line the
--- message body occupies, which is what the reserved virtual lines are for.
---
--- Messages without `media.state == "ready"` produce no spec at all. `pending` and `gone`
--- already carry their wording in `text`; drawing nothing for them is correct, and saying
--- something about them here would be Lua inventing copy that belongs to the sidecar.
function M.plan(messages, rows)
  local specs = {}
  for i, msg in ipairs(messages) do
    local media = msg.media
    if media and media ~= vim.NIL and media.state == "ready" and media.path then
      local height = HEIGHT[msg.content_type or "image"] or HEIGHT.image
      table.insert(specs, {
        id = msg.id,
        path = media.path,
        row = rows[i] + 1,
        height = height,
      })
    end
  end
  return specs
end

--- Draws a planned set, replacing whatever was drawn before.
---
--- Clearing first is not a tidiness habit: image.nvim keys its extmarks on
--- buffer:row:col (image.lua:105), so an image left behind from the previous draw keeps
--- reserving lines at a row that now holds different text.
function M.apply(specs, bufnr, winnr)
  for _, img in pairs(live) do
    pcall(renderer.clear, img)
  end
  live = {}

  for _, spec in ipairs(specs) do
    local ok, img = pcall(renderer.create, spec, bufnr, winnr)
    if ok and img then
      live[spec.id] = img
      pcall(renderer.render, img)
    end
  end
end

--- Test seam: what is currently on screen, by spec id.
function M.rendered()
  return live
end

return M

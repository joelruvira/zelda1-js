-- Zelda per-frame tracer for Mesen2 (--testrunner). Generated parameters are prepended by
-- tools/oracle-mesen/lib/mesen.mjs as `local P = {...}`; do not run this file on its own.
--
-- Frame definition (same as the jsnes oracle, docs/ORACLE.md):
--   frame 0  = state at the entry of the first NMI (exec callback on the NMI handler's first opcode)
--   frame N  = state when the N-th RTI of IsrNmi is fetched (exec callback on the RTI opcode)
--   input    = movie[n-1] is presented to the pad when the n-th NMI handler starts (nmi timing) and is
--              re-applied after every Mesen input poll (scanline 241) until the next NMI
--   picture  = first video frame completed (endFrame event) after the snapshot of frame N
--
-- Stream protocol (little-endian) written to P.fifo:
--   'F' u32 frame u32 nmiVideo u32 rtiVideo u8 p1 u8 p2 u8 flags u8 nmis i16 nmiScan i16 rtiScan
--       RAM[0x800] SRAM[0x2000] [FB[256*240] if flags&2]  (FB bytes = PPU colour index & $3F)
--       u16 nWrites, nWrites x (u8 reg, u8 value, i16 scanline, i16 dot): writes to $2000/$2001/$2005/$2006
--       made by this NMI on a visible scanline (0-239), with Mesen's own raster position
--   'E' u32 len text   (script error)
--   'D' u32 0          (done)
local memRam = emu.memType.nesInternalRam
local memSram = emu.memType.nesSaveRam
local out = assert(io.open(P.fifo, "wb"))

local function unhex(s)
  local t = {}
  for i = 1, #s, 2 do t[#t + 1] = tonumber(s:sub(i, i + 1), 16) end
  return t
end
local P1, P2 = unhex(P.p1), unhex(P.p2)
local SRAM = P.sram and unhex(P.sram) or nil

local function fail(msg)
  msg = tostring(msg)
  pcall(function()
    out:write(string.pack("<c1s4", "E", msg))
    out:flush()
    out:close()
  end)
  emu.stop(2)
end

-- Power-on state forced exactly like the jsnes oracle: RAM filled with P.fill, SRAM = .sav or zeros.
-- The script is loaded at CPU cycle 7 (reset sequence done, first instruction not yet executed).
for i = 0, 0x7FF do emu.write(i, P.fill, memRam) end
for i = 0, 0x1FFF do emu.write(i, SRAM and SRAM[i + 1] or 0, memSram) end

local function readBlock(mt, n)
  local t = {}
  for i = 0, n - 1 do t[i + 1] = emu.read(i, mt) end
  local parts = {}
  for i = 1, n, 4096 do parts[#parts + 1] = string.char(table.unpack(t, i, math.min(i + 4095, n))) end
  return table.concat(parts)
end

local function readFb()
  local buf = emu.getScreenBuffer()
  local n = #buf
  if n ~= 61440 then error("screen buffer has " .. n .. " pixels (overscan must be 0)") end
  local t = {}
  -- settings.json maps palette entry p (index | emphasis << 6) to RGB value p
  for i = 1, n do t[i] = buf[i] & 0x3F end
  local parts = {}
  for i = 1, n, 4096 do parts[#parts + 1] = string.char(table.unpack(t, i, math.min(i + 4095, n))) end
  return table.concat(parts)
end

local writes = {}
local function ppuWrite(addr, value)
  local st = emu.getState()
  local sl = st["ppu.scanline"]
  if sl and sl >= 0 and sl < 240 and #writes < 64 then
    writes[#writes + 1] = string.pack("<BBi2i2", addr & 7, value & 0xFF, sl, st["ppu.cycle"] or -1)
  end
end
for _, a in ipairs({ 0x2000, 0x2001, 0x2005, 0x2006 }) do
  emu.addMemoryCallback(ppuWrite, emu.callbackType.write, a, a)
end

local function scanline()
  local s = emu.getState()
  return s["ppu.scanline"] or -99
end

local NAMES = { "a", "b", "select", "start", "up", "down", "left", "right" }
local function padTable(mask)
  local t = {}
  for i = 1, 8 do t[NAMES[i]] = (mask & (0x80 >> (i - 1))) ~= 0 end
  return t
end

local cur1, cur2 = 0, 0
-- Mesen2 2.1.1's LuaApi::SetInput reads its integer arguments from the end: emu.setInput(t, 1) sets
-- port 0 (subport 1 of nothing), emu.setInput(t, 0, 1) sets port 1 (checked with emu.getInput).
local function applyPad()
  emu.setInput(padTable(cur1), 0)
  emu.setInput(padTable(cur2), 0, 1)
end

local videoFrames = 0
local polls = 0
local nmiCount = 0
local completed = 0
local nmisSinceRti = 0
local nmiVideo, nmiScan = 0, 0
local pending = nil
local done = false

local function wantsFb(f)
  return P.fbsel == "all" or (P.fbsel ~= "none" and P.fbsel:sub(f + 1, f + 1) == "1")
end

local function flush(fb)
  if not pending then return end
  local r = pending
  pending = nil
  local flags = fb and 2 or 0
  out:write(string.pack("<c1I4I4I4BBBBi2i2", "F", r.frame, r.nmiVideo, r.rtiVideo, r.p1, r.p2, flags,
    math.min(r.nmis, 255), r.nmiScan, r.rtiScan))
  out:write(r.ram)
  out:write(r.sram)
  if fb then out:write(fb) end
  out:write(string.pack("<I2", #r.writes))
  out:write(table.concat(r.writes))
end

local function finish()
  if done then return end
  done = true
  flush(nil)
  out:write(string.pack("<c1I4", "D", 0))
  out:flush()
  out:close()
  emu.stop(0)
end

local function snapshot(frame, p1, p2, rtiScan)
  flush(nil)
  pending = {
    frame = frame, nmiVideo = nmiVideo, rtiVideo = videoFrames, p1 = p1, p2 = p2, nmis = nmisSinceRti,
    nmiScan = nmiScan, rtiScan = rtiScan, ram = readBlock(memRam, 0x800), sram = readBlock(memSram, 0x2000),
    writes = writes,
  }
  writes = {}
  if not wantsFb(frame) then flush(nil) end
end

local lastP1, lastP2 = 0, 0

emu.addMemoryCallback(function()
  local ok, err = pcall(function()
    if done then return end
    if nmiCount == 0 then
      nmiVideo, nmiScan = videoFrames, scanline()
      snapshot(0, 0, 0, nmiScan)
      if P.frames == 0 and not pending then finish() return end
    end
    nmiCount = nmiCount + 1
    nmisSinceRti = nmisSinceRti + 1
    if P.timing == "nmi" then
      cur1 = P1[nmiCount] or 0
      cur2 = P2[nmiCount] or 0
      applyPad()
    end
    nmiVideo, nmiScan = videoFrames, scanline()
    lastP1, lastP2 = cur1, cur2
  end)
  if not ok then fail(err) end
end, emu.callbackType.exec, P.nmi, P.nmi)

emu.addMemoryCallback(function()
  local ok, err = pcall(function()
    if done or nmiCount == 0 then return end
    completed = completed + 1
    if completed <= P.frames then
      snapshot(completed, lastP1, lastP2, scanline())
      nmisSinceRti = 0
    end
    if completed >= P.frames and not pending then finish() end
  end)
  if not ok then fail(err) end
end, emu.callbackType.exec, P.rti, P.rti)

emu.addEventCallback(function()
  local ok, err = pcall(function()
    if done then return end
    videoFrames = videoFrames + 1
    if pending then
      flush(readFb())
      if completed >= P.frames then finish() end
    end
    if videoFrames > P.maxVideo then
      error("no progress after " .. videoFrames .. " video frames (" .. completed .. "/" .. P.frames .. " frames)")
    end
  end)
  if not ok then fail(err) end
end, emu.eventType.endFrame)

emu.addEventCallback(function()
  local ok, err = pcall(function()
    if P.timing == "video" then
      cur1 = P1[polls + 1] or 0
      cur2 = P2[polls + 1] or 0
    end
    polls = polls + 1
    applyPad()
  end)
  if not ok then fail(err) end
end, emu.eventType.inputPolled)


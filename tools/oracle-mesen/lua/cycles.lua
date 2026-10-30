-- Cycle-level event trace for tools/oracle-mesen/cycle-diff.mjs. Parameters are prepended as
-- `local P = {...}` (out, nmi, rti, p1, p2, sram, frames, f0, f1). One text line per event, for the NMIs
-- f0..f1 (and up to the RTI of frame `frames`):
--   <tag> <addr hex> <value hex> <Mesen CPU cycle count> <scanline> <dot> <PPU frame>
--   B = first instruction of the n-th NMI handler (addr = n), R = RTI of frame n (opcode fetch),
--   w = write to $2000-$2007 / $4000-$4017, r = read of $2002, D = DMC DMA read of a sample byte.
-- DMA halt/dummy cycles repeat the CPU's pending read: they show up as extra `r` lines one cycle apart
-- (the comparison drops them). The cycle count is Mesen's CycleCount (= the port's cycle + 1).
local out = assert(io.open(P.out, "w"))
local function unhex(s) local t = {} for i = 1, #s, 2 do t[#t + 1] = tonumber(s:sub(i, i + 1), 16) end return t end
local P1, P2 = unhex(P.p1), unhex(P.p2)
local SRAM = P.sram and unhex(P.sram) or nil
for i = 0, 0x7FF do emu.write(i, 0, emu.memType.nesInternalRam) end
for i = 0, 0x1FFF do emu.write(i, SRAM and SRAM[i + 1] or 0, emu.memType.nesSaveRam) end
local NAMES = { "a", "b", "select", "start", "up", "down", "left", "right" }
local function padTable(mask) local t = {} for i = 1, 8 do t[NAMES[i]] = (mask & (0x80 >> (i - 1))) ~= 0 end return t end
local cur1, cur2 = 0, 0
local function applyPad()
  emu.setInput(padTable(cur1), 0)
  emu.setInput(padTable(cur2), 0, 1) -- port 1 (see trace.lua)
end
local nmiCount, rtis = 0, 0
local active = P.f0 <= 1
local function ev(tag, a, v)
  if not active then return end
  local s = emu.getState()
  out:write(string.format("%s %x %x %d %d %d %d\n", tag, a, v, s["cpu.cycleCount"], s["ppu.scanline"], s["ppu.cycle"], s["ppu.frameCount"]))
end
emu.addMemoryCallback(function(a, v) if a ~= 0x2004 then ev("w", a, v) end end, emu.callbackType.write, 0x2000, 0x2007)
emu.addMemoryCallback(function(a, v) ev("w", a, v) end, emu.callbackType.write, 0x4000, 0x4017)
emu.addMemoryCallback(function(a, v) ev("r", a, v) end, emu.callbackType.read, 0x2002, 0x2002)
emu.addMemoryCallback(function()
  nmiCount = nmiCount + 1
  cur1, cur2 = P1[nmiCount] or 0, P2[nmiCount] or 0
  applyPad()
  active = nmiCount >= P.f0 and nmiCount <= P.f1
  ev("B", nmiCount, 0)
end, emu.callbackType.exec, P.nmi, P.nmi)
emu.addMemoryCallback(function()
  if nmiCount == 0 then return end
  rtis = rtis + 1
  ev("R", rtis, 0)
  if rtis >= P.frames then out:close() emu.stop(0) end
end, emu.callbackType.exec, P.rti, P.rti)
emu.addEventCallback(applyPad, emu.eventType.inputPolled)
-- DMC fetches: a read of the sample range at the DMC's current address while bytes remain
local sampleAddr, expect, expect2 = 0xC000, -1, -1
emu.addMemoryCallback(function(a, v) sampleAddr = 0xC000 | (v << 6) end, emu.callbackType.write, 0x4012, 0x4012)
emu.addMemoryCallback(function(a, v) if (v & 0x10) ~= 0 then expect2 = sampleAddr end end, emu.callbackType.write, 0x4015, 0x4015)
emu.addMemoryCallback(function(a, v)
  if a ~= expect and a ~= expect2 then return end
  local st = emu.getState()
  if st["apu.dmc.currentAddr"] ~= a or st["apu.dmc.bytesRemaining"] == 0 then return end
  ev("D", a, v)
  expect = a + 1
  if a == expect2 then expect2 = -1 end
end, emu.callbackType.read, 0xC000, 0xFFFF)

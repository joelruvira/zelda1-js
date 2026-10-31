package io.github.joelruvira.zelda1js

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * Files kept in the app's private internal storage (removed only with the app or its data):
 *   rom/zelda.nes      the player's ROM, validated by the page (android/web/romcheck.js)
 *   rom/candidate.nes  the file just picked, waiting for validation
 *   save/sram.bin      the battery SRAM ($6000-$7FFF, the three saved games), written atomically
 */
class AppStorage(context: Context) {
    private val romDir = File(context.filesDir, "rom")
    private val saveDir = File(context.filesDir, "save")
    private val testDir = File(context.filesDir, "selftest")

    val romFile = File(romDir, "zelda.nes")
    val candidateFile = File(romDir, "candidate.nes")
    private val sram = AtomicFile(File(saveDir, "sram.bin"))

    fun hasRom(): Boolean = romFile.isFile && romFile.length() > 0

    /**
     * Copies a picked document to rom/candidate.nes.
     * @return "ok", "too-big" or "error"
     */
    fun storeCandidate(input: InputStream): String {
        romDir.mkdirs()
        val buffer = ByteArray(MAX_ROM_BYTES + 1)
        var size = 0
        input.use {
            while (size < buffer.size) {
                val n = it.read(buffer, size, buffer.size - size)
                if (n < 0) break
                size += n
            }
        }
        if (size > MAX_ROM_BYTES) return "too-big"
        if (size == 0) return "error"
        candidateFile.outputStream().use { it.write(buffer, 0, size); it.fd.sync() }
        return "ok"
    }

    /** The validated candidate becomes the ROM (rename in the same directory: atomic). */
    fun commitCandidate(): Boolean = candidateFile.isFile && candidateFile.renameTo(romFile)

    fun discardCandidate() {
        candidateFile.delete()
    }

    fun readSram(): ByteArray? = try {
        sram.readFully().takeIf { it.size == SRAM_BYTES }
    } catch (e: IOException) {
        null
    }

    fun writeSram(bytes: ByteArray): Boolean {
        if (bytes.size != SRAM_BYTES) return false
        saveDir.mkdirs()
        val out = try { sram.startWrite() } catch (e: IOException) { return false }
        return try {
            out.write(bytes)
            sram.finishWrite(out) // flush + fsync + rename
            true
        } catch (e: IOException) {
            sram.failWrite(out)
            false
        }
    }

    /** Debug builds: results of the in-app self test (scripts/android/device-test.mjs reads them). */
    fun writeTestResult(name: String, json: String) {
        testDir.mkdirs()
        val safe = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
        File(testDir, "$safe.json").writeText(json)
    }

    companion object {
        const val MAX_ROM_BYTES = 1 shl 20
        const val SRAM_BYTES = 0x2000
    }
}

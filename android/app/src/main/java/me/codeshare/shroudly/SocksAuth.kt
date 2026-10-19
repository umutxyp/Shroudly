package me.codeshare.shroudly

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.io.FileDescriptor
import java.security.SecureRandom

/*
 * The engine's SOCKS5 port is on 127.0.0.1, where any app on the device can
 * reach it. A user name and password made fresh for each protection session
 * keep other apps from using it as a relay. The engine reads them from a file
 * ("--auth-file", one line "user:pass") in this app's private files, never
 * from its command line; hev, the encrypted DNS and the update check send them.
 *
 * Engines built before --auth-file existed ignore unknown options, so the
 * option is given only to an engine that knows it (supports()); with an older
 * one everything works as before, without a password.
 */
class SocksAuth(val user: String, val pass: String) {
    companion object {
        const val OPTION = "--auth-file"
        private val TOKEN = Regex("^[0-9a-f]{8,64}$")

        fun isToken(s: String) = TOKEN.matches(s)

        fun random(rng: SecureRandom = SecureRandom()): SocksAuth {
            fun hex(n: Int) = ByteArray(n).also { rng.nextBytes(it) }.joinToString("") { "%02x".format(it) }
            return SocksAuth(hex(8), hex(16))
        }

        /* Whether an engine binary takes OPTION: its name is in the binary as
         * the string the argument parser compares with. */
        fun supports(binary: File): Boolean = try {
            contains(binary.readBytes(), OPTION.toByteArray(Charsets.US_ASCII) + 0)
        } catch (_: Exception) {
            false
        }

        fun contains(hay: ByteArray, needle: ByteArray): Boolean {
            if (needle.isEmpty()) return true
            outer@ for (i in 0..hay.size - needle.size) {
                for (j in needle.indices) if (hay[i + j] != needle[j]) continue@outer
                return true
            }
            return false
        }
    }

    init {
        require(isToken(user) && isToken(pass)) { "bad credential" }
    }

    fun line() = "$user:$pass\n"

    /* Writes the file readable by this app alone (0600 from the start, not
     * chmod after the fact). */
    fun writeTo(f: File) {
        f.delete()
        val fd: FileDescriptor = Os.open(f.path, OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY, 384 /* 0600 */)
        FileOutputStream(fd).use { it.write(line().toByteArray(Charsets.US_ASCII)) }
    }
}

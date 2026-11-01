package me.codeshare.shroudly

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/*
 * Shadowsocks (AEAD, SIP004), the client end, for "Your own server": the
 * Android side of electron/shadowsocks.js, the same bytes on the wire (both
 * are checked against fixed vectors, tests/net/fixtures/ss-vectors.json;
 * the desktop's also against shadowsocks-libev).
 *
 * A random salt as long as the key, then chunks of [length (2 bytes, at most
 * 0x3FFF) + tag][payload + tag], sealed with the subkey HKDF-SHA1(master
 * key, salt, "ss-subkey") and a nonce counting up from zero (12 bytes,
 * little-endian). The master key comes from the password as OpenSSL's
 * EVP_BytesToKey (MD5). The client's first bytes are the target, as in SOCKS5.
 */
object Shadowsocks {
    class Method(val keyLen: Int, val chacha: Boolean)

    val METHODS = linkedMapOf(
        "chacha20-ietf-poly1305" to Method(32, true),
        "aes-256-gcm" to Method(32, false),
        "aes-128-gcm" to Method(16, false),
    )
    const val TAG = 16
    const val MAX_CHUNK = 0x3fff

    /* The tests: ChaCha20-Poly1305 of our own even where the system has one. */
    @Volatile var ownChaCha = false

    /* ChaCha20-Poly1305 by its name on Android (Conscrypt, 9 and later) or
     * on a JVM (the tests); null on Android 8, where ChaCha20Poly1305.kt
     * stands in. */
    private fun cipher(m: Method): Cipher? =
        if (!m.chacha) Cipher.getInstance("AES/GCM/NoPadding")
        else if (ownChaCha) null
        else listOf("ChaCha20/Poly1305/NoPadding", "ChaCha20-Poly1305").firstNotNullOfOrNull {
            try { Cipher.getInstance(it) } catch (_: GeneralSecurityException) { null }
        }

    fun masterKey(password: String, len: Int): ByteArray {
        val out = ByteArrayOutputStream()
        var prev = ByteArray(0)
        val pw = password.toByteArray(Charsets.UTF_8)
        while (out.size() < len) {
            prev = MessageDigest.getInstance("MD5").digest(prev + pw)
            out.write(prev)
        }
        return out.toByteArray().copyOf(len)
    }

    fun hkdfSha1(key: ByteArray, salt: ByteArray, info: ByteArray, len: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA1")
        mac.init(SecretKeySpec(salt, "HmacSHA1"))
        val prk = mac.doFinal(key)
        mac.init(SecretKeySpec(prk, "HmacSHA1"))
        val out = ByteArrayOutputStream()
        var t = ByteArray(0)
        var i = 1
        while (out.size() < len) {
            mac.update(t); mac.update(info); mac.update(i.toByte())
            t = mac.doFinal()
            out.write(t)
            i++
        }
        return out.toByteArray().copyOf(len)
    }

    class Sealer(method: String, key: ByteArray, salt: ByteArray) {
        private val m = METHODS.getValue(method)
        private val c = cipher(m)   // null: ChaCha20Poly1305.kt
        private val raw = hkdfSha1(key, salt, "ss-subkey".toByteArray(), m.keyLen)
        private val k = SecretKeySpec(raw, if (m.chacha) "ChaCha20" else "AES")
        private val nonce = ByteArray(12)

        private fun spec() = if (m.chacha) IvParameterSpec(nonce.copyOf()) else GCMParameterSpec(TAG * 8, nonce.copyOf())

        private fun bump() {
            for (i in nonce.indices) { nonce[i]++; if (nonce[i] != 0.toByte()) break }
        }

        fun seal(plain: ByteArray, off: Int = 0, len: Int = plain.size): ByteArray {
            val out = if (c == null) ChaCha20Poly1305.seal(raw, nonce.copyOf(), plain, off, len)
            else { c.init(Cipher.ENCRYPT_MODE, k, spec()); c.doFinal(plain, off, len) }
            bump()
            return out
        }

        /* null when it does not authenticate. */
        fun open(sealed: ByteArray, off: Int, len: Int): ByteArray? = if (c == null) {
            ChaCha20Poly1305.open(raw, nonce.copyOf(), sealed, off, len)?.also { bump() }
        } else try {
            c.init(Cipher.DECRYPT_MODE, k, spec())
            c.doFinal(sealed, off, len).also { bump() }
        } catch (_: GeneralSecurityException) {
            null
        }
    }

    /* What one side sends: a salt first, then sealed chunks. `salt` only for
     * the tests' fixed vectors. */
    class Encoder(method: String, key: ByteArray, private val salt: ByteArray = ByteArray(METHODS.getValue(method).keyLen).also { SecureRandom().nextBytes(it) }) {
        private val s = Sealer(method, key, salt)
        private var started = false

        fun encode(data: ByteArray, off: Int = 0, len: Int = data.size): ByteArray {
            val out = ByteArrayOutputStream(len + 64)
            if (!started) { out.write(salt); started = true }
            var i = off
            while (i < off + len) {
                val n = minOf(MAX_CHUNK, off + len - i)
                out.write(s.seal(byteArrayOf((n shr 8).toByte(), n.toByte())))
                out.write(s.seal(data, i, n))
                i += n
            }
            return out.toByteArray()
        }
    }

    /* What the other side reads back; `bad` once something did not
     * authenticate (the rest of the stream is then meaningless). */
    class Decoder(private val method: String, private val key: ByteArray) {
        private var buf = ByteArray(0)
        private var s: Sealer? = null
        private var want = 0
        var bad = false
            private set

        fun push(data: ByteArray, off: Int = 0, len: Int = data.size): ByteArray {
            if (bad) return ByteArray(0)
            buf += data.copyOfRange(off, off + len)
            val out = ByteArrayOutputStream()
            val saltLen = METHODS.getValue(method).keyLen
            var at = 0
            if (s == null) {
                if (buf.size < saltLen) return ByteArray(0)
                s = Sealer(method, key, buf.copyOf(saltLen))
                at = saltLen
            }
            val sealer = s!!
            while (true) {
                if (want == 0) {
                    if (buf.size - at < 2 + TAG) break
                    val l = sealer.open(buf, at, 2 + TAG)
                    if (l == null) { bad = true; break }
                    want = ((l[0].toInt() and 0xff) shl 8 or (l[1].toInt() and 0xff)) and MAX_CHUNK
                    at += 2 + TAG
                    if (want == 0) { bad = true; break }
                }
                if (buf.size - at < want + TAG) break
                val plain = sealer.open(buf, at, want + TAG)
                if (plain == null) { bad = true; break }
                out.write(plain)
                at += want + TAG
                want = 0
            }
            buf = buf.copyOfRange(at, buf.size)
            return out.toByteArray()
        }
    }

    /* The target in SOCKS5 form: type, address, port; null if it cannot be one. */
    fun encodeTarget(host: String, port: Int): ByteArray {
        val p = byteArrayOf((port shr 8).toByte(), port.toByte())
        val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(host)
        if (v4 != null) return byteArrayOf(1) + v4.groupValues.drop(1).map { it.toInt().toByte() }.toByteArray() + p
        if (host.contains(':')) return byteArrayOf(4) + InetAddress.getByName(host).address + p
        val name = host.toByteArray(Charsets.UTF_8)
        require(name.size in 1..255) { "name too long" }
        return byteArrayOf(3, name.size.toByte()) + name + p
    }

    /*
     * The client: a SOCKS5 server on 127.0.0.1 that sends every connection
     * through the Shadowsocks server. The engine is pointed at it as its own
     * server (--upstream-file) with `user` and `pass`, made fresh for each
     * client: any app on the device can reach 127.0.0.1, and none other may
     * use the user's server through it. Without them (the test in Settings),
     * none is asked. This app is left out of its own VPN, so the connections
     * to the server go straight out.
     */
    class Client(
        private val server: String,
        private val serverPort: Int,
        private val method: String,
        password: String,
        private val user: String = "",
        private val pass: String = "",
        private val onError: (IOException, Boolean) -> Unit = { _, _ -> },
    ) {
        private val key = masterKey(password, METHODS.getValue(method).keyLen)
        private val listen = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
        private val closed = AtomicBoolean(false)
        val port: Int get() = listen.localPort

        init {
            Thread({
                while (!closed.get()) {
                    val c = try { listen.accept() } catch (_: IOException) { break }
                    Thread({ serve(c) }, "ss-conn").apply { isDaemon = true }.start()
                }
            }, "ss-client").apply { isDaemon = true }.start()
        }

        fun close() {
            closed.set(true)
            try { listen.close() } catch (_: IOException) {}
        }

        private fun readN(i: InputStream, n: Int): ByteArray {
            val b = ByteArray(n)
            var got = 0
            while (got < n) {
                val r = i.read(b, got, n - got)
                if (r < 0) throw IOException("closed")
                got += r
            }
            return b
        }

        private fun serve(c: Socket) {
            var up: Socket? = null
            try {
                c.tcpNoDelay = true
                c.soTimeout = 30_000
                val ci = c.getInputStream()
                val co = c.getOutputStream()
                val hello = readN(ci, 2)
                val offered = readN(ci, hello[1].toInt() and 0xff).map { it.toInt() and 0xff }
                if (hello[0].toInt() != 5) return
                if (user.isEmpty()) {
                    co.write(byteArrayOf(5, 0))
                } else {
                    if (2 !in offered) { co.write(byteArrayOf(5, 0xff.toByte())); return }
                    co.write(byteArrayOf(5, 2))
                    readN(ci, 1)
                    val u = String(readN(ci, readN(ci, 1)[0].toInt() and 0xff))
                    val p = String(readN(ci, readN(ci, 1)[0].toInt() and 0xff))
                    if (u != user || p != pass) { co.write(byteArrayOf(1, 1)); return }
                    co.write(byteArrayOf(1, 0))
                }
                val req = readN(ci, 4)
                if (req[1].toInt() != 1) { co.write(byteArrayOf(5, 7, 0, 1, 0, 0, 0, 0, 0, 0)); return }
                val target = when (req[3].toInt()) {
                    1 -> byteArrayOf(1) + readN(ci, 6)
                    4 -> byteArrayOf(4) + readN(ci, 18)
                    3 -> { val n = readN(ci, 1); byteArrayOf(3) + n + readN(ci, (n[0].toInt() and 0xff) + 2) }
                    else -> { co.write(byteArrayOf(5, 8, 0, 1, 0, 0, 0, 0, 0, 0)); return }
                }
                val s = Socket()
                up = s
                try {
                    s.connect(InetSocketAddress(server, serverPort), 10_000)
                } catch (e: IOException) {
                    onError(e, false)
                    co.write(byteArrayOf(5, 5, 0, 1, 0, 0, 0, 0, 0, 0))
                    return
                }
                s.tcpNoDelay = true
                c.soTimeout = 0
                val enc = Encoder(method, key)
                val dec = Decoder(method, key)
                val so = s.getOutputStream()
                so.write(enc.encode(target))
                co.write(byteArrayOf(5, 0, 0, 1, 0, 0, 0, 0, 0, 0))
                co.flush()
                val back = Thread({ pumpBack(s.getInputStream(), co, dec, c, s) }, "ss-back").apply { isDaemon = true }
                back.start()
                pumpOut(ci, so, enc)
                try { s.shutdownOutput() } catch (_: IOException) {}
                back.join()
            } catch (_: Exception) {
                // An I/O error, or a method this device lacks: the connection ends.
            } finally {
                try { up?.close() } catch (_: IOException) {}
                try { c.close() } catch (_: IOException) {}
            }
        }

        private fun pumpOut(i: InputStream, o: OutputStream, enc: Encoder) {
            val b = ByteArray(16 * 1024)
            try {
                while (true) {
                    val n = i.read(b)
                    if (n < 0) break
                    o.write(enc.encode(b, 0, n))
                }
            } catch (_: IOException) {}
        }

        private fun pumpBack(i: InputStream, o: OutputStream, dec: Decoder, c: Socket, s: Socket) {
            val b = ByteArray(32 * 1024)
            try {
                while (true) {
                    val n = i.read(b)
                    if (n < 0) break
                    val plain = dec.push(b, 0, n)
                    if (dec.bad) {
                        onError(IOException("the server's answer does not authenticate (another password or method)"), true)
                        break
                    }
                    if (plain.isNotEmpty()) o.write(plain)
                }
            } catch (_: IOException) {
            } finally {
                try { c.shutdownOutput() } catch (_: IOException) {}
                try { s.close() } catch (_: IOException) {}
            }
        }
    }
}

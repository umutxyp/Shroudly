package me.codeshare.shroudly

import java.math.BigInteger
import java.security.MessageDigest

/*
 * ChaCha20-Poly1305 (RFC 8439), for Shadowsocks's chacha20-ietf-poly1305 on
 * Android 8, whose crypto has no such cipher (Android 9 and later have it,
 * and Shadowsocks.kt uses theirs). The Android side of
 * electron/chacha20poly1305.js; the tests check it against the JVM's own
 * and against the RFC's vectors.
 */
object ChaCha20Poly1305 {
    private fun rotl(v: Int, n: Int) = (v shl n) or (v ushr (32 - n))

    private fun le32(b: ByteArray, off: Int) =
        (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8) or ((b[off + 2].toInt() and 0xff) shl 16) or ((b[off + 3].toInt() and 0xff) shl 24)

    /* One 64-byte block of key stream into out. */
    private fun block(key: ByteArray, counter: Int, nonce: ByteArray, out: ByteArray) {
        val s = IntArray(16)
        s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574
        for (i in 0 until 8) s[4 + i] = le32(key, i * 4)
        s[12] = counter
        for (i in 0 until 3) s[13 + i] = le32(nonce, i * 4)
        val x = s.copyOf()
        fun qr(a: Int, b: Int, c: Int, d: Int) {
            x[a] += x[b]; x[d] = rotl(x[d] xor x[a], 16)
            x[c] += x[d]; x[b] = rotl(x[b] xor x[c], 12)
            x[a] += x[b]; x[d] = rotl(x[d] xor x[a], 8)
            x[c] += x[d]; x[b] = rotl(x[b] xor x[c], 7)
        }
        repeat(10) {
            qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
            qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
        }
        for (i in 0 until 16) {
            val v = x[i] + s[i]
            out[i * 4] = v.toByte(); out[i * 4 + 1] = (v ushr 8).toByte(); out[i * 4 + 2] = (v ushr 16).toByte(); out[i * 4 + 3] = (v ushr 24).toByte()
        }
    }

    fun chacha20(key: ByteArray, nonce: ByteArray, counter: Int, data: ByteArray, off: Int = 0, len: Int = data.size): ByteArray {
        val out = ByteArray(len)
        val ks = ByteArray(64)
        var i = 0
        var c = counter
        while (i < len) {
            block(key, c++, nonce, ks)
            val n = minOf(64, len - i)
            for (j in 0 until n) out[i + j] = (data[off + i + j].toInt() xor ks[j].toInt()).toByte()
            i += n
        }
        return out
    }

    private val P = BigInteger.ONE.shiftLeft(130).subtract(BigInteger.valueOf(5))
    private val CLAMP = BigInteger("0ffffffc0ffffffc0ffffffc0fffffff", 16)

    private fun leBig(b: ByteArray, off: Int, len: Int): BigInteger {
        val be = ByteArray(len + 1)
        for (i in 0 until len) be[len - i] = b[off + i]
        return BigInteger(be)
    }

    fun poly1305(key: ByteArray, msg: ByteArray): ByteArray {
        val r = leBig(key, 0, 16).and(CLAMP)
        val s = leBig(key, 16, 16)
        var h = BigInteger.ZERO
        var i = 0
        while (i < msg.size) {
            val n = minOf(16, msg.size - i)
            h = h.add(leBig(msg, i, n)).add(BigInteger.ONE.shiftLeft(8 * n)).multiply(r).mod(P)
            i += 16
        }
        val t = h.add(s).toByteArray()
        val tag = ByteArray(16)
        for (j in 0 until 16) tag[j] = if (t.size - 1 - j >= 0) t[t.size - 1 - j] else 0
        return tag
    }

    private fun macData(ct: ByteArray): ByteArray {
        val pad = (16 - ct.size % 16) % 16
        val m = ByteArray(ct.size + pad + 16)
        System.arraycopy(ct, 0, m, 0, ct.size)
        var len = ct.size.toLong()
        for (j in 0 until 8) { m[ct.size + pad + 8 + j] = (len and 0xff).toByte(); len = len ushr 8 }
        return m
    }

    /* ciphertext + 16-byte tag (no additional data: Shadowsocks has none) */
    fun seal(key: ByteArray, nonce: ByteArray, plain: ByteArray, off: Int = 0, len: Int = plain.size): ByteArray {
        val otk = chacha20(key, nonce, 0, ByteArray(32))
        val ct = chacha20(key, nonce, 1, plain, off, len)
        return ct + poly1305(otk, macData(ct))
    }

    /* the plaintext, or null when the tag does not match */
    fun open(key: ByteArray, nonce: ByteArray, sealed: ByteArray, off: Int, len: Int): ByteArray? {
        if (len < 16) return null
        val ct = sealed.copyOfRange(off, off + len - 16)
        val otk = chacha20(key, nonce, 0, ByteArray(32))
        val want = poly1305(otk, macData(ct))
        if (!MessageDigest.isEqual(want, sealed.copyOfRange(off + len - 16, off + len))) return null
        return chacha20(key, nonce, 1, ct)
    }
}

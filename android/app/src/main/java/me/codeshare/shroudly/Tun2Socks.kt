package me.codeshare.shroudly

/*
 * hev-socks5-tunnel's JNI interface (src/hev-jni.c). The library registers its
 * natives on this class by name: it is built with PKGNAME/CLSNAME set to
 * me/codeshare/shroudly/Tun2Socks (app/build.gradle.kts), and R8 keeps the
 * name (proguard-rules.pro).
 */
@Suppress("FunctionName")
object Tun2Socks {
    init {
        System.loadLibrary("hev-socks5-tunnel")
    }

    /* Starts the tunnel on its own thread with the config file and the VPN interface's fd. */
    @JvmStatic external fun TProxyStartService(configPath: String, fd: Int): Boolean

    /* Stops it and waits for its thread. The fd stays open; the caller closes it. */
    @JvmStatic external fun TProxyStopService(): Boolean

    @JvmStatic external fun TProxyIsRunning(): Boolean

    /* tx packets, tx bytes, rx packets, rx bytes. */
    @JvmStatic external fun TProxyGetStats(): LongArray?
}

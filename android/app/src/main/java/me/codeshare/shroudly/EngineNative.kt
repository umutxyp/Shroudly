package me.codeshare.shroudly

/*
 * The engine inside this app's process: libshroudlycore_jni.so, built from
 * core/src by the Gradle build (src/main/cpp). See Engine.kt for how a run
 * is driven, and src/main/cpp/engine_jni.c for why it is not a program of its
 * own any more.
 */
object EngineNative {
    const val LIBRARY = "shroudlycore_jni"

    /* Codes run() returns that come from the JNI side, not from the engine. */
    const val BUSY = -100
    const val NO_MEMORY = -101

    /* Why the library cannot be used, or null once it is loaded. */
    val loadError: String? by lazy {
        try {
            System.loadLibrary(LIBRARY)
            null
        } catch (e: Throwable) {
            e.toString()
        }
    }

    /* The engine's whole run, on the calling thread, as the shroudly-core
     * program would make it with these arguments: commands are read from
     * commandFd, JSON lines written to eventFd. Both descriptors belong to
     * the native side from the call on, and are closed when it returns,
     * which is when the engine has stopped (STOP, or commandFd closed). The
     * result is the program's exit code, or BUSY when another run has not
     * returned yet. */
    @JvmStatic external fun run(args: Array<String>, commandFd: Int, eventFd: Int): Int
}

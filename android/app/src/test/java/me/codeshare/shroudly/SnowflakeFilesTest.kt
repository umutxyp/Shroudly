package me.codeshare.shroudly

import org.junit.Assert.assertArrayEquals
import org.junit.Test
import java.io.File

/* The Snowflake page the app runs (assets/snowflake/proxy.js) is the
 * desktop's (electron/snowflake/proxy.js), byte for byte. */
class SnowflakeFilesTest {
    @Test
    fun sameAsTheDesktops() {
        val app = File("src/main/assets/snowflake/proxy.js").takeIf { it.isFile } ?: File("app/src/main/assets/snowflake/proxy.js")
        val repo = app.absoluteFile.parentFile.parentFile.parentFile.parentFile.parentFile.parentFile.parentFile
        assertArrayEquals("copy electron/snowflake/proxy.js to android/app/src/main/assets/snowflake/", File(repo, "electron/snowflake/proxy.js").readBytes(), app.readBytes())
    }
}
